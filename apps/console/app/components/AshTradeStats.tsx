"use client";

// =============================================================================
// ASH 成交量 / 手续费 / 总亏损：只统计 Nado 明确回执的成交（WebSocket fill 流）。
//   • 总成交量 = Σ(filled_qty × price)，成交名义额（USDT）
//   • 手续费   = Σ(fee)，Nado 回执里的手续费（maker 返佣为负）
//   • 总亏损   = Σ(realized_pnl) − Σ(fee)，平仓盈亏扣掉手续费后的真实盈亏
// 数据来自 /api/status 的 tradeStats（ASH 后端在 fill 推送到达时落库后聚合），
// 不使用 ASH 纸面计划单的量价，因此不会把"发出去的单"当成"成交"。
// =============================================================================
import { Grid, LayerCard, Text } from "@cloudflare/kumo";
import type { AshTradeStats as AshTradeStatsData } from "../lib/ashTypes";
import { ashNum, ashPnl } from "../lib/ashFormat";

/** Kumo 没有 stat 组件，用一个轻量卡片拼；tone 用来给盈亏上色。 */
function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "";
  return (
    <LayerCard className="flex flex-col gap-1 p-3">
      <Text variant="secondary" size="xs">{label}</Text>
      <span className={`font-semibold tabular-nums ${color}`}>{value}</span>
      {hint ? <span className="truncate text-xs text-kumo-subtle" title={hint}>{hint}</span> : null}
    </LayerCard>
  );
}

export function AshTradeStats({ stats }: { stats?: AshTradeStatsData }) {
  const fills = Number(stats?.fills ?? 0);
  const volume = Number(stats?.volume ?? 0);
  const fee = Number(stats?.fee ?? 0);
  const feeBps = Number(stats?.feeBps ?? 0);
  const pnl = Number(stats?.pnl ?? 0);
  const net = Number(stats?.net ?? 0);
  const todayNet = Number(stats?.todayNet ?? 0);
  const makerFills = Number(stats?.makerFills ?? 0);
  const takerFills = Number(stats?.takerFills ?? 0);
  const todayFills = Number(stats?.todayFills ?? 0);
  const todayVolume = Number(stats?.todayVolume ?? 0);
  const todayFee = Number(stats?.todayFee ?? 0);

  return (
    <Grid variant="4up" gap="sm">
      <Stat
        label="总成交量 · Nado"
        value={`${ashNum(volume, 2)} USDT`}
        hint={`今日 ${ashNum(todayVolume, 2)} USDT · 均笔 ${fills > 0 ? ashNum(volume / fills, 2) : "-"} USDT`}
      />
      <Stat
        label="总亏损 · Nado（含手续费）"
        value={`${ashPnl(net)} USDT`}
        tone={net > 0 ? "up" : net < 0 ? "down" : undefined}
        hint={`盈亏 ${ashPnl(pnl)} − 手续费 ${ashNum(fee, 4)} · 今日 ${ashPnl(todayNet)}`}
      />
      <Stat
        label="手续费 · Nado"
        value={`${ashNum(fee, 4)} USDT`}
        hint={`今日 ${ashNum(todayFee, 4)} USDT · 磨损率 ${ashNum(feeBps, 3)} bps`}
      />
      <Stat
        label="成交笔数 · Nado"
        value={ashNum(fills, 0)}
        hint={`今日 ${todayFills} 笔 · 挂单 ${makerFills} / 吃单 ${takerFills}`}
      />
    </Grid>
  );
}
