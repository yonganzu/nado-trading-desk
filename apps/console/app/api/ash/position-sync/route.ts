// =============================================================================
// /api/ash/position-sync — 把执行钱包在 Nado 的真实仓位同步给 ASH。
//
// 推送方是已解锁的控制台标签页（拿到的是浏览器内的实时仓位），Token 由服务端代加，
// 浏览器不接触 ASH 的管理凭证。ASH 只用这份快照校验/纠偏，不会因此下单。
// 只允许本机访问。
// =============================================================================
import { NextResponse } from "next/server";
import { isLocalRequest } from "../../../lib/localRequest";
import { ashPost } from "../../../lib/ashClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_POSITIONS = 50;
const MAX_TEXT = 64;

interface RawPosition {
  market?: unknown;
  side?: unknown;
  size?: unknown;
  entryPrice?: unknown;
}

/** 只保留 ASH 需要的字段，顺手挡住明显的坏数据。 */
function normalizePositions(value: unknown): Array<{ market: string; side: string; size: string; entryPrice: string }> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_POSITIONS) return null;
  const out: Array<{ market: string; side: string; size: string; entryPrice: string }> = [];
  for (const item of value as RawPosition[]) {
    if (!item || typeof item !== "object") return null;
    const market = typeof item.market === "string" ? item.market.trim() : "";
    const side = typeof item.side === "string" ? item.side.trim().toLowerCase() : "";
    const size = Number(item.size);
    const entryPrice = Number(item.entryPrice);
    if (!market || market.length > MAX_TEXT) return null;
    if (side !== "long" && side !== "short" && side !== "flat") return null;
    if (!Number.isFinite(size) || size < 0) return null;
    out.push({
      market,
      side,
      size: String(size),
      entryPrice: Number.isFinite(entryPrice) && entryPrice > 0 ? String(entryPrice) : "0",
    });
  }
  return out;
}

export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "only localhost may sync positions" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim().toLowerCase() : "";
  if (wallet && !ADDRESS_RE.test(wallet)) return NextResponse.json({ error: "wallet 格式不正确" }, { status: 400 });

  const positions = normalizePositions(body.positions);
  if (!positions) return NextResponse.json({ error: "positions 格式不正确（最多 50 条）" }, { status: 400 });

  const openOrders = Number(body.openOrders);
  const payload = {
    wallet,
    at: Number(body.at) || Date.now(),
    openOrders: Number.isFinite(openOrders) && openOrders >= 0 ? Math.floor(openOrders) : 0,
    positions,
  };

  try {
    const result = await ashPost<{ ok?: boolean; error?: string }>("/api/bridge/position", payload);
    if (result?.ok === false) return NextResponse.json({ error: result.error ?? "ASH 拒绝了仓位同步" }, { status: 409 });
    return NextResponse.json({ ok: true, at: payload.at, positions: positions.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
