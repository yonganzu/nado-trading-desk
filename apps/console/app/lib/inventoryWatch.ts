// =============================================================================
// 库存观察（只统计，不改变任何真实下单行为）
//
// 目的：在改成「跨轮净额对冲」之前，先把两个问题量化出来：
//   1. 如果每对做完**不立刻平仓**，两个钱包的净仓会漂到哪里（当前敞口 / 峰值）；
//   2. 改成「净仓超过阈值才平」，能省掉多少「每对都平」的外部成交量。
//
// 做法：只按成交累加一份**虚拟净仓**（不读接口、不下单、不撤单），
// 每轮末尾输出一行汇总。真实流程仍然每对照旧平仓，因此这份统计可以随时删掉。
// =============================================================================

/** 单钱包单市场的净敞口超过它，就平一次（USDT0）。这是默认值，每次 run 开始时可由面板覆盖。 */
export const INVENTORY_THRESHOLD_USDT0 = 300;
let thresholdUsdt0 = INVENTORY_THRESHOLD_USDT0;

/** 覆盖库存阈值（runContinuous 开跑时按面板设置写入；非正数忽略）。 */
export function setInventoryThreshold(n: number): void {
  if (Number.isFinite(n) && n > 0) thresholdUsdt0 = n;
}

/** 平仓腿的单边成本估算：taker 约 3.5 bp + 穿一次点差约 1 bp。 */
const FLATTEN_COST_BPS = 4.5;

export interface InventoryRow {
  walletId: string;
  market: string;
  symbol: string;
  /** 虚拟净仓（币本位，正 = 多） */
  base: number;
  /** 最近一次成交价（折算名义额用） */
  price: number;
}

const rows = new Map<string, InventoryRow>();
let pairs = 0;               // 参与统计的对数
let tradedNotional = 0;      // 累计成交名义额（两条腿各算一次）
let simFlattenNotional = 0;  // 按阈值策略「需要」真实平仓的名义额（观察模式）
let realFlattenNotional = 0; // 净额对冲模式下实际发出的平仓名义额
let peakNotional = 0;        // 虚拟净敞口峰值（单钱包单市场）
// 观察模式：超额部分在模拟里截断（只用来看「理论上要平多少」）。
// 净额对冲模式：必须保留真实净仓（否则阈值判断失准），改为由 clearInventory 在真平后归零。
let trimSimulated = true;

/** 切换统计口径：观察模式（默认，模拟截断）或净额对冲模式（跟踪真实净仓）。 */
export function setInventorySimulation(on: boolean): void {
  trimSimulated = on;
}

/** 该钱包在该市场的净仓是否已经顶到阈值（净额对冲模式据此决定要不要真平）。 */
export function inventoryOverThreshold(walletId: string, market: string): boolean {
  const row = rows.get(`${walletId}|${market}`);
  return !!row && Math.abs(row.base) * row.price >= thresholdUsdt0;
}

/** 真实平仓完成后把该钱包的净仓归零（与链上/撮合侧的实际持仓重新对齐）。 */
export function clearInventory(walletId: string, market: string): void {
  const row = rows.get(`${walletId}|${market}`);
  if (!row) return;
  realFlattenNotional += Math.abs(row.base) * row.price;
  row.base = 0;
}

/** 每次开跑前清零（一次 run 的统计口径）。 */
export function resetInventoryWatch(): void {
  rows.clear();
  pairs = 0;
  tradedNotional = 0;
  simFlattenNotional = 0;
  realFlattenNotional = 0;
  peakNotional = 0;
}

/** 记一对自成交：maker 按 makerSide 加减，taker 反向。平仓在模拟里**忽略**（这正是要观察的部分）。 */
export function notePairInventory(a: {
  makerId: string; takerId: string; market: string; symbol: string;
  makerSide: "buy" | "sell"; size: number; price: number;
}): void {
  pairs++;
  tradedNotional += a.size * a.price * 2; // 两腿各一份
  const dir = a.makerSide === "buy" ? 1 : -1;
  apply(a.makerId, a.market, a.symbol, dir * a.size, a.price);
  apply(a.takerId, a.market, a.symbol, -dir * a.size, a.price);
}

function apply(walletId: string, market: string, symbol: string, delta: number, price: number): void {
  const key = `${walletId}|${market}`;
  const row = rows.get(key) ?? { walletId, market, symbol, base: 0, price };
  row.base += delta;
  row.price = price;
  rows.set(key, row);

  // 敞口超过阈值时：观察模式下截断模拟（估算要平多少）；对冲模式下保留真实净仓，等调用方真平后再清零
  const notional = Math.abs(row.base) * price;
  peakNotional = Math.max(peakNotional, notional);
  if (trimSimulated && notional > thresholdUsdt0) {
    const excessBase = notional - thresholdUsdt0;
    simFlattenNotional += excessBase;
    row.base -= Math.sign(row.base) * (excessBase / price);
  }
}

/** 本轮/本次 run 的库存观察汇总（若干行日志）。 */
export function inventorySummary(): string[] {
  if (pairs === 0) return [];
  const list = [...rows.values()].sort(
    (x, y) => Math.abs(y.base) * y.price - Math.abs(x.base) * x.price,
  );
  // 单钱包最大敞口（保证金是按单个钱包算的，两个钱包的正负仓互相抵消，求和会误导）
  const current = list.reduce((a, r) => Math.max(a, Math.abs(r.base) * r.price), 0);
  const top = list.slice(0, 4)
    .map((r) => `${r.walletId.replace("live:", "w")} ${r.base >= 0 ? "+" : ""}${r.base.toFixed(3)} ${r.symbol}`)
    .join(" · ");
  // 当前策略每对都平，平仓量 ≈ 成交名义额；阈值策略只需要 simFlattenNotional
  const saved = Math.max(0, tradedNotional - simFlattenNotional);
  const savedUsd = saved * (FLATTEN_COST_BPS / 10_000);
  const flatLine = trimSimulated
    ? `   按 ${thresholdUsdt0} 阈值估算需平仓 ${simFlattenNotional.toFixed(0)} USDT0（现状每对都平 ≈ ${tradedNotional.toFixed(0)}）`
      + `，预计可省 ~$${savedUsd.toFixed(3)}（按 ${FLATTEN_COST_BPS} bp/边估算）`
    : `   净额对冲已平仓 ${realFlattenNotional.toFixed(0)} USDT0（阈值 ${thresholdUsdt0}，用途中仓位互相抵消）`
      + `，对比每对都平（≈${tradedNotional.toFixed(0)}）省下 ${Math.max(0, Math.round((1 - realFlattenNotional / Math.max(1, tradedNotional)) * 100))}%`;
  return [
    `📊 库存观察（${trimSimulated ? "只统计，不改变下单" : "净额对冲模式"}）：累计 ${pairs} 对 / 成交 ${tradedNotional.toFixed(0)} USDT0`,
    `   虚拟净仓：${top || "—"}｜单钱包最大敞口 ${current.toFixed(0)} USDT0，峰值 ${peakNotional.toFixed(0)} USDT0`,
    flatLine,
  ];
}
