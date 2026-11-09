// =============================================================================
// 外部交易信号队列（服务端，内存态）。
//
// 生命周期：外部策略 POST → pending → 终端标签页领取（claimed，带 90s 租约）
//          → 标签页内签名下单 → 回写 done / error。
// 与其它本地任务一致，队列本身不落盘：重启 dev 服务后未执行的信号会丢失，
// 但已提交的订单在 sequencer / 链上，不受影响。
// =============================================================================
import { randomUUID } from "node:crypto";
import type { NormalizedSignal, SignalOrderEcho, SignalStatus, StrategyExecution, StrategySignal } from "./strategySignalModel";

const MAX_KEPT = 500;            // 内存里最多保留多少条信号
const PENDING_TTL_MS = 10 * 60_000;  // 超过 10 分钟没人领取 → expired
const CLAIM_LEASE_MS = 90_000;       // 领取租约：标签页崩溃后到点放回队列
const FINISHED_TTL_MS = 30 * 60_000; // 结束后保留 30 分钟供查询
const MAX_ATTEMPTS = 3;

// Next 的每个 route 可能各自打包，模块级 Map 不保证是同一份；挂到 globalThis 上做单例，
// 同时也让 dev 热更新不会把队列清空。重启 dev 服务后才会真正丢失（订单本身在链上）。
interface SignalStore { signals: Map<string, StrategySignal>; byClientId: Map<string, string> }
const globalStore = globalThis as unknown as { __nadoStrategySignalStore?: SignalStore };

function db(): SignalStore {
  if (!globalStore.__nadoStrategySignalStore) {
    globalStore.__nadoStrategySignalStore = { signals: new Map(), byClientId: new Map() };
  }
  return globalStore.__nadoStrategySignalStore;
}

/** 清理超时 / 过期条目；每次读写前调用，避免额外定时器。 */
function sweep(now = Date.now()): void {
  const { signals, byClientId } = db();
  for (const [id, s] of signals) {
    if (s.status === "pending" && now - s.createdAt > PENDING_TTL_MS) {
      s.status = "expired";
      s.error = "信号超时未被终端领取";
      s.finishedAt = now;
      continue;
    }
    // 领取方失联（标签页关闭 / 崩溃）：租约到期后放回队列，超过次数则判失败
    if (s.status === "claimed" && s.claimedAt && now - s.claimedAt > CLAIM_LEASE_MS) {
      if (s.attempts >= MAX_ATTEMPTS) {
        s.status = "error";
        s.error = "多次领取后未回写执行结果";
        s.finishedAt = now;
      } else {
        s.status = "pending";
        s.claimedAt = undefined;
        s.claimToken = undefined;
      }
      continue;
    }
    if (
      (s.status === "done" || s.status === "error" || s.status === "expired") &&
      s.finishedAt && now - s.finishedAt > FINISHED_TTL_MS
    ) {
      signals.delete(id);
      if (s.clientId && byClientId.get(s.clientId) === id) byClientId.delete(s.clientId);
    }
  }
}

/** 超出容量时先淘汰最老的已结束信号（pending / claimed 不动）。 */
function trim(): void {
  const { signals, byClientId } = db();
  if (signals.size <= MAX_KEPT) return;
  const list = [...signals.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const s of list) {
    if (signals.size <= MAX_KEPT) break;
    if (s.status === "pending" || s.status === "claimed") continue;
    signals.delete(s.id);
    if (s.clientId && byClientId.get(s.clientId) === s.id) byClientId.delete(s.clientId);
  }
}

/** 对外展示时去掉领取凭证。 */
export function publicSignal(s: StrategySignal): StrategySignal {
  const { claimToken: _drop, ...rest } = s;
  return rest;
}

export function createSignal(value: NormalizedSignal): { signal: StrategySignal; created: boolean } {
  sweep();
  const { signals, byClientId } = db();
  if (value.clientId) {
    const existingId = byClientId.get(value.clientId);
    const existing = existingId ? signals.get(existingId) : undefined;
    if (existing) return { signal: existing, created: false };
  }
  const signal: StrategySignal = {
    ...value,
    id: randomUUID(),
    status: "pending",
    createdAt: Date.now(),
    attempts: 0,
  };
  signals.set(signal.id, signal);
  if (value.clientId) byClientId.set(value.clientId, signal.id);
  trim();
  return { signal, created: true };
}

export function listSignals(status?: SignalStatus, limit = 20): StrategySignal[] {
  sweep();
  const list = [...db().signals.values()]
    .filter((s) => !status || s.status === status)
    .sort((a, b) => a.createdAt - b.createdAt);
  return list.slice(-limit);
}

export function getSignal(id: string): StrategySignal | undefined {
  sweep();
  return db().signals.get(id);
}

/** 按幂等键（clientId）取信号：外部策略靠它回查执行结果（例如条件单 digest）。 */
export function getSignalByClientId(clientId: string): StrategySignal | undefined {
  sweep();
  const id = db().byClientId.get(clientId);
  return id ? db().signals.get(id) : undefined;
}

export type ClaimResult =
  | { ok: true; signal: StrategySignal; token: string }
  | { ok: false; code: 404 | 409; error: string };

/** 领取一条待执行信号；同一时刻只有一个标签页能拿到（其余返回 409）。 */
export function claimSignal(id: string): ClaimResult {
  sweep();
  const signal = db().signals.get(id);
  if (!signal) return { ok: false, code: 404, error: "信号不存在或已过期" };
  if (signal.status !== "pending") {
    return { ok: false, code: 409, error: `信号当前状态为 ${signal.status}，无法领取` };
  }
  const token = randomUUID();
  signal.status = "claimed";
  signal.claimedAt = Date.now();
  signal.claimToken = token;
  signal.attempts += 1;
  return { ok: true, signal, token };
}

export type FinishResult =
  | { ok: true; signal: StrategySignal }
  | { ok: false; code: 404 | 409; error: string };

/** 回写执行结果（必须带领取时拿到的 token）。 */
export function finishSignal(
  id: string,
  token: string,
  result: {
    status: "done" | "error";
    error?: string;
    order?: SignalOrderEcho;
    execution?: StrategyExecution;
  },
): FinishResult {
  sweep();
  const signal = db().signals.get(id);
  if (!signal) return { ok: false, code: 404, error: "信号不存在或已过期" };
  if (signal.status !== "claimed") {
    return { ok: false, code: 409, error: `信号当前状态为 ${signal.status}，不能回写结果` };
  }
  if (signal.claimToken !== token) {
    return { ok: false, code: 409, error: "领取凭证不匹配（可能已被重新领取）" };
  }
  signal.status = result.status === "done" ? "done" : "error";
  signal.finishedAt = Date.now();
  signal.error = result.status === "error" ? (result.error ?? "执行失败") : undefined;
  signal.order = result.order;
  signal.execution = result.execution;
  signal.claimToken = undefined;
  return { ok: true, signal };
}

/** 仅测试用：清空队列。 */
export function resetSignalsForTest(): void {
  const store = db();
  store.signals.clear();
  store.byClientId.clear();
}
