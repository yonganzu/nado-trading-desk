"use client";

import { useMemo } from "react";
import { LayerCard, Text } from "@cloudflare/kumo";
import { MAKER_VOLUME_PER_POINT, TAKER_VOLUME_PER_POINT } from "@farm/ui";
import type { AccountingRecord } from "@farm/ui";

/** 积分单价阈值（美元/分）：超过它说明这一分是「买贵了」。 */
const THRESHOLD = 1.2;
/** 滚动判定口径：最近 10 单。 */
const WINDOW = 10;
/** 图上只展示最近这么多笔成交（太大的区间会糊成一团）。 */
const MAX_POINTS = 50;
/** 自成交降温阈值（占比低于它说明有外部成交漏出去了）。 */
const SELF_WARN = 0.9;

const COLOR_OK = "#38bdf8";    // 蓝：积分成本 ≤ 1.2
const COLOR_BAD = "#f43f5e";   // 红：积分成本 > 1.2
const COLOR_SELF = "#22c55e";  // 绿：自成交比例（右轴）
const COLOR_GRID = "#94a3b8";  // 网格 / 参考线

interface Fill {
  /** 这一笔折算出的积分 */
  gained: number;
  /** 这一笔的损耗 = 手续费 − 已实现盈亏 */
  wear: number;
  /** 成交名义额（自成交比例的分母） */
  notional: number;
  /** 账本的自成交标记；undefined = 还没判定出来，不进分母 */
  self: boolean | undefined;
}

interface Sample {
  /** 成交序号（按时间升序，用于 x 轴等距铺开） */
  idx: number;
  /** 累计积分成本 = 累计损耗 ÷ 累计积分 */
  cost: number;
  /** 最近 WINDOW 单的积分成本（不足 10 单时用全部） */
  rolling: number;
  /** 最近 WINDOW 单里自成交名义额的占比（0~1）；窗口内没有可判定的成交时为 undefined */
  selfRatio: number | undefined;
}

/** 最近 WINDOW 单的自成交名义额占比；未标记的成交不进分母，避免把历史未判定数据算成「外部成交」。 */
function rollingSelfRatio(fills: readonly Fill[], end: number): number | undefined {
  let self = 0;
  let total = 0;
  for (let i = Math.max(0, end - WINDOW + 1); i <= end; i++) {
    const f = fills[i]!;
    if (f.self === undefined) continue;
    total += f.notional;
    if (f.self) self += f.notional;
  }
  return total > 0 ? self / total : undefined;
}

/**
 * 把成交记录折算成两条序列（只取最近 MAX_POINTS 笔）：
 *   • 积分成本：单笔积分 = 名义额 ÷（吃单 2500 / 挂单 16000）；单笔损耗 = 手续费 − 已实现盈亏。
 *   • 自成交比例：最近 WINDOW 单里 selfCross 成交的名义额占比。
 * 无法判定 maker/taker 的成交折算不出积分，直接跳过；开头还没有积分的点也不画。
 */
function buildSeries(records: readonly AccountingRecord[]): Sample[] {
  // 先收集所有可折算的成交，再截取最近 MAX_POINTS 笔，累计起点就落在窗口第一笔上
  const fills: Fill[] = [];
  for (const r of [...records].sort((a, b) => a.ts - b.ts)) {
    if (r.taker === undefined) continue;
    const gained = r.notional / (r.taker ? TAKER_VOLUME_PER_POINT : MAKER_VOLUME_PER_POINT);
    if (!(gained > 0)) continue;
    fills.push({ gained, wear: r.fee - (r.realizedPnl ?? 0), notional: r.notional, self: r.selfCross });
  }
  const window = fills.slice(-MAX_POINTS);

  const cumPoints: number[] = [];
  const cumWear: number[] = [];
  const out: Sample[] = [];
  let pts = 0;
  let wear = 0;
  for (let i = 0; i < window.length; i++) {
    const f = window[i]!;
    pts += f.gained;
    wear += f.wear;
    if (!(pts > 0)) continue;
    cumPoints.push(pts);
    cumWear.push(wear);
    // 窗口内增量：从「窗口起点前一单」的累计值相减，避免浮点重算
    const n = cumPoints.length;
    const start = Math.max(0, n - WINDOW);
    const baseP = start > 0 ? (cumPoints[start - 1] ?? 0) : 0;
    const baseW = start > 0 ? (cumWear[start - 1] ?? 0) : 0;
    const wP = pts - baseP;
    const wW = wear - baseW;
    out.push({
      idx: out.length,
      cost: wear / pts,
      rolling: wP > 0 ? wW / wP : 0,
      selfRatio: rollingSelfRatio(window, i),
    });
  }
  return out;
}

/**
 * 双轴折线图：
 *   • 左轴（蓝/红）= 累计积分成本（美元/分），线色按「最近 10 单」是否超过 1.2 决定；
 *   • 右轴（绿）  = 最近 10 单的自成交名义额占比（0~100%），掉到 90% 以下说明有外部成交漏入。
 */
export function PointCostChart({ records }: { records: readonly AccountingRecord[] }) {
  const series = useMemo(() => buildSeries(records), [records]);

  const W = 1000;
  const H = 220;
  const PAD = { left: 46, right: 52, top: 14, bottom: 22 };

  if (series.length < 2) {
    return (
      <LayerCard className="p-4">
        <span className="text-sm text-kumo-subtle">
          {series.length === 0 ? "暂无可折算积分的成交（需要 maker/taker 标记）" : "成交笔数太少，至少 2 笔才能画折线"}
        </span>
      </LayerCard>
    );
  }

  // 左轴范围把阈值 1.2 一起纳入，这样参考线永远在图内
  const lo = Math.min(THRESHOLD, ...series.map((s) => s.cost));
  const hi = Math.max(THRESHOLD, ...series.map((s) => s.cost));
  const pad = (hi - lo || 1) * 0.08;
  const yLo = lo - pad;
  const yHi = hi + pad;
  const xOf = (i: number): number =>
    PAD.left + (i / (series.length - 1)) * (W - PAD.left - PAD.right);
  const yOf = (v: number): number =>
    PAD.top + (1 - (v - yLo) / (yHi - yLo)) * (H - PAD.top - PAD.bottom);
  // 右轴固定 0~100%，横向对比不受其它数据影响
  const yOfSelf = (v: number): number =>
    PAD.top + (1 - v) * (H - PAD.top - PAD.bottom);

  const last = series[series.length - 1]!;
  const bad = last.rolling > THRESHOLD;
  const lastSelf = [...series].reverse().find((s) => s.selfRatio !== undefined)?.selfRatio;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-kumo-subtle">积分成本 · 自成交比例</span>
        <span className="text-xs text-kumo-subtle">
          累计口径 · 最近 {WINDOW} 单
          <span className="ml-1 tabular-nums" style={{ color: bad ? COLOR_BAD : COLOR_OK }}>
            {last.rolling.toFixed(3)} 美元/分
          </span>
        </span>
        {lastSelf !== undefined && (
          <span className="text-xs text-kumo-subtle">
            自成交
            <span className="ml-1 tabular-nums" style={{ color: lastSelf >= SELF_WARN ? COLOR_SELF : COLOR_BAD }}>
              {(lastSelf * 100).toFixed(0)}%
            </span>
          </span>
        )}
        <span className="text-xs text-kumo-subtle">
          <span style={{ color: COLOR_OK }}>■</span> 成本 ≤ {THRESHOLD}　
          <span style={{ color: COLOR_BAD }}>■</span> 成本 &gt; {THRESHOLD}　
          <span style={{ color: COLOR_SELF }}>■</span> 自成交占比（右轴）
        </span>
      </div>
      <LayerCard className="p-2">
        <div className="w-full" style={{ aspectRatio: `${W} / ${H}` }}>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
            {/* 左轴：成本阈值参考线（虚线） */}
            <line
              x1={PAD.left} x2={W - PAD.right}
              y1={yOf(THRESHOLD)} y2={yOf(THRESHOLD)}
              stroke={COLOR_GRID} strokeDasharray="6 5" strokeWidth={1}
            />
            <text x={PAD.left + 4} y={yOf(THRESHOLD) - 5} fontSize={11} fill={COLOR_GRID}>
              {THRESHOLD}
            </text>
            {/* 右轴：自成交占比 90% 的警戒线（虚线） */}
            <line
              x1={PAD.left} x2={W - PAD.right}
              y1={yOfSelf(SELF_WARN)} y2={yOfSelf(SELF_WARN)}
              stroke={COLOR_SELF} strokeDasharray="2 6" strokeWidth={1} opacity={0.7}
            />
            {/* 左轴上下界 */}
            <text x={4} y={yOf(yHi) + 10} fontSize={11} fill={COLOR_GRID}>{yHi.toFixed(2)}</text>
            <text x={4} y={yOf(yLo)} fontSize={11} fill={COLOR_GRID}>{yLo.toFixed(2)}</text>
            {/* 右轴刻度 100% / 50% / 0% */}
            <text x={W - PAD.right + 4} y={yOfSelf(1) + 10} fontSize={11} fill={COLOR_SELF}>100%</text>
            <text x={W - PAD.right + 4} y={yOfSelf(0.5) + 4} fontSize={11} fill={COLOR_SELF}>50%</text>
            <text x={W - PAD.right + 4} y={yOfSelf(0)} fontSize={11} fill={COLOR_SELF}>0%</text>
            {/* 成本折线：按「最近 10 单」口径逐段着色 */}
            {series.slice(1).map((s, i) => {
              const prev = series[i]!;
              const color = s.rolling > THRESHOLD ? COLOR_BAD : COLOR_OK;
              return (
                <line
                  key={`c${s.idx}`}
                  x1={xOf(prev.idx)} y1={yOf(prev.cost)}
                  x2={xOf(s.idx)} y2={yOf(s.cost)}
                  stroke={color} strokeWidth={1.6} strokeLinecap="round"
                />
              );
            })}
            {/* 自成交比例折线（右轴）：断点处不连线，避免把「无数据」画成 0% */}
            {series.slice(1).map((s, i) => {
              const prev = series[i]!;
              if (s.selfRatio === undefined || prev.selfRatio === undefined) return null;
              return (
                <line
                  key={`s${s.idx}`}
                  x1={xOf(prev.idx)} y1={yOfSelf(prev.selfRatio)}
                  x2={xOf(s.idx)} y2={yOfSelf(s.selfRatio)}
                  stroke={COLOR_SELF} strokeWidth={1.4} strokeLinecap="round" opacity={0.9}
                />
              );
            })}
          </svg>
        </div>
      </LayerCard>
      <Text variant="secondary" size="xs">
        {`仅显示最近 ${series.length} 笔（上限 ${MAX_POINTS} 笔）· 成本为累计口径（窗口首笔起算 ${last.cost.toFixed(3)} 美元/分）· 线色按最近 ${WINDOW} 单判定 · 自成交占比同样是最近 ${WINDOW} 单口径`}
      </Text>
    </div>
  );
}
