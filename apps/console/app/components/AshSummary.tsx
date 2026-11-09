"use client";

// =============================================================================
// ASH 概览：运行状态、权益/盈亏、行情连接、Nado 转发桥。
// 纯展示，数据由页面从 /api/ash/signals 拉取后传入。
// =============================================================================
import { Banner, Grid, LayerCard, Text } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { AshSnapshot } from "../lib/ashTypes";
import { ashBridgeKind, ashNum, ashPnl, ashTime } from "../lib/ashFormat";

/** Kumo 没有 stat 组件，用一个轻量卡片拼。 */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <LayerCard className="flex flex-col gap-1 p-3">
      <Text variant="secondary" size="xs">{label}</Text>
      <span className="font-semibold tabular-nums">{value}</span>
      {hint ? <span className="truncate text-xs text-kumo-subtle" title={hint}>{hint}</span> : null}
    </LayerCard>
  );
}

export function AshSummary({ snapshot }: { snapshot: AshSnapshot | null }) {
  if (!snapshot) {
    return (
      <Grid variant="4up" gap="sm">
        <Stat label="ASH 状态" value="连接中…" />
        <Stat label="账户权益" value="-" />
        <Stat label="行情" value="-" />
        <Stat label="Nado 桥" value="-" />
      </Grid>
    );
  }

  const status = snapshot.status;
  const trading = status?.trading;
  const bridge = status?.bridge;
  const errs = snapshot.errors ?? status?.errors ?? {};
  const errList = Object.entries(errs);

  const paused = trading?.paused === true;
  const pnl = Number(trading?.todayPnlUSDT ?? 0);
  const bridgeLast = bridge?.last;
  const bridgeText = bridge?.enabled ? (bridge.dryRun ? "试运行" : "实盘转发") : "未启用";
  const bridgeHint = bridgeLast?.reason
    ? `${ashTime(bridgeLast.at)} · ${bridgeLast.ok === false ? "失败：" : ""}${bridgeLast.reason}`
    : `${ashBridgeKind("NADO_SIGNAL_SENT")} 转发 ${bridge?.forwarded ?? 0} · 开过仓 ${bridge?.entries ?? 0}`;

  // 权益来源：nado = 后端已同步到执行钱包的真实余额；paper = 读不到余额时的纸面回退
  const account = status?.account;
  const liveEquity = trading?.equitySource === "nado";
  const equityValue = ashNum(trading?.equityUSDT, 2);
  const equityLabel = liveEquity ? "账户权益 · Nado 实盘" : "账户权益 · 纸面";
  const equityHint = liveEquity
    ? `USDT0 ${ashNum(account?.usdt0, 2)} · 纸面口径 ${ashNum(trading?.paperEquityUSDT, 2)}`
    : `今日 ${ashPnl(pnl)} · 持仓 ${trading?.openCount ?? 0} 笔`;

  // 实盘余额低于任一品种的最小名义额时，说明连一手都下不了，直接提示出来
  const minNotionalList = Object.values(status?.specs ?? {})
    .map((s) => Number((s as { minNotional?: number }).minNotional))
    .filter((n) => Number.isFinite(n) && n > 0);
  const minNotional = minNotionalList.length ? Math.min(...minNotionalList) : 0;
  const equity = Number(trading?.equityUSDT ?? 0);
  const testMode = trading?.forceMinQtyTest === true;
  // 测试模式绕过风险预算，余额不够也能下单，所以这条只在正常模式提示
  const tooSmall = !testMode && liveEquity && minNotional > 0 && equity < minNotional;

  return (
    <div className="flex flex-col gap-3">
      <Grid variant="4up" gap="sm">
        <Stat
          label="运行状态"
          value={paused ? "已暂停" : status?.started ? "运行中" : "未启动"}
          hint={`${status?.mode ?? "-"} · 行情 ${status?.feed ?? "-"} · ${status?.interval ?? "-"}`}
        />
        <Stat
          label={equityLabel}
          value={equityValue}
          hint={equityHint}
        />
        <Stat
          label="行情连接"
          value={status?.marketConnected ? "已连接" : "未连接"}
          hint={(status?.symbols ?? []).join(" / ")}
        />
        <Stat
          label="Nado 桥"
          value={bridgeText}
          hint={bridgeHint}
        />
      </Grid>

      {testMode && (
        <Banner
          variant="alert"
          size="sm"
          icon={<WarningCircleIcon weight="fill" />}
          description={`最小下单测试模式已开启：忽略风险预算和保证金上限，每笔都按交易所最小可成交名义额（约 ${ashNum(minNotional, 0)} USDT）下单。验证完请把 config.json 的 risk.forceMinQtyTest 改成 false。`}
        />
      )}
      {paused && (
        <Banner
          variant="default"
          size="sm"
          description="ASH 当前处于暂停状态（常见原因：重启时还有未平仓计划），不会产生新信号。恢复请调用 POST /api/admin/resume。"
        />
      )}
      {tooSmall && (
        <Banner
          variant="error"
          size="sm"
          icon={<WarningCircleIcon weight="fill" />}
          description={`执行钱包在 Nado 的权益 ${ashNum(equity, 2)} USDT，低于最小下单名义额 ${ashNum(minNotional, 2)} USDT。ASH 仍会产生信号，但风控会以「不足交易所最小下单量」拒绝开仓。`}
        />
      )}
      {errList.length > 0 && (
        <Banner
          variant="error"
          size="sm"
          icon={<WarningCircleIcon weight="fill" />}
          description={`部分数据读取失败：${errList.map(([k, v]) => `${k}（${v}）`).join("；")}`}
        />
      )}
    </div>
  );
}
