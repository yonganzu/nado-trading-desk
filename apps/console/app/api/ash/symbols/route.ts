// =============================================================================
// POST /api/ash/symbols — 热切换 ASH 的交易品种（转发到 /api/symbols）。
// ASH 会重新订阅行情并写回 config.json；有未平仓位 / 实盘仍有仓时会拒绝，
// 拒绝原因原样回传，页面直接展示。
// =============================================================================
import { NextResponse } from "next/server";
import { isLocalRequest } from "../../../lib/localRequest";
import { ashPostResult } from "../../../lib/ashClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AshSymbolsReply = { ok?: boolean; symbols?: string[]; error?: string };

export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "only localhost may switch ASH symbols" }, { status: 403 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  try {
    const { status, data } = await ashPostResult<AshSymbolsReply>("/api/symbols", body);
    return NextResponse.json(data, { status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
