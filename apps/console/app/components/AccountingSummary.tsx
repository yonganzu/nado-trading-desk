"use client";

import { useEffect, useState } from "react";
import { LayerCard, Text } from "@cloudflare/kumo";
import { fetchDeposits, netTotals } from "../lib/deposits";
import type { DepositRecord } from "../lib/deposits";
import { isAddressExcluded, subscribeExclusions } from "../lib/accountingExclusions";

/** 顶部总览里的一块：标题 + 大号数字 + 可选小字说明。 */
function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "up" }) {
  return (
    <LayerCard className="flex flex-col gap-1 p-3">
      <Text variant="secondary" size="xs">{label}</Text>
      <span className={`text-lg font-semibold tabular-nums ${tone === "up" ? "text-emerald-400" : ""}`}>{value}</span>
      {hint && <Text variant="secondary" size="xs">{hint}</Text>}
    </LayerCard>
  );
}

/** Accounting 最顶部的一栏：我们累计充值了多少、所有钱包现在还剩下多少钱。
 *  - 已充值 / 已提币来自官方 indexer 的 deposit_collateral / withdraw_collateral 事件，
 *    与下方「净充值」共用 lib/deposits 里的缓存，不会重复请求；
 *  - 剩余资金由页面按实时余额（USDT0 margin）汇总后传进来；余额还没读到的钱包不计入金额，
 *    只在说明里标出「已读 X/Y」。
 *  - 被眼睛斜杠排除的钱包与成交统计保持一致：不计入充值合计。 */
export function AccountingSummary({ open, subaccounts, balanceUsdt0, balanceKnown, balanceTotal }: {
  open: boolean;
  subaccounts: string[];
  balanceUsdt0: number;
  balanceKnown: number;
  balanceTotal: number;
}) {
  const subsKey = subaccounts.join(",");
  const [records, setRecords] = useState<DepositRecord[]>([]);
  const [note, setNote] = useState<string | undefined>();

  // 钱包面板上切换「是否计入统计」时，这里的合计跟着变
  const [, bump] = useState(0);
  useEffect(() => subscribeExclusions(() => bump((v) => v + 1)), []);

  useEffect(() => {
    if (!open || !subsKey) { setRecords([]); return; }
    let alive = true;
    fetchDeposits(subsKey.split(","))
      .then(({ records: list }) => { if (alive) { setRecords(list); setNote(undefined); } })
      .catch((e: unknown) => {
        if (alive) { setRecords([]); setNote(`充值记录查询失败：${e instanceof Error ? e.message : String(e)}`); }
      });
    return () => { alive = false; };
  }, [open, subsKey]);

  const shown = records.filter((r) => !isAddressExcluded(r.subaccount.slice(0, 42)));
  const totals = netTotals(shown);

  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Tile
          label="已充值（累计）"
          value={subsKey ? `${totals.deposited.toFixed(2)} USDT0` : "—"}
          hint={subsKey
            ? `已提币 ${totals.withdrawn.toFixed(2)} · 净充值 ${totals.net.toFixed(2)}（当前选中的 ${subaccounts.length} 个钱包）`
            : "先在右侧选中钱包，再查看充值金额"}
        />
        <Tile
          label="剩余资金（所有钱包）"
          value={`${balanceUsdt0.toFixed(2)} USDT0`}
          hint={balanceTotal > 0 ? `已读到余额 ${balanceKnown}/${balanceTotal} 个钱包，未读到的暂不计入` : "还没有钱包余额数据"}
          tone="up"
        />
      </div>
      {note && <Text variant="secondary" size="xs">{note}</Text>}
    </div>
  );
}
