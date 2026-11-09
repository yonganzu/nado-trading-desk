// =============================================================================
// @farm/ui · accounting (Q61) — fleet-wide fill rollup + CSV/JSON export.
// Pure: aggregates 成交记录 into per-wallet and per-cohort totals (a record
// counts toward every cohort it carries).
//
// 口径（与用户确认）：
//   • orders   = 成交笔数（每个 fill 回执一条，已在账本层按去重键去重）
//   • volume   = Σ(price × size) 名义额
//   • buyFees  = 买入手续费；sellFees = 卖出手续费（fee 带符号，maker 返佣为负）
//   • fees     = 手续费合计（= buyFees + sellFees），即「排除盈亏的纯成本」
//   • pnl      = 已实现盈亏（逐笔 FIFO 平仓，开仓成交计 0）
//   • wear     = fees − pnl（总磨损；亏损时 pnl<0 会放大磨损，盈利时抵扣）
// =============================================================================
export interface AccountingRecord {
  /** 去重键：subaccount|order_digest|timestamp|filled_qty（同一笔成交被 WS 重放时不会重复入账） */
  id?: string;
  /** 产生该成交的 subaccount（历史回补与 WS 去重时使用） */
  subaccount?: string;
  /** 产生该成交的订单摘要（同订单的 WS 成交与历史订单只计一次） */
  orderDigest?: string;
  walletId: string;
  accountName?: string;
  cohorts?: readonly string[];
  market: string;
  side: "buy" | "sell";
  /** 成交价（人类小数） */
  price?: number;
  /** 成交数量（人类小数） */
  size?: number;
  notional: number; // price × size
  /** Nado 回执手续费，带符号（maker 返佣为负） */
  fee: number;
  /** 本条平仓产生的已实现盈亏；开仓成交为 0 */
  realizedPnl?: number;
  /** 是否吃单成交 */
  taker?: boolean;
  /** 是否自成交：同市场、反方向、价格/数量接近、时间相近且来自两个不同钱包（由账本判定） */
  selfCross?: boolean;
  status: string;
  ts: number;
}

export interface Rollup {
  key: string;
  orders: number;
  volume: number;
  buys: number;
  sells: number;
  buyFees: number;
  sellFees: number;
  /** maker 侧手续费（按 taker === false 归集；缺标记的按 maker 记，保证 maker+taker = fees） */
  makerFees: number;
  /** taker 侧手续费 */
  takerFees: number;
  fees: number;
  pnl: number;
  /** 总磨损 = fees − pnl */
  wear: number;
  // maker / taker 笔数（优先用成交回执的 taker 标记；历史订单按手续费率反推，反推不出才计入 unclassified）
  makerOrders: number;
  takerOrders: number;
  /** 无法判定 maker/taker 的成交笔数（缺手续费/名义额时才会出现） */
  unclassifiedOrders: number;
  // maker / taker 成交名义额（只统计能判定角色的成交，用于积分换算；无法判定的两边都不计入）
  makerVolume: number;
  takerVolume: number;
  /** 积分 = 挂单名义额 ÷ 16000 + 吃单名义额 ÷ 2500（按比例累计，不是取整） */
  points: number;
  // 自成交 / 外部成交分桶（selfCross === true 记为自成交，其余记为外部）
  selfOrders: number;
  selfVolume: number;
  selfFees: number;
  selfPnl: number;
  selfWear: number;
  extOrders: number;
  extVolume: number;
  extFees: number;
  extPnl: number;
  extWear: number;
}
export type Totals = Omit<Rollup, "key">;

// Nado 费率基准（以成交名义额为分母）：maker 约 1bps，taker 约 3.5bps。
// 官方 indexer 的订单不返回 is_taker 字段，用「手续费 / 名义额」落在哪一侧来反推。
export const MAKER_FEE_RATE = 0.0001;
export const TAKER_FEE_RATE = 0.00035;

// Nado 积分口径（与用户确认）：吃单每 2500 名义额 1 分，挂单每 16000 名义额 1 分。
// 按比例累计（例如 1000 名义额吃单 = 0.4 分），不做取整，方便对照官方面板的分值。
export const TAKER_VOLUME_PER_POINT = 2500;
export const MAKER_VOLUME_PER_POINT = 16000;
/** maker / taker 费率的判定中线（中点，两侧各留一半余量，容忍费率档位小幅浮动）。 */
const FEE_RATE_SPLIT = (MAKER_FEE_RATE + TAKER_FEE_RATE) / 2;

/**
 * 由手续费反推该笔成交是 maker 还是 taker（历史订单缺 is_taker 时的兜底）：
 * 手续费率 ≤ 中线 → maker（false）；> 中线 → taker（true）；名义额不可用时返回 undefined（未知）。
 * 负手续费（返佣）按 maker 处理。
 */
export function inferTaker(fee: number, notional: number): boolean | undefined {
  if (!Number.isFinite(fee) || !Number.isFinite(notional) || !(notional > 0)) return undefined;
  return Math.abs(fee) / notional >= FEE_RATE_SPLIT;
}

export interface AccountingReport {
  totals: Totals;
  byWallet: Rollup[];
  byCohort: Rollup[];
}

function emptyAgg(): Totals {
  return {
    orders: 0, volume: 0, buys: 0, sells: 0, buyFees: 0, sellFees: 0, makerFees: 0, takerFees: 0, fees: 0, pnl: 0, wear: 0,
    makerOrders: 0, takerOrders: 0, unclassifiedOrders: 0, makerVolume: 0, takerVolume: 0, points: 0,
    selfOrders: 0, selfVolume: 0, selfFees: 0, selfPnl: 0, selfWear: 0,
    extOrders: 0, extVolume: 0, extFees: 0, extPnl: 0, extWear: 0,
  };
}

function add(agg: Totals, r: AccountingRecord): void {
  const fee = Number.isFinite(r.fee) ? r.fee : 0;
  const pnl = r.realizedPnl ?? 0;
  agg.orders += 1;
  agg.volume += r.notional;
  agg.fees += fee;
  if (r.side === "buy") {
    agg.buys += 1;
    agg.buyFees += fee;
  } else {
    agg.sells += 1;
    agg.sellFees += fee;
  }
  agg.pnl += pnl;
  // maker / taker 笔数与手续费：只有成交回执带 taker 标记才可判定（历史订单已按费率反推）
  if (r.taker === true) {
    agg.takerOrders += 1;
    agg.takerFees += fee;
    agg.takerVolume += r.notional; // 积分：吃单按 2500 美元 1 分
  } else if (r.taker === false) {
    agg.makerOrders += 1;
    agg.makerFees += fee;
    agg.makerVolume += r.notional; // 积分：挂单按 16000 美元 1 分
  } else {
    agg.unclassifiedOrders += 1;
    agg.makerFees += fee; // 极端兜底：无法判定时归 maker，确保 maker+taker 之和等于总手续费
  }
  // 自成交 / 外部成交分桶
  if (r.selfCross === true) {
    agg.selfOrders += 1;
    agg.selfVolume += r.notional;
    agg.selfFees += fee;
    agg.selfPnl += pnl;
  } else {
    agg.extOrders += 1;
    agg.extVolume += r.notional;
    agg.extFees += fee;
    agg.extPnl += pnl;
  }
}

/** 汇总结束时统一结算 wear（依赖 fees 与 pnl 两个累计值）。 */
function finish(agg: Totals): Totals {
  agg.wear = agg.fees - agg.pnl;
  agg.selfWear = agg.selfFees - agg.selfPnl;
  agg.extWear = agg.extFees - agg.extPnl;
  // 积分按比例累计，不取整（挂单 16000 美元 1 分、吃单 2500 美元 1 分）
  agg.points = agg.makerVolume / MAKER_VOLUME_PER_POINT + agg.takerVolume / TAKER_VOLUME_PER_POINT;
  return agg;
}

export function rollup(records: readonly AccountingRecord[]): AccountingReport {
  const totals = emptyAgg();
  const wallet = new Map<string, Totals>();
  const cohort = new Map<string, Totals>();
  for (const r of records) {
    add(totals, r);
    const w = wallet.get(r.walletId) ?? emptyAgg();
    add(w, r);
    wallet.set(r.walletId, w);
    for (const c of r.cohorts ?? []) {
      const cg = cohort.get(c) ?? emptyAgg();
      add(cg, r);
      cohort.set(c, cg);
    }
  }
  finish(totals);
  const toRows = (m: Map<string, Totals>): Rollup[] =>
    [...m].map(([key, a]) => ({ key, ...finish(a) })).sort((x, y) => y.volume - x.volume);
  return { totals, byWallet: toRows(wallet), byCohort: toRows(cohort) };
}

/** Per-wallet rollup as CSV. */
export function toCsv(report: AccountingReport): string {
  const head = "wallet,orders,volume,buys,sells,buyFees,sellFees,fees,pnl,wear";
  const rows = report.byWallet.map((r) =>
    `${r.key},${r.orders},${r.volume.toFixed(2)},${r.buys},${r.sells},${r.buyFees.toFixed(4)},${r.sellFees.toFixed(4)},${r.fees.toFixed(4)},${r.pnl.toFixed(4)},${r.wear.toFixed(4)}`,
  );
  return [head, ...rows].join("\n");
}

export function toJson(report: AccountingReport): string {
  return JSON.stringify(report, null, 2);
}
