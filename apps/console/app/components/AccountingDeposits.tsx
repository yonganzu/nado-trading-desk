"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, LayerCard, Table, Text } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { netByWallet, netTotals, fetchDeposits, shortOwner, type DepositRecord } from "../lib/deposits";
import { isAddressExcluded, subscribeExclusions } from "../lib/accountingExclusions";

/** Accounting 里的「净充值」区块：用官方 indexer 拉每个子账户的充值（deposit_collateral）与
 *  提币（withdraw_collateral）事件，汇总成「充值 − 提币 = 净充值」。
 *  打开 Accounting 时自动拉一次（同一批钱包不重复请求），也可以点「刷新」手动重拉。 */
export function AccountingDeposits({ open, subaccounts }: { open: boolean; subaccounts: string[] }) {
  const subsKey = subaccounts.join(",");
  const [state, setState] = useState<{ loading: boolean; records: DepositRecord[]; note?: string; truncated?: boolean }>({
    loading: false,
    records: [],
  });
  const loadedFor = useRef("");

  // 钱包面板上切换「是否计入统计」时，这里的合计跟着变（与成交统计保持同一口径）
  const [, bump] = useState(0);
  useEffect(() => subscribeExclusions(() => bump((v) => v + 1)), []);

  const load = useCallback(async (force?: boolean) => {
    if (!subsKey) {
      setState({ loading: false, records: [], note: "先在右侧选中钱包，再拉充值记录" });
      return;
    }
    setState((s) => ({ ...s, loading: true, note: undefined }));
    try {
      const { records, truncated } = await fetchDeposits(subsKey.split(","), { force });
      setState({ loading: false, records, truncated });
    } catch (e) {
      setState({ loading: false, records: [], note: `充值记录查询失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }, [subsKey]);

  // 打开弹窗时自动补一次（同一批钱包不重复请求）
  useEffect(() => {
    if (!open || !subsKey || loadedFor.current === subsKey) return;
    loadedFor.current = subsKey;
    void load();
  }, [open, subsKey, load]);

  // 与成交统计同一口径：被排除的钱包（眼睛斜杠）不计入净充值合计与明细
  const shown = state.records.filter((r) => !isAddressExcluded(r.subaccount.slice(0, 42)));
  const totals = netTotals(shown);
  const byWallet = netByWallet(shown);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-kumo-subtle">
          Net deposits（净充值 = 充值 − 提币）
          {totals.count > 0 && ` · 充值 ${totals.deposited.toFixed(2)} − 提币 ${totals.withdrawn.toFixed(2)} = 净 ${totals.net.toFixed(2)} USDT0`}
        </span>
        <Button
          icon={ArrowCounterClockwiseIcon}
          variant="secondary"
          onClick={() => { void load(true); }}
          disabled={state.loading || !subsKey}
        >
          {state.loading ? "拉取中…" : "刷新净充值"}
        </Button>
      </div>

      {state.note && <Text variant="secondary" size="xs">{state.note}</Text>}

      {byWallet.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {byWallet.map((w) => (
            <Text key={w.subaccount} variant="secondary" size="xs">
              <span className="font-mono">{shortOwner(w.subaccount)}</span> 净 {w.net.toFixed(2)}
              （充值 {w.deposited.toFixed(2)} / 提币 {w.withdrawn.toFixed(2)}）
            </Text>
          ))}
        </div>
      )}

      {shown.length > 0 && (
        <LayerCard className="p-0">
          <div className="max-h-56 overflow-y-auto">
            <Table className="tabular-nums">
              <Table.Header variant="compact" sticky>
                <Table.Row>
                  <Table.Head>Time</Table.Head>
                  <Table.Head>Wallet</Table.Head>
                  <Table.Head>Type</Table.Head>
                  <Table.Head>Amount (USDT0)</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {shown.slice(0, 50).map((r) => (
                  <Table.Row key={`${r.subaccount}|${r.ts}`}>
                    <Table.Cell>{new Date(r.ts).toLocaleString("zh-CN", { hour12: false })}</Table.Cell>
                    <Table.Cell className="font-mono">{shortOwner(r.subaccount)}</Table.Cell>
                    <Table.Cell>{r.type === "withdraw" ? "提币" : "充值"}</Table.Cell>
                    {/* 充值记正、提币记负，一眼能看出净额方向 */}
                    <Table.Cell className={r.type === "withdraw" ? "text-rose-400" : "text-emerald-400"}>
                      {r.type === "withdraw" ? "−" : "+"}{r.amount.toFixed(4)}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        </LayerCard>
      )}

      {shown.length > 50 && (
        <Text variant="secondary" size="xs">只显示最近 50 笔，净额与分钱包汇总包含全部记录。</Text>
      )}
      {state.truncated && (
        <Text variant="secondary" size="xs">每个钱包最多取 500 条充值/提币事件，更早的记录未包含。</Text>
      )}
    </div>
  );
}
