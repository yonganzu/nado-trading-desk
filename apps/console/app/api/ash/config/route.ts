// =============================================================================
// POST /api/ash/config — 把策略调参改动转发给 ASH（/api/config）。
// ASH 侧做白名单校验并立即生效 + 写回 config.json；这里只转发，不做业务校验。
// 只允许本机访问（ASH 的 Token 不能离开服务端）。ASH 的拒绝原因原样回传。
// =============================================================================
import { NextResponse } from "next/server";
import { isLocalRequest } from "../../../lib/localRequest";
import { ashPostResult } from "../../../lib/ashClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AshConfigReply = { ok?: boolean; tunables?: unknown; symbols?: string[]; error?: string };

export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "only localhost may change ASH config" }, { status: 403 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  try {
    const { status, data } = await ashPostResult<AshConfigReply>("/api/config", body);
    return NextResponse.json(data, { status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
