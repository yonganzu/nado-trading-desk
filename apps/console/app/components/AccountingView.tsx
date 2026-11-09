"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Empty, Grid, LayerCard, LayerDialog, Table, Text } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, DownloadSimpleIcon, ReceiptIcon } from "@phosphor-icons/react";
import { rollup, toCsv, toJson, MAKER_VOLUME_PER_POINT, TAKER_VOLUME_PER_POINT } from "@farm/ui";
import type { Rollup, Totals } from "@farm/ui";
import { accountingLedger } from "../lib/accountingLedger";
import { withoutExcludedWallets } from "../lib/accountingExclusions";
import { PointCostChart } from "./PointCostChart";

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** A KPI tile built from Kumo pieces (Kumo ships no stat primitive): a simple LayerCard with a
 *  secondary caption and a tabular value. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "";
  return (
    <LayerCard className="flex flex-col gap-1 p-3">
      <Text variant="secondary" size="xs">{label}</Text>
      <span className={`font-semibold tabular-nums ${color}`}>{value}</span>
    </LayerCard>
  );
}

function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(4)}`;
}

/** 积分估值（美元/分）。用来估算「积分价值 − 实际损耗」的盈亏；价格变动时只改这里。 */
const POINT_PRICE_USD = 1.2;

/** One rollup as a Kumo Table (compact sticky header) inside a height-capped scroll region. */
function RollupTable({ title, rows, keyLabel }: { title: string; rows: Rollup[]; keyLabel: string }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-kumo-subtle">{title}</span>
      <LayerCard className="p-0">
        <div className="max-h-56 overflow-y-auto">
          <Table className="tabular-nums">
            <Table.Header variant="compact" sticky>
              <Table.Row>
                <Table.Head>{keyLabel}</Table.Head>
                <Table.Head>Orders</Table.Head>
                <Table.Head>Maker volume</Table.Head>
                <Table.Head>Taker volume</Table.Head>
                <Table.Head>Maker fees</Table.Head>
                <Table.Head>Taker fees</Table.Head>
                <Table.Head>积分</Table.Head>
                <Table.Head>积分成本</Table.Head>
                <Table.Head>Wear</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.slice(0, 50).map((r) => (
                <Table.Row key={r.key}>
                  <Table.Cell className="font-mono">{r.key}</Table.Cell>
                  <Table.Cell>
                    {r.orders}
                    {/* 官方历史订单没有 taker 标记，用 +n? 标注无法判定的笔数 */}
                    {r.unclassifiedOrders > 0 && (
                      <span className="text-kumo-inactive"> (+{r.unclassifiedOrders}?)</span>
                    )}
                  </Table.Cell>
                  <Table.Cell>{r.makerVolume.toFixed(2)}</Table.Cell>
                  <Table.Cell>{r.takerVolume.toFixed(2)}</Table.Cell>
                  <Table.Cell>{r.makerFees.toFixed(4)}</Table.Cell>
                  <Table.Cell>{r.takerFees.toFixed(4)}</Table.Cell>
                  <Table.Cell>{r.points.toFixed(2)}</Table.Cell>
                  {/* 积分成本 = Wear ÷ 积分（Wear = 手续费 − 已实现盈亏），即开平仓的实际净花费摊到每 1 分 */}
                  <Table.Cell>{r.points > 0 ? (r.wear / r.points).toFixed(4) : "—"}</Table.Cell>
                  <Table.Cell>{r.wear.toFixed(4)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        {rows.length > 50 && (
          <div className="px-3 py-2 text-center">
            <Text variant="secondary" size="xs">+{rows.length - 50} more (included in export)</Text>
          </div>
        )}
      </LayerCard>
    </div>
  );
}

/** 自成交 / 外部成交汇总：两行对照，判断当前刷量是否全部落在自家钱包之间。
 *  判定规则（账本层）：同市场、反方向、不同钱包，10 秒内、价格 0.5% / 数量 2% 以内。 */
function SplitTable({ totals }: { totals: Totals }) {
  const rows = [
    {
      key: "Self-cross",
      orders: totals.selfOrders,
      volume: totals.selfVolume,
      fees: totals.selfFees,
      pnl: totals.selfPnl,
      wear: totals.selfWear,
    },
    {
      key: "External",
      orders: totals.extOrders,
      volume: totals.extVolume,
      fees: totals.extFees,
      pnl: totals.extPnl,
      wear: totals.extWear,
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-kumo-subtle">Self-cross vs external</span>
      <LayerCard className="p-0">
        <Table className="tabular-nums">
          <Table.Header variant="compact">
            <Table.Row>
              <Table.Head>Type</Table.Head>
              <Table.Head>Orders</Table.Head>
              <Table.Head>Volume</Table.Head>
              <Table.Head>Fees</Table.Head>
              <Table.Head>PnL</Table.Head>
              <Table.Head>Wear</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((r) => (
              <Table.Row key={r.key}>
                <Table.Cell className="font-medium">{r.key}</Table.Cell>
                <Table.Cell>{r.orders}</Table.Cell>
                <Table.Cell>{r.volume.toFixed(2)}</Table.Cell>
                <Table.Cell>{r.fees.toFixed(4)}</Table.Cell>
                <Table.Cell>{signed(r.pnl)}</Table.Cell>
                <Table.Cell>{r.wear.toFixed(4)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </LayerCard>
    </div>
  );
}

/** 成交账本弹窗：数据来自公共 WS fill 流（本地 FIFO 计算盈亏），并落库到服务端。
 *  保持挂载、由 `open` 驱动（Kumo dialog-rendering 规则）；只有 body 滚动。 */
export function AccountingView({ open, onClose, subaccounts = [] }: { open: boolean; onClose: () => void; subaccounts?: string[] }) {
  // 账本就地变更，通过订阅 version 触发重渲染；打开时再重算 rollup。
  const [, setVersion] = useState(0);
  useEffect(() => accountingLedger.subscribe(() => setVersion((v) => v + 1)), []);

  // 每次打开弹窗都向服务端再同步一次（合并去重、不清空本地）：
  // 之前只在模块加载时 hydrate 一次，若那次请求失败（例如开发服务器正在重编译），
  // 账本就会一直是空的，看起来像「历史记录都没了」。
  useEffect(() => {
    if (open) accountingLedger.reload();
  }, [open]);

  // 历史回补：用官方 indexer 查询选中钱包的历史订单（含真实 fee / realized_pnl）
  const subsKey = subaccounts.join(",");
  const [history, setHistory] = useState<{ loading: boolean; note?: string }>({ loading: false });
  const loadedFor = useRef("");

  const loadHistory = useCallback(async () => {
    if (!subsKey) {
      setHistory({ loading: false, note: "先在右侧选中钱包，再补历史成交" });
      return;
    }
    setHistory({ loading: true });
    try {
      const res = await fetch(`/api/accounting/history?subaccounts=${encodeURIComponent(subsKey)}&perWallet=1000`);
      const data = (await res.json()) as { ok?: boolean; error?: string; records?: unknown; truncated?: boolean };
      if (!data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const list = Array.isArray(data.records) ? data.records : [];
      const added = accountingLedger.importRecords(list);
      const tail = data.truncated ? "（每个钱包最多取 1000 条，超出部分未显示）" : "";
      setHistory({ loading: false, note: added > 0 ? `已补 ${added} 条历史成交（官方 indexer）${tail}` : "该钱包没有新的历史成交" });
    } catch (e) {
      setHistory({ loading: false, note: `历史查询失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }, [subsKey]);

  // 打开弹窗时自动补一次（同一批钱包不重复请求）
  useEffect(() => {
    if (!open || !subsKey || loadedFor.current === subsKey) return;
    loadedFor.current = subsKey;
    void loadHistory();
  }, [open, subsKey, loadHistory]);

  // 排除名单里的钱包（见 accountingExclusions）：汇总、表格、折线图、导出都基于过滤后的记录
  const records = withoutExcludedWallets(accountingLedger.records);
  const report = open ? rollup(records) : null;
  const t = report?.totals;

  return (
    <LayerDialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>Accounting</LayerDialog.Title>
        <LayerDialog.Description>{records.length} fills · 仅统计已成交，刷新后仍在</LayerDialog.Description>
        <LayerDialog.Body>
          {report && t && (
            // pt-1: Body is a scroll container with no top padding, which clipped the stat cards' ring.
            <div className="flex flex-col gap-4 pt-1">
              {/* 只保留用户关心的口径：挂/吃成交量、挂/吃手续费、积分、积分成本、手续费以外的损耗 */}
              <Grid variant="4up" gap="sm">
                <Stat label="Maker volume（挂单成交量）" value={t.makerVolume.toFixed(2)} />
                <Stat label="Taker volume（吃单成交量）" value={t.takerVolume.toFixed(2)} />
                <Stat label="Maker fees（挂单手续费）" value={t.makerFees.toFixed(4)} />
                <Stat label="Taker fees（吃单手续费）" value={t.takerFees.toFixed(4)} />
              </Grid>
              <Grid variant="4up" gap="sm">
                {/* 积分口径：挂单每 16000 名义额 1 分、吃单每 2500 名义额 1 分，按比例累计 */}
                <Stat
                  label={`积分（挂单 ${(t.makerVolume / MAKER_VOLUME_PER_POINT).toFixed(2)} + 吃单 ${(t.takerVolume / TAKER_VOLUME_PER_POINT).toFixed(2)}）`}
                  value={`${t.points.toFixed(2)} 分`}
                />
                {/* 积分成本 = Wear ÷ 积分，Wear 已含手续费 + 开平仓盈亏 */}
                <Stat
                  label="积分成本（Wear ÷ 积分）"
                  value={t.points > 0 ? (t.wear / t.points).toFixed(4) : "—"}
                  tone={t.points > 0 && t.wear > 0 ? "down" : undefined}
                />
                {/* 手续费以外的损耗 = Wear − 手续费 = −已实现盈亏（正数=价差亏损，负数=价差盈利） */}
                <Stat
                  label="手续费以外的损耗（−PnL）"
                  value={(t.wear - t.fees).toFixed(4)}
                  tone={t.wear - t.fees > 0 ? "down" : t.wear - t.fees < 0 ? "up" : undefined}
                />
                {/* 总计损耗 = Wear = 手续费 + 价差损耗（= 手续费 − 已实现盈亏），也就是拿积分前实际花掉的总成本 */}
                <Stat
                  label="总计损耗（手续费 + 价差）"
                  value={t.wear.toFixed(4)}
                  tone={t.wear > 0 ? "down" : t.wear < 0 ? "up" : undefined}
                />
                {/* 预计盈亏 = 积分价值 − 总损耗（Wear 已含手续费和开平仓盈亏）；正=赚，负=亏 */}
                <Stat
                  label={`预计盈亏（积分 @ ${POINT_PRICE_USD} 美元/分）`}
                  value={signed(t.points * POINT_PRICE_USD - t.wear)}
                  tone={
                    t.points * POINT_PRICE_USD - t.wear > 0
                      ? "up"
                      : t.points * POINT_PRICE_USD - t.wear < 0
                        ? "down"
                        : undefined
                  }
                />
              </Grid>
              {/* 积分成本走势：线色按最近 10 单是否超过 1.2 美元/分切换 */}
              <PointCostChart records={records} />
              {records.length > 0 && <SplitTable totals={t} />}
              {records.length === 0 ? (
                <Empty
                  size="sm"
                  icon={<ReceiptIcon size={32} className="text-kumo-inactive" />}
                  title="No fills yet"
                  description="Run a trading strategy or bulk action — fills stream in live via WS."
                />
              ) : (
                <>
                  <RollupTable title="By cohort" rows={report.byCohort} keyLabel="Cohort" />
                  <RollupTable title="By wallet" rows={report.byWallet} keyLabel="Wallet" />
                  {/* 表头口径说明：积分成本按「Wear ÷ 积分」给，已把开平仓吃掉的盈亏一起算进去 */}
                  <Text variant="secondary" size="xs">
                    积分成本 = Wear ÷ 积分 =（手续费 − 已实现盈亏）÷ 积分，即开平仓后的净花费摊到每 1 分；积分按挂单 16000 美元/分、吃单 2500 美元/分累计。
                  </Text>
                  {/* 历史订单没有 is_taker，已按手续费率反推；仍无法判定的才标 (+n?) */}
                  {t.unclassifiedOrders > 0 && (
                    <Text variant="secondary" size="xs">
                      Maker / Taker 按手续费率（maker ≈0.01% / taker ≈0.035%）与成交回执标记统计；仍有 {t.unclassifiedOrders} 笔缺手续费信息，表中显示为 (+n?)。
                    </Text>
                  )}
                </>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => { void loadHistory(); }} disabled={history.loading || !subsKey}>
                  {history.loading ? "Loading history…" : "Load history"}
                </Button>
                <Button icon={ArrowCounterClockwiseIcon} variant="secondary" onClick={() => accountingLedger.reload()}>
                  Reload ledger
                </Button>
                <Button icon={DownloadSimpleIcon} onClick={() => download("fleet-accounting.csv", toCsv(report), "text/csv")} disabled={records.length === 0}>Export CSV</Button>
                <Button icon={DownloadSimpleIcon} onClick={() => download("fleet-accounting.json", toJson(report), "application/json")} disabled={records.length === 0}>Export JSON</Button>
                <Button icon={ArrowCounterClockwiseIcon} variant="secondary" onClick={() => { void accountingLedger.reset(); }} disabled={records.length === 0}>Reset ledger</Button>
              </div>
              {history.note && <Text variant="secondary" size="xs">{history.note}</Text>}
            </div>
          )}
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
