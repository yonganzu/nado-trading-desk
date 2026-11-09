import { describe, expect, it } from "vitest";
import { parseSignal } from "./strategySignalModel";

const WALLET = "0x1234567890AbCdEf1234567890aBcDeF12345678";

const base = {
  wallet: WALLET,
  market: "BTC-USD",
  side: "buy",
  kind: "limit",
  size: "0.01",
  price: "60000",
};

describe("parseSignal 校验与归一化", () => {
  it("接受合法的限价信号，并把地址转成小写", () => {
    const res = parseSignal(base);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.wallet).toBe(WALLET.toLowerCase());
    expect(res.value.side).toBe("buy");
    expect(res.value.kind).toBe("limit");
    expect(res.value.size).toBe("0.01");
    expect(res.value.price).toBe("60000");
    expect(res.value.reduceOnly).toBe(false);
  });

  it("市价信号允许不带 price", () => {
    const res = parseSignal({ ...base, kind: "market", price: undefined });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kind).toBe("market");
    expect(res.value.price).toBeUndefined();
  });

  it("限价信号缺少 price 时拒绝", () => {
    const res = parseSignal({ ...base, price: undefined });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("price");
  });

  it("side 只接受 buy / sell", () => {
    expect(parseSignal({ ...base, side: "long" }).ok).toBe(false);
    expect(parseSignal({ ...base, side: "SELL" }).ok).toBe(true);
  });

  it("钱包地址必须是 0x 开头的 40 位十六进制", () => {
    expect(parseSignal({ ...base, wallet: "0x123" }).ok).toBe(false);
    expect(parseSignal({ ...base, wallet: "1234567890abcdef1234567890abcdef12345678" }).ok).toBe(false);
  });

  it("size 必须是大于 0 的数字", () => {
    expect(parseSignal({ ...base, size: "0" }).ok).toBe(false);
    expect(parseSignal({ ...base, size: "-1" }).ok).toBe(false);
    expect(parseSignal({ ...base, size: "abc" }).ok).toBe(false);
    expect(parseSignal({ ...base, size: 0.5 }).ok).toBe(true);
  });

  it("clientId 限制字符集与长度", () => {
    expect(parseSignal({ ...base, clientId: "abc-123" }).ok).toBe(true);
    expect(parseSignal({ ...base, clientId: "含中文" }).ok).toBe(false);
    expect(parseSignal({ ...base, clientId: "a".repeat(65) }).ok).toBe(false);
  });

  it("reduceOnly 支持布尔与字符串真值", () => {
    const a = parseSignal({ ...base, reduceOnly: true });
    const b = parseSignal({ ...base, reduceOnly: "true" });
    expect(a.ok && a.value.reduceOnly).toBe(true);
    expect(b.ok && b.value.reduceOnly).toBe(true);
  });

  it("market 必填且有长度上限", () => {
    expect(parseSignal({ ...base, market: "" }).ok).toBe(false);
    expect(parseSignal({ ...base, market: "M".repeat(65) }).ok).toBe(false);
  });

  it("请求体必须是对象", () => {
    expect(parseSignal(null).ok).toBe(false);
    expect(parseSignal([]).ok).toBe(false);
    expect(parseSignal("{}").ok).toBe(false);
  });
});

describe("parseSignal 条件单与按 digest 撤单", () => {
  const trigger = {
    ...base,
    kind: "trigger",
    price: "59000",
    triggerPrice: "59500",
    triggerType: "last_price_below",
    reduceOnly: true,
  };
  const DIGEST = "0x" + "ab".repeat(32);

  it("接受合法的条件单信号，保留触发价与触发类型", () => {
    const res = parseSignal(trigger);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kind).toBe("trigger");
    expect(res.value.triggerType).toBe("last_price_below");
    expect(res.value.triggerPrice).toBe("59500");
    expect(res.value.price).toBe("59000");
    expect(res.value.reduceOnly).toBe(true);
  });

  it("条件单必须有 triggerPrice 与 price", () => {
    expect(parseSignal({ ...trigger, triggerPrice: undefined }).ok).toBe(false);
    expect(parseSignal({ ...trigger, price: undefined }).ok).toBe(false);
  });

  it("triggerType 限定为 last / mid / oracle 的上穿下穿", () => {
    expect(parseSignal({ ...trigger, triggerType: "price_below" }).ok).toBe(false);
    expect(parseSignal({ ...trigger, triggerType: "mid_price_above" }).ok).toBe(true);
    expect(parseSignal({ ...trigger, triggerType: "oracle_price_below" }).ok).toBe(true);
  });

  it("digest 只能配 action=cancel，且必须是 32 字节十六进制", () => {
    const ok = parseSignal({ ...base, action: "cancel", digest: DIGEST });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.digest).toBe(DIGEST);

    // 撤条件单不需要 price，但这里保留 base.price 也能通过；格式错误一律拒绝
    expect(parseSignal({ ...base, action: "cancel", digest: "0x1234" }).ok).toBe(false);
    expect(parseSignal({ ...base, digest: DIGEST }).ok).toBe(false);
  });

  it("kind 只接受 limit / market / trigger", () => {
    expect(parseSignal({ ...base, kind: "stop" }).ok).toBe(false);
    expect(parseSignal({ ...base, kind: "MARKET" }).ok).toBe(true);
  });
});
