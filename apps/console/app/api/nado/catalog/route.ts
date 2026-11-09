// =============================================================================
// GET /api/nado/catalog — Nado 永续品种目录（品种切换器用）。
//
// 为什么放服务端：archive 网关对压缩头敏感（不带来 accept-encoding 会 403），
// 且浏览器直连有 CORS 限制。这里合并两份公开数据后按 24h 成交额倒序返回：
//   • /archive/v2/symbols?product_type=perp（规格 / 手续费 / maker 倍数 / 交易状态）
//   • /archive/v1 的 market_snapshots（cumulative_volumes 两帧相减 = 24h 成交额）
// 目录变动很慢，模块级缓存 60 秒，避免每次开页面都打一次网关。
// =============================================================================
import { NextResponse } from "next/server";
import { isLocalRequest } from "../../../lib/localRequest";
import { buildCatalog, priceFromSnapshots, volumeFromSnapshots } from "../../../lib/nadoCatalog";
import type { NadoCatalogItem, NadoSymbolRaw } from "../../../lib/nadoCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_BASE = "https://api.prod.nado.xyz";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;

/** archive 地址：默认主网，可用 NADO_ARCHIVE_BASE 覆盖（测试网）。 */
function archiveBase(): string {
  return (process.env.NADO_ARCHIVE_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");
}

// WAF 要求带压缩协商头，否则直接 403 "Invalid compression headers"
const HEADERS = { "content-type": "application/json", "accept-encoding": "gzip, br, deflate" };

let cache: { at: number; items: NadoCatalogItem[] } | null = null;
let inflight: Promise<NadoCatalogItem[]> | null = null;

async function fetchCatalog(): Promise<NadoCatalogItem[]> {
  const base = archiveBase();
  const [symRes, snapRes] = await Promise.all([
    fetch(`${base}/archive/v2/symbols?product_type=perp`, {
      headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
    fetch(`${base}/archive/v1`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ market_snapshots: { interval: { count: 2, granularity: 86400 } } }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  ]);
  if (!symRes.ok) throw new Error(`Nado 品种列表返回 HTTP ${symRes.status}`);
  if (!snapRes.ok) throw new Error(`Nado 行情快照返回 HTTP ${snapRes.status}`);

  const symbols = (await symRes.json()) as Record<string, NadoSymbolRaw>;
  const snap = (await snapRes.json()) as {
    snapshots?: Array<{ timestamp?: number; cumulative_volumes?: Record<string, string>; oracle_prices?: Record<string, string> }>;
  };
  return buildCatalog(symbols, volumeFromSnapshots(snap.snapshots), priceFromSnapshots(snap.snapshots));
}

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "only localhost may read the catalog" }, { status: 403 });
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json({ fetchedAt: cache.at, cached: true, items: cache.items });
  }
  try {
    // 并发请求合并成一次上游拉取
    inflight ??= fetchCatalog().finally(() => { inflight = null; });
    const items = await inflight;
    cache = { at: Date.now(), items };
    return NextResponse.json({ fetchedAt: cache.at, cached: false, items });
  } catch (e) {
    // 上游失败时退回旧缓存（有的话），让页面仍可操作
    if (cache) return NextResponse.json({ fetchedAt: cache.at, cached: true, stale: true, items: cache.items });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
