import { describe, expect, it } from "vitest";
import { buildCatalog, CATEGORY_ORDER } from "./nadoCatalog";
import type { NadoSymbolRaw } from "./nadoCatalog";

// 面板只做股票 + 加密货币：大宗商品期货（WTI/XAUT）与外汇不应该再下发到切换器
const RAW: Record<string, NadoSymbolRaw> = {
  "2": { product_id: 2, symbol: "BTC-PERP", trading_status: "live" },
  "3": { product_id: 3, symbol: "ETH-PERP", trading_status: "live" },
  "5": { product_id: 5, symbol: "WTI-PERP", trading_status: "live" },
  "7": { product_id: 7, symbol: "XAUT-PERP", trading_status: "live" },
  "9": { product_id: 9, symbol: "EURUSD-PERP", trading_status: "live" },
  "140": {
    product_id: 140, symbol: "SPCX-PERP", trading_status: "live",
    market_hours: { is_open: true },
  },
};

const items = buildCatalog(RAW, {}, {});

describe("buildCatalog 的资产类别过滤", () => {
  it("保留加密货币与股票", () => {
    const symbols = items.map((x) => x.symbol).sort();
    expect(symbols).toEqual(["BTC-PERP", "ETH-PERP", "SPCX-PERP"]);
  });

  it("剔除大宗商品与外汇", () => {
    const categories = new Set(items.map((x) => x.category));
    expect(categories.has("commodity")).toBe(false);
    expect(categories.has("forex")).toBe(false);
  });

  it("分类 Tab 顺序只剩加密货币、股票", () => {
    expect(CATEGORY_ORDER).toEqual(["crypto", "stock"]);
  });
});
