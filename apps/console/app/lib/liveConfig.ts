// =============================================================================
// KEYLESS live config (client). Fetches the public market/product map + endpoint +
// chainId + ws url from /api/nado/state (which no longer touches any key). This is all
// the browser needs to run the in-tab live path; the COHORT itself comes from in-tab
// custody, not from here. Cached per page load.
// =============================================================================
import type { Market } from "@farm/adapter-api";

export interface LiveProductVM {
  marketId: string; productId: number; symbol: string; kind: "perp" | "spot";
  tickSize: string; stepSize: string; minSize: string;
  minNotional?: string; // HUMAN min order notional (USDT0); absent on offline-mock products
}

export interface LiveConfig {
  enabled: boolean;
  chainId?: number;
  endpoint?: string;
  wsSubscribeUrl?: string;
  defaultProduct?: LiveProductVM;
  markets?: Market[];
  products?: LiveProductVM[];
  error?: string;
}

let cfgP: Promise<LiveConfig> | null = null;

export function getLiveConfig(force = false): Promise<LiveConfig> {
  if (force) cfgP = null;
  if (!cfgP) {
    cfgP = fetch("/api/nado/state", { cache: "no-store" })
      .then((r) => r.json() as Promise<LiveConfig>)
      .catch((e) => { cfgP = null; return { enabled: false, error: e instanceof Error ? e.message : String(e) }; });
  }
  return cfgP;
}

/** 按 marketId / symbol / productId 找品种。
 *
 *  没传品种（页面手动下单用默认品种）时才回退 defaultProduct；
 *  一旦指定了品种却查不到就返回 undefined，由调用方报错——
 *  绝不静默落到 defaultProduct，否则信号说 SPCX 却把单子下到 BTC 上（下错标的）。 */
export function productFor(cfg: LiveConfig, marketId?: string): LiveProductVM | undefined {
  const want = String(marketId ?? "").trim();
  if (!want) return cfg.defaultProduct;
  const list = cfg.products ?? [];
  const exact = list.find((x) => x.marketId === want);
  if (exact) return exact;
  // 兼容外部策略只给 symbol（SPCX-PERP / spcx-perp）或纯数字 productId 的情况
  const lower = want.toLowerCase();
  const bySymbol = list.find((x) => String(x.symbol ?? "").toLowerCase() === lower);
  if (bySymbol) return bySymbol;
  if (/^\d+$/.test(want)) {
    const byId = list.find((x) => Number(x.productId) === Number(want));
    if (byId) return byId;
  }
  // 形如 nado:perp:SPCX-PERP 之外的写法（例如 perp:SPCX-PERP）按尾部 symbol 兜底匹配
  const tail = lower.includes(":") ? lower.slice(lower.lastIndexOf(":") + 1) : "";
  if (tail) {
    const byTail = list.find((x) => String(x.symbol ?? "").toLowerCase() === tail);
    if (byTail) return byTail;
  }
  return undefined;
}
