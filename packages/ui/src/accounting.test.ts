import { describe, it, expect } from "vitest";
import { rollup, toCsv, inferTaker } from "./accounting.js";
import type { AccountingRecord } from "./accounting.js";

const rec = (over: Partial<AccountingRecord> = {}): AccountingRecord => ({
  walletId: "hd-0:0", market: "nado:perp:BTC-PERP", side: "buy", notional: 100, fee: 0.1, status: "filled", ts: 0, ...over,
});

describe("accounting rollup (Q61)", () => {
  const records: AccountingRecord[] = [
    rec({ walletId: "A", cohorts: ["alpha"], side: "buy", notional: 100, fee: 0.1 }),
    rec({ walletId: "A", cohorts: ["alpha", "maker"], side: "sell", notional: 200, fee: 0.2 }),
    rec({ walletId: "B", cohorts: ["maker"], side: "buy", notional: 50, fee: 0.05 }),
  ];

  it("aggregates totals, per-wallet, and per-cohort (a record counts in each cohort)", () => {
    const r = rollup(records);
    expect(r.totals).toMatchObject({ orders: 3, volume: 350, buys: 2, sells: 1 });
    expect(r.totals.fees).toBeCloseTo(0.35);
    // 买入/卖出手续费分开统计
    expect(r.totals.buyFees).toBeCloseTo(0.15);
    expect(r.totals.sellFees).toBeCloseTo(0.2);
    // 无 realizedPnl 时盈亏为 0，磨损 = 手续费
    expect(r.totals.pnl).toBeCloseTo(0);
    expect(r.totals.wear).toBeCloseTo(0.35);

    const a = r.byWallet.find((w) => w.key === "A")!;
    expect(a).toMatchObject({ orders: 2, volume: 300, buys: 1, sells: 1 });
    expect(a.buyFees).toBeCloseTo(0.1);
    expect(a.sellFees).toBeCloseTo(0.2);

    const maker = r.byCohort.find((c) => c.key === "maker")!;
    expect(maker.orders).toBe(2); // A's sell + B's buy
    expect(maker.volume).toBe(250);
    expect(r.byWallet[0]!.key).toBe("A"); // sorted by volume desc
  });

  it("wear = fees − realized PnL（亏损放大磨损、盈利抵扣）", () => {
    const r = rollup([
      rec({ walletId: "A", side: "sell", notional: 100, fee: 0.1, realizedPnl: -0.5 }),
      rec({ walletId: "A", side: "buy", notional: 100, fee: 0.1, realizedPnl: 0.3 }),
    ]);
    expect(r.totals.fees).toBeCloseTo(0.2);
    expect(r.totals.pnl).toBeCloseTo(-0.2);
    expect(r.totals.wear).toBeCloseTo(0.4);
  });

  it("inferTaker：按手续费率反推 maker / taker", () => {
    expect(inferTaker(0.01, 100)).toBe(false); // 0.01% → maker
    expect(inferTaker(0.035, 100)).toBe(true); // 0.035% → taker
    expect(inferTaker(0, 100)).toBe(false); // 零费/返佣视为 maker
    expect(inferTaker(-0.01, 100)).toBe(false);
    expect(inferTaker(0.01, 0)).toBeUndefined(); // 名义额不可用 → 未知
  });

  it("统计每个钱包的 maker / taker 笔数（无标记的历史订单计入未知）", () => {
    const r = rollup([
      rec({ walletId: "A", taker: false }),
      rec({ walletId: "A", taker: true }),
      rec({ walletId: "A", taker: true }),
      rec({ walletId: "B", taker: false }),
      rec({ walletId: "B" }), // 历史 indexer 订单：没有 taker 标记
    ]);
    expect(r.totals.makerOrders).toBe(2);
    expect(r.totals.takerOrders).toBe(2);
    expect(r.totals.unclassifiedOrders).toBe(1);
    const a = r.byWallet.find((w) => w.key === "A")!;
    expect(a).toMatchObject({ makerOrders: 1, takerOrders: 2, unclassifiedOrders: 0 });
    const b = r.byWallet.find((w) => w.key === "B")!;
    expect(b).toMatchObject({ makerOrders: 1, takerOrders: 0, unclassifiedOrders: 1 });
    // maker / taker 手续费按笔归集：缺标记的按 maker 兜底，保证两者之和 = 总手续费
    expect(a.makerFees).toBeCloseTo(0.1);
    expect(a.takerFees).toBeCloseTo(0.2);
    expect(b.makerFees).toBeCloseTo(0.2);
    expect(b.takerFees).toBeCloseTo(0);
    expect(r.totals.makerFees + r.totals.takerFees).toBeCloseTo(r.totals.fees);
  });

  it("自成交 / 外部成交单独汇总，且总量口径不变", () => {
    const r = rollup([
      rec({ walletId: "A", side: "buy", notional: 100, fee: 0.1, realizedPnl: 0, selfCross: true }),
      rec({ walletId: "B", side: "sell", notional: 100, fee: 0.1, realizedPnl: 10, selfCross: true }),
      rec({ walletId: "C", side: "buy", notional: 50, fee: 0.05, realizedPnl: 0 }),
    ]);
    // 总量不变（自成交只是分类，不改变合计）
    expect(r.totals).toMatchObject({ orders: 3, volume: 250 });
    // 自成交 2 笔 / 200 名义额 / 手续费 0.2 / 盈亏 10
    expect(r.totals.selfOrders).toBe(2);
    expect(r.totals.selfVolume).toBeCloseTo(200);
    expect(r.totals.selfFees).toBeCloseTo(0.2);
    expect(r.totals.selfPnl).toBeCloseTo(10);
    expect(r.totals.selfWear).toBeCloseTo(0.2 - 10);
    // 外部 1 笔
    expect(r.totals.extOrders).toBe(1);
    expect(r.totals.extFees).toBeCloseTo(0.05);
    expect(r.totals.extPnl).toBeCloseTo(0);
    expect(r.totals.extWear).toBeCloseTo(0.05);
  });

  it("exports per-wallet CSV with the extended header", () => {
    const csv = toCsv(rollup(records));
    const lines = csv.split("\n");
    expect(lines[0]).toBe("wallet,orders,volume,buys,sells,buyFees,sellFees,fees,pnl,wear");
    expect(lines[1]).toBe("A,2,300.00,1,1,0.1000,0.2000,0.3000,0.0000,0.3000");
    expect(lines).toHaveLength(3); // header + 2 wallets
  });
});
