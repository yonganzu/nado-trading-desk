import { describe, it, expect } from "vitest";
import { AccountingLedger, normalizeAmount } from "./accountingLedger";
import type { AccountingRecord } from "@farm/ui";

const SUB = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000000001";

/** 造一帧公共 WS `fill`（默认买 1 个 @100，手续费 0.1）。 */
function frame(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "fill",
    subaccount: SUB,
    product_id: 2,
    order_digest: "0xd1",
    filled_qty: "1",
    price: "100",
    fee: "0.1",
    is_bid: true,
    is_taker: true,
    timestamp: "1000",
    ...over,
  };
}

/** 建一个不落库的账本，并写入 subaccount / product 索引。 */
function ledger(): AccountingLedger {
  const l = new AccountingLedger(false);
  l.setWalletIndex([
    { subaccount: SUB, meta: { walletId: "W1", accountName: "acct", cohorts: ["maker"] } },
  ]);
  l.setMarketIndex([{ productId: 2, market: "nado:perp:BTC-PERP" }]);
  return l;
}

describe("normalizeAmount", () => {
  it("人类小数原样返回，x18 整数按 1e18 缩放", () => {
    expect(normalizeAmount("0.1")).toBeCloseTo(0.1);
    expect(normalizeAmount("100")).toBeCloseTo(100);
    expect(normalizeAmount("1000000000000000000")).toBeCloseTo(1);
    expect(normalizeAmount("100000000000000000000")).toBeCloseTo(100);
    expect(normalizeAmount("abc")).toBe(0);
  });
});

describe("AccountingLedger fill 解析", () => {
  it("把 fill 帧翻译成账本记录（市场 / 钱包 / 手续费 / 方向）", () => {
    const l = ledger();
    const r = l.record(frame(), 10)!;
    expect(r).toMatchObject({
      walletId: "W1",
      accountName: "acct",
      cohorts: ["maker"],
      market: "nado:perp:BTC-PERP",
      side: "buy",
      price: 100,
      size: 1,
      notional: 100,
      fee: 0.1,
      taker: true,
      status: "filled",
      ts: 10,
    });
    expect(l.records).toHaveLength(1);
  });

  it("缺价或缺量（例如 mock 帧）直接跳过", () => {
    const l = ledger();
    expect(l.record(frame({ price: undefined }), 1)).toBeNull();
    expect(l.record(frame({ filled_qty: "0" }), 1)).toBeNull();
    expect(l.records).toHaveLength(0);
  });

  it("同一帧重复推送按 id 去重", () => {
    const l = ledger();
    expect(l.record(frame(), 1)).not.toBeNull();
    expect(l.record(frame(), 1)).toBeNull();
    expect(l.records).toHaveLength(1);
  });

  it("x18 单位的成交也能正确入账", () => {
    const l = ledger();
    const r = l.record(frame({ price: "100000000000000000000", filled_qty: "1000000000000000000" }), 1)!;
    expect(r.notional).toBeCloseTo(100);
    expect(r.size).toBeCloseTo(1);
  });
});

describe("AccountingLedger FIFO 已实现盈亏", () => {
  it("先多后卖：按开仓价平仓计算盈亏，剩余仓位继续持有", () => {
    const l = ledger();
    l.record(frame({ is_bid: true, filled_qty: "2", price: "100" }), 1); // 开多 2 @100
    const close1 = l.record(frame({ is_bid: false, order_digest: "0xd2", filled_qty: "1", price: "110" }), 2)!; // 平多 1 @110
    expect(close1.realizedPnl).toBeCloseTo(10);
    const close2 = l.record(frame({ is_bid: false, order_digest: "0xd3", filled_qty: "1", price: "120" }), 3)!; // 平多 1 @120
    expect(close2.realizedPnl).toBeCloseTo(20);
  });

  it("先空后买：平空盈亏 = 开仓价 − 成交价", () => {
    const l = ledger();
    l.record(frame({ is_bid: false, filled_qty: "1", price: "110" }), 1); // 开空 1 @110
    const close = l.record(frame({ is_bid: true, order_digest: "0xd4", filled_qty: "1", price: "100" }), 2)!; // 平空 1 @100
    expect(close.realizedPnl).toBeCloseTo(10);
  });

  it("开仓成交的 realizedPnl 为 0", () => {
    const l = ledger();
    expect(l.record(frame(), 1)!.realizedPnl).toBe(0);
  });
});

describe("AccountingLedger 自成交判定", () => {
  const SUB2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb000000000002";

  /** 两个钱包（W1 / W2）的账本，用于验证跨钱包配对。 */
  function twoWalletLedger(): AccountingLedger {
    const l = new AccountingLedger(false);
    l.setWalletIndex([
      { subaccount: SUB, meta: { walletId: "W1", accountName: "a1", cohorts: ["maker"] } },
      { subaccount: SUB2, meta: { walletId: "W2", accountName: "a2", cohorts: ["taker"] } },
    ]);
    l.setMarketIndex([{ productId: 2, market: "nado:perp:BTC-PERP" }]);
    return l;
  }

  it("两个不同钱包的反方向近似成交双双标记为自成交", () => {
    const l = twoWalletLedger();
    const a = l.record(frame({ subaccount: SUB, is_bid: true, order_digest: "0xa1" }), 1000)!;
    const b = l.record(frame({ subaccount: SUB2, is_bid: false, order_digest: "0xb1" }), 1001)!;
    expect(a.selfCross).toBe(true);
    expect(b.selfCross).toBe(true);
  });

  it("同一钱包内的反方向成交不算自成交", () => {
    const l = ledger();
    l.record(frame({ is_bid: true, order_digest: "0xa2" }), 1);
    const b = l.record(frame({ is_bid: false, order_digest: "0xb2" }), 2)!;
    expect(b.selfCross).toBeUndefined();
  });

  it("价差超过 0.5% 不算自成交", () => {
    const l = twoWalletLedger();
    l.record(frame({ subaccount: SUB, is_bid: true, order_digest: "0xa3", price: "100" }), 1);
    const b = l.record(frame({ subaccount: SUB2, is_bid: false, order_digest: "0xb3", price: "101" }), 2)!;
    expect(b.selfCross).toBeUndefined();
  });

  it("时间差超过 10 秒不算自成交", () => {
    const l = twoWalletLedger();
    l.record(frame({ subaccount: SUB, is_bid: true, order_digest: "0xa4" }), 1000);
    const b = l.record(frame({ subaccount: SUB2, is_bid: false, order_digest: "0xb4" }), 1000 + 11_000)!;
    expect(b.selfCross).toBeUndefined();
  });

  it("历史回补的订单同样参与配对（跨钱包反方向）", () => {
    const l = twoWalletLedger();
    const base = { market: "nado:perp:BTC-PERP", size: 1, notional: 100, fee: 0.1, status: "filled" };
    l.importRecords([
      { ...base, id: `${SUB}|0xa5|history`, subaccount: SUB, orderDigest: "0xa5", walletId: "W1", side: "sell", price: 100, realizedPnl: 0, ts: 30 },
      { ...base, id: `${SUB2}|0xb5|history`, subaccount: SUB2, orderDigest: "0xb5", walletId: "W2", side: "buy", price: 100, realizedPnl: 0, ts: 31 },
    ]);
    expect(l.records.every((r) => r.selfCross === true)).toBe(true);
  });
});

describe("AccountingLedger 历史回补（官方 indexer）", () => {
  it("补全 product → market、subaccount → 钱包，并采用官方盈亏", () => {
    const l = ledger();
    const rec: AccountingRecord = {
      id: `${SUB}|0xd9|history`,
      subaccount: SUB,
      orderDigest: "0xd9",
      walletId: SUB.slice(0, 10),
      market: "product:#2",
      side: "sell",
      price: 110,
      size: 1,
      notional: 110,
      fee: 0.07,
      realizedPnl: 10,
      status: "filled",
      ts: 20,
    };
    expect(l.importRecords([rec])).toBe(1);
    expect(l.records[0]).toMatchObject({ market: "nado:perp:BTC-PERP", walletId: "W1", realizedPnl: 10 });
  });

  it("历史订单缺 taker 标记时按手续费率反推（maker≈0.01% / taker≈0.035%）", () => {
    const l = ledger();
    const base = { subaccount: SUB, walletId: "W1", market: "nado:perp:BTC-PERP", side: "sell" as const, price: 100, size: 1, notional: 100, status: "filled" };
    l.importRecords([
      { ...base, id: `${SUB}|0xm|history`, orderDigest: "0xm", fee: 0.01, realizedPnl: 0, ts: 5 },
      { ...base, id: `${SUB}|0xt|history`, orderDigest: "0xt", fee: 0.035, realizedPnl: 0, ts: 6 },
    ]);
    expect(l.records.find((r) => r.orderDigest === "0xm")!.taker).toBe(false);
    expect(l.records.find((r) => r.orderDigest === "0xt")!.taker).toBe(true);
  });

  it("同一订单的 WS 成交随后到达时不再重复入账", () => {
    const l = ledger();
    l.importRecords([{ id: `${SUB}|0xdz|history`, subaccount: SUB, orderDigest: "0xdz", walletId: "W1", market: "nado:perp:BTC-PERP", side: "buy", price: 100, size: 1, notional: 100, fee: 0.1, realizedPnl: 0, status: "filled", ts: 1 }]);
    expect(l.record(frame({ order_digest: "0xdz" }), 2)).toBeNull();
    expect(l.records).toHaveLength(1);
  });
});
