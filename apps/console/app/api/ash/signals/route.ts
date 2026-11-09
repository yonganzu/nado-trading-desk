// =============================================================================
// /api/ash/signals — ASH 交易终端的只读快照（状态 / 计划 / 成交 / 事件 / 仓位盈亏）。
// 服务端代读 ASH 的管理 Token，浏览器永远拿不到它。只允许本机访问。
// 五个子请求并行，任一失败只体现在 errors 里，不会让整页空白。
// =============================================================================
import { NextResponse } from "next/server";
import { isLocalRequest } from "../../../lib/localRequest";
import { ashBase, ashGet } from "../../../lib/ashClient";
import type {
  AshExecution, AshJournalEvent, AshPlan, AshPositionPnl, AshSnapshot, AshStatus,
} from "../../../lib/ashTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function value<T>(r: PromiseSettledResult<T>): T | undefined {
  return r.status === "fulfilled" ? r.value : undefined;
}

function reason(r: PromiseSettledResult<unknown>): string {
  if (r.status === "fulfilled") return "";
  return r.reason instanceof Error ? r.reason.message : String(r.reason);
}

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "only localhost may read ASH" }, { status: 403 });

  const [status, plans, executions, journal, positionPnl] = await Promise.allSettled([
    ashGet<AshStatus>("/api/status"),
    ashGet<{ plans?: AshPlan[] }>("/api/plans"),
    ashGet<{ executions?: AshExecution[] }>("/api/executions"),
    ashGet<{ events?: AshJournalEvent[] }>("/api/journal"),
    ashGet<{ records?: AshPositionPnl[] }>("/api/position-pnl"),
  ]);

  const errors: Record<string, string> = {};
  for (const [name, r] of [
    ["status", status], ["plans", plans], ["executions", executions],
    ["journal", journal], ["positionPnl", positionPnl],
  ] as const) {
    if (r.status === "rejected") errors[name] = reason(r);
  }

  const body: AshSnapshot = {
    ok: Object.keys(errors).length === 0,
    base: ashBase(),
    fetchedAt: Date.now(),
    status: value(status),
    plans: value(plans)?.plans,
    executions: value(executions)?.executions,
    journal: value(journal)?.events,
    positionPnl: value(positionPnl)?.records,
    errors: Object.keys(errors).length ? errors : undefined,
  };
  return NextResponse.json(body);
}
