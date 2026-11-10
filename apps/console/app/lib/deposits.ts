// Accounting 的资金进出记录：从服务端路由取 Nado indexer 的 deposit_collateral / withdraw_collateral 事件，
// 汇总成「净充值 = 充值 − 提币」。只做「取数 + 汇总」两件事，UI 在 components/AccountingDeposits.tsx。
export interface DepositRecord {
  /** 子账户 bytes32（前 40 位就是钱包地址） */
  subaccount: string;
  /** deposit = 充值（转入），withdraw = 提币（转出） */
  type: "deposit" | "withdraw";
  /** USDT0 数量（正数，方向看 type） */
  amount: number;
  /** 毫秒时间戳 */
  ts: number;
}

type DepositsResult = { records: DepositRecord[]; truncated: boolean };

/** 结果缓存（默认 60 秒）：Accounting 顶部的「已充值」和底部的「净充值」共用同一份，
 *  打开弹窗时不会向 indexer 重复请求；手动刷新时传 force 跳过缓存。 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: DepositsResult }>();
const inflight = new Map<string, Promise<DepositsResult>>();

/** 拉取一批子账户的充值 / 提币记录（服务端转发 indexer，keyless 只读）。 */
export async function fetchDeposits(subaccounts: readonly string[], opts?: { force?: boolean }): Promise<DepositsResult> {
  if (subaccounts.length === 0) return { records: [], truncated: false };
  const key = subaccounts.join(",");
  if (!opts?.force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const running = inflight.get(key);
    if (running) return running;
  }
  const task = (async (): Promise<DepositsResult> => {
    const res = await fetch(`/api/accounting/deposits?subaccounts=${encodeURIComponent(subaccounts.join(","))}`);
    const data = (await res.json()) as { ok?: boolean; error?: string; records?: DepositRecord[]; truncated?: boolean };
    if (!data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    const value = { records: Array.isArray(data.records) ? data.records : [], truncated: Boolean(data.truncated) };
    cache.set(key, { at: Date.now(), value });
    return value;
  })();
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

/** 子账户 bytes32 → 钱包地址的短标签（0xee69c6b12313… → 0xee69…a74F）。 */
export function shortOwner(subaccount: string): string {
  const hex = subaccount.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex)) return hex.slice(0, 8);
  return `${hex.slice(0, 6)}…${hex.slice(38, 42)}`;
}

/** 净额汇总：总充值、总提币、净充值（= 充值 − 提币）。 */
export interface NetTotals {
  deposited: number;
  withdrawn: number;
  net: number;
  count: number;
}

export function netTotals(records: readonly DepositRecord[]): NetTotals {
  let deposited = 0;
  let withdrawn = 0;
  for (const r of records) {
    if (r.type === "withdraw") withdrawn += r.amount;
    else deposited += r.amount;
  }
  return { deposited, withdrawn, net: deposited - withdrawn, count: records.length };
}

/** 按子账户汇总净充值，按净额从大到小排序。 */
export function netByWallet(records: readonly DepositRecord[]): Array<NetTotals & { subaccount: string }> {
  const map = new Map<string, NetTotals & { subaccount: string }>();
  for (const r of records) {
    const cur = map.get(r.subaccount) ?? { subaccount: r.subaccount, deposited: 0, withdrawn: 0, net: 0, count: 0 };
    if (r.type === "withdraw") cur.withdrawn += r.amount;
    else cur.deposited += r.amount;
    cur.net = cur.deposited - cur.withdrawn;
    cur.count += 1;
    map.set(r.subaccount, cur);
  }
  return [...map.values()].sort((a, b) => b.net - a.net);
}
