// =============================================================================
// 单条策略信号：查询 / 领取 / 回写结果（仅本机可访问）。
//
//   GET   /api/strategy/signal/{id}                 查看一条信号
//   PATCH /api/strategy/signal/{id} {"action":"claim"}                 领取（返回 claimToken）
//   PATCH /api/strategy/signal/{id} {"action":"result","token":"…",
//          "status":"done"|"error","error":"…","order":{"digest":"…"}}  回写执行结果
//
// 领取后再执行是为了保证同一信号只会被一个标签页处理；领取方崩溃时租约到期会自动放回队列。
// =============================================================================
import { NextResponse } from "next/server";
import { authorizeSignalConsumer } from "../../../../lib/strategyAuth";
import { claimSignal, finishSignal, getSignal, publicSignal } from "../../../../lib/strategySignals";
import type { SignalOrderEcho, StrategyExecution } from "../../../../lib/strategySignalModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const auth = authorizeSignalConsumer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  const signal = getSignal(id);
  if (!signal) return NextResponse.json({ error: "信号不存在或已过期" }, { status: 404 });
  return NextResponse.json({ signal: publicSignal(signal) });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = authorizeSignalConsumer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | {
        action?: string; token?: string; status?: string; error?: string;
        order?: SignalOrderEcho;
        execution?: StrategyExecution;
      }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }

  if (body.action === "claim") {
    const res = claimSignal(id);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.code });
    // claimToken 只回给领取方，后续 GET 不会暴露
    return NextResponse.json({ signal: publicSignal(res.signal), claimToken: res.token });
  }

  if (body.action === "result") {
    if (body.status !== "done" && body.status !== "error") {
      return NextResponse.json({ error: "status 只能是 done 或 error" }, { status: 400 });
    }
    if (typeof body.token !== "string" || !body.token) {
      return NextResponse.json({ error: "缺少领取凭证 token" }, { status: 400 });
    }
    const res = finishSignal(id, body.token, {
      status: body.status,
      error: typeof body.error === "string" ? body.error.slice(0, 300) : undefined,
      order: body.order,
      execution: body.execution,
    });
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.code });
    return NextResponse.json({ signal: publicSignal(res.signal) });
  }

  return NextResponse.json({ error: "action 只能是 claim 或 result" }, { status: 400 });
}
