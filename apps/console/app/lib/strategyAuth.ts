// =============================================================================
// 策略信号接口的访问控制。
//
// - 所有接口只允许本机回环地址（外部机器即使能访问端口也拿不到）。
// - 提交信号额外支持 STRATEGY_SIGNAL_TOKEN：设置后必须带 x-strategy-token
//   （或 Authorization: Bearer <token>），方便和其它代理 / 脚本区分。
//   浏览器标签页只做消费（查询 / 领取 / 回写），不受 token 限制。
// =============================================================================
import { isLocalRequest } from "./localRequest";

export type AuthResult = { ok: true } | { ok: false; status: 403 | 401; error: string };

/** 外部策略提交通道：回环地址 + 可选 token。 */
export function authorizeSignalProducer(req: Request): AuthResult {
  if (!isLocalRequest(req)) return { ok: false, status: 403, error: "仅允许本机访问" };
  const expected = process.env.STRATEGY_SIGNAL_TOKEN;
  if (!expected) return { ok: true };
  const header = req.headers.get("x-strategy-token") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (header === expected || bearer === expected) return { ok: true };
  return { ok: false, status: 401, error: "缺少或错误的策略 token（x-strategy-token）" };
}

/** 浏览器消费通道：只校验回环地址。 */
export function authorizeSignalConsumer(req: Request): AuthResult {
  if (!isLocalRequest(req)) return { ok: false, status: 403, error: "仅允许本机访问" };
  return { ok: true };
}
