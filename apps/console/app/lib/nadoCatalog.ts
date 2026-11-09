// =============================================================================
// Nado 永续品种目录（品种切换器用）。
//
// 数据来源（服务端代理，见 app/api/nado/catalog/route.ts）：
//   • GET  /archive/v2/symbols?product_type=perp —— 规格 + 手续费 + 交易状态 + maker 倍数
//   • POST /archive/v1  market_snapshots        —— cumulative_volumes 两帧相减 = 24h 名义成交额
//
// 分类规则（数据里没有 asset_class 字段，只能按 ticker 归类）：
//   • 外汇：六位货币对（USDJPY / EURUSD …）
//   • 大宗商品：显式名单（WTI / XAG / XAUT …）
//   • 股票：显式名单 + 任何带 market_hours（有开盘收盘时段）的品种
//   • 其余：加密货币
// 面板只做「股票 + 加密货币」：上面两类仍在代码里保留归类能力，
// 但在 buildCatalog 输出前被过滤，不会出现在品种切换器里。
// =============================================================================

export type NadoCategory = "crypto" | "stock" | "commodity" | "forex";

/** 品种目录项：前端选择器直接渲染这个结构。 */
export interface NadoCatalogItem {
  symbol: string;
  productId: number;
  category: NadoCategory;
  /** true = maker 有倍数奖励（Nado 的 boosted 产品） */
  boosted: boolean;
  /** maker 奖励倍数（无倍数 = 1） */
  makerMultiplier: number;
  /** taker 奖励倍数（当前全为 0） */
  takerMultiplier: number;
  /** 基础挂单手续费（bps，maker 奖励前的费率） */
  makerFeeBps: number;
  /** 基础吃单手续费（bps） */
  takerFeeBps: number;
  /** live / post_only / not_tradable */
  tradingStatus: string;
  /** null = 7×24 一直可交易；true/false = 有交易时段的品种当前是否开盘 */
  marketOpen: boolean | null;
  nextOpen: string | null;
  nextClose: string | null;
  /** 24h 名义成交额（USDT） */
  volume24h: number;
  /** 最新 oracle 价（仅展示，可能为 0） */
  price: number;
}

/** /archive/v2/symbols 返回的单条（只列我们用到的字段）。 */
export interface NadoSymbolRaw {
  product_id: number;
  symbol: string;
  price_increment_x18?: string;
  size_increment?: string;
  min_size?: string;
  maker_fee_rate_x18?: string;
  taker_fee_rate_x18?: string;
  trading_status?: string;
  market_hours?: { is_open?: boolean; next_open?: string; next_close?: string } | null;
  boost_type?: number;
  maker_multiplier?: number;
  taker_multiplier?: number;
}

export const CATEGORY_LABELS: Record<NadoCategory, string> = {
  crypto: "加密货币",
  stock: "股票",
  commodity: "大宗商品",
  forex: "外汇",
};

/** 标签顺序：切换器 Tab 的顺序（maker 倍数单独做一类，见 BOOST_TAB）。
 *  只保留股票与加密货币：大宗商品（WTI/XAUT…）和外汇不再出现在面板里。 */
export const CATEGORY_ORDER: NadoCategory[] = ["crypto", "stock"];

/** 面板允许展示的类别；其余类别（大宗商品 / 外汇）在 buildCatalog 阶段就被过滤掉。 */
const PANEL_CATEGORIES = new Set<NadoCategory>(["crypto", "stock"]);

const FOREX = new Set([
  "USDJPY", "GBPUSD", "EURUSD", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDCNH",
  "EURJPY", "GBPJPY", "EURGBP", "AUDJPY", "CADJPY", "CHFJPY",
]);

const COMMODITY = new Set([
  "WTI", "BRENT", "NATGAS", "COPPER", "ALUMINUM", "NICKEL", "ZINC",
  "XAU", "XAG", "XAUT", "PAXG", "GOLD", "SILVER", "PLATINUM", "PALLADIUM", "XPT", "XPD",
  "CORN", "WHEAT", "SOYBEAN", "COFFEE", "SUGAR", "COCOA", "COTTON",
]);

const STOCK = new Set([
  "AAPL", "AMD", "AMZN", "AVGO", "BBX", "CRCL", "DELL", "GOOGL", "HIMS", "INTC",
  "LLY", "META", "MRVL", "MSFT", "MSTR", "MU", "NBIS", "NVDA", "ORCL", "PENG",
  "QQQ", "SKHY", "SNDK", "SPCX", "SPY", "TSLA", "ZHIPU",
]);

/** 按 ticker 归类；带交易时段的未知标的按股票处理（不是加密才会被安排开盘时间）。 */
export function categoryOf(symbol: string, hasMarketHours: boolean): NadoCategory {
  const base = symbol.replace(/-PERP$/i, "").toUpperCase();
  if (FOREX.has(base)) return "forex";
  if (COMMODITY.has(base)) return "commodity";
  if (STOCK.has(base) || hasMarketHours) return "stock";
  return "crypto";
}

const x18 = (v: string | number | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n / 1e18 : 0;
};
const bps = (v: string | number | undefined): number => {
  const n = x18(v);
  return Number.isFinite(n) ? Math.round(n * 10000 * 100) / 100 : 0;
};

/**
 * 合并 symbols 与成交量，输出按 24h 成交额倒序的目录。
 * volumeByProduct / priceByProduct 的 key 是 product_id 字符串。
 */
export function buildCatalog(
  symbols: Record<string, NadoSymbolRaw>,
  volumeByProduct: Record<string, number>,
  priceByProduct: Record<string, number>,
): NadoCatalogItem[] {
  const items: NadoCatalogItem[] = [];
  for (const raw of Object.values(symbols)) {
    if (!raw || !raw.symbol || !Number.isInteger(Number(raw.product_id))) continue;
    const pid = String(raw.product_id);
    const makerMultiplier = Number(raw.maker_multiplier) || 1;
    const takerMultiplier = Number(raw.taker_multiplier) || 0;
    const mh = raw.market_hours ?? null;
    const category = categoryOf(String(raw.symbol), mh != null);
    // 面板只做股票 + 加密货币：大宗商品期货与外汇不下发到前端
    if (!PANEL_CATEGORIES.has(category)) continue;
    items.push({
      symbol: String(raw.symbol).toUpperCase(),
      productId: Number(raw.product_id),
      category,
      boosted: Number(raw.boost_type) > 0,
      makerMultiplier,
      takerMultiplier,
      makerFeeBps: bps(raw.maker_fee_rate_x18),
      takerFeeBps: bps(raw.taker_fee_rate_x18),
      tradingStatus: String(raw.trading_status || "live"),
      marketOpen: mh ? mh.is_open === true : null,
      nextOpen: mh?.next_open ?? null,
      nextClose: mh?.next_close ?? null,
      volume24h: Math.max(0, Number(volumeByProduct[pid]) || 0),
      price: Number(priceByProduct[pid]) || 0,
    });
  }
  // 成交额倒序；同额按 symbol 字母序，保证刷新后顺序稳定
  items.sort((a, b) => b.volume24h - a.volume24h || a.symbol.localeCompare(b.symbol));
  return items;
}

/** 成交量帧（archive/v1 的 market_snapshots）→ 24h 名义成交额（product_id → USDT）。 */
export function volumeFromSnapshots(
  snapshots: Array<{ timestamp?: number; cumulative_volumes?: Record<string, string> }> | undefined,
): Record<string, number> {
  const frames = (snapshots ?? []).filter((f) => f && f.cumulative_volumes);
  if (frames.length < 2) return {};
  // 归档返回是按时间倒序的，先排出"最早 → 最新"
  const sorted = [...frames].sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
  const firstFrame = sorted[0];
  const lastFrame = sorted[sorted.length - 1];
  if (!firstFrame || !lastFrame) return {};
  const first = firstFrame.cumulative_volumes ?? {};
  const last = lastFrame.cumulative_volumes ?? {};
  const out: Record<string, number> = {};
  for (const [pid, v] of Object.entries(last)) {
    out[pid] = Math.max(0, x18(v) - x18(first[pid]));
  }
  return out;
}

/** 最新一帧里的 oracle 价（product_id → 价格）。 */
export function priceFromSnapshots(
  snapshots: Array<{ timestamp?: number; oracle_prices?: Record<string, string> }> | undefined,
): Record<string, number> {
  const sorted = [...(snapshots ?? [])].sort(
    (a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0),
  );
  const last = sorted[sorted.length - 1]?.oracle_prices ?? {};
  const out: Record<string, number> = {};
  for (const [pid, v] of Object.entries(last)) out[pid] = x18(v);
  return out;
}

/** 24h 成交额的紧凑显示：1.2 亿 / 8600 万 / 45.3 万。 */
export function formatVolume(usdt: number): string {
  if (!(usdt > 0)) return "—";
  if (usdt >= 1e8) return `${(usdt / 1e8).toFixed(2)} 亿`;
  if (usdt >= 1e4) return `${(usdt / 1e4).toFixed(1)} 万`;
  return usdt.toFixed(0);
}
