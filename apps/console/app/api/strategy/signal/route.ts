// =============================================================================
// 外部交易信号接口（仅本机可访问）。
//
//   POST /api/strategy/signal          提交一条信号（幂等：相同 clientId 只建一条）
//   GET  /api/strategy/signal?status=pending&limit=20   查询队列
//
// 服务端只做校验与排队，不持有私钥、不签名；真正的下单由已打开的终端标签页
// 领取后在浏览器内核签完成。字段说明见 lib/strategySignalModel.ts。
// 若设置了 STRATEGY_SIGNAL_TOKEN，POST 需要带 x-strategy-token。
// =============================================================================
import { NextResponse } from "next/server";
import { authorizeSignalConsumer, authorizeSignalProducer } from "../../../lib/strategyAuth";
import { parseSignal } from "../../../lib/strategySignalModel";
import type { SignalStatus } from "../../../lib/strategySignalModel";
import { createSignal, getSignalByClientId, listSignals, publicSignal } from "../../../lib/strategySignals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES: SignalStatus[] = ["pending", "claimed", "done", "error", "expired"];

export async function POST(req: Request) {
  const auth = authorizeSignalProducer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const raw = await req.json().catch(() => null);
  const parsed = parseSignal(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { signal, created } = createSignal(parsed.value);
  // 202 = 已入队等待终端执行；200 = 相同 clientId 的重复提交（返回原信号）
  return NextResponse.json(
    { signal: publicSignal(signal), created },
    { status: created ? 202 : 200 },
  );
}

export async function GET(req: Request) {
  const auth = authorizeSignalConsumer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  // 按 clientId 精确回查：外部策略用它拿执行结果（例如条件单 digest）
  const clientId = (url.searchParams.get("clientId") ?? "").trim();
  if (clientId) {
    const signal = getSignalByClientId(clientId);
    return NextResponse.json({ signal: signal ? publicSignal(signal) : null });
  }
  const statusRaw = url.searchParams.get("status");
  const status = STATUSES.find((s) => s === statusRaw);
  const limitRaw = Number(url.searchParams.get("limit") ?? 20);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20));
  return NextResponse.json({
    signals: listSignals(status, limit).map(publicSignal),
  });
}
