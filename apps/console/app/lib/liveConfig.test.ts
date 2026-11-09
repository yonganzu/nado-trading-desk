import { describe, expect, it } from "vitest";
import { productFor } from "./liveConfig";
import type { LiveConfig, LiveProductVM } from "./liveConfig";

const BTC: LiveProductVM = {
  marketId: "nado:perp:BTC-PERP", productId: 2, symbol: "BTC-PERP", kind: "perp",
  tickSize: "1", stepSize: "0.0001", minSize: "0.0001",
};
const SPCX: LiveProductVM = {
  marketId: "nado:perp:SPCX-PERP", productId: 140, symbol: "SPCX-PERP", kind: "perp",
  tickSize: "0.01", stepSize: "0.005", minSize: "0.005",
};
const cfg: LiveConfig = { enabled: true, defaultProduct: BTC, products: [BTC, SPCX] };

describe("productFor 按信号品种取产品", () => {
  it("精确 marketId 命中对应品种，而不是默认品种", () => {
    expect(productFor(cfg, "nado:perp:SPCX-PERP")?.productId).toBe(140);
  });

  it("接受 symbol（大小写不敏感）与纯数字 productId", () => {
    expect(productFor(cfg, "spcx-perp")?.productId).toBe(140);
    expect(productFor(cfg, "140")?.productId).toBe(140);
  });

  it("参数里的尾部 symbol（如 perp:SPCX-PERP）也能命中", () => {
    expect(productFor(cfg, "perp:SPCX-PERP")?.productId).toBe(140);
  });

  it("指定了品种却查不到时返回 undefined，绝不静默回退到 defaultProduct", () => {
    expect(productFor(cfg, "nado:perp:NOPE-PERP")).toBeUndefined();
  });

  it("完全没传品种（页面手动下单）才用默认品种", () => {
    expect(productFor(cfg, undefined)?.productId).toBe(2);
    expect(productFor(cfg, "")?.productId).toBe(2);
  });
});
