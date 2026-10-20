"use client";

// =============================================================================
// 首页「一键打开 Nado 官网并登录」（浏览器端）。
// 从保险库取出该钱包的私钥（仅内存）-> 交给本机 Playwright 打开 app.nado.xyz ->
// 完成 Privy 登录（已注册的钱包会直接进入已登录状态）-> 浏览器窗口保留一段时间，
// 便于直接在官网查看登录态 / 下单。私钥不落盘、不写日志。
// =============================================================================
import { exportEvmPrivateKeys } from "./custody";
import type { ExportedEvmKey } from "./custody";
import type { NadoLoginJobView } from "./nadoLoginTypes";

/** 登录成功后浏览器窗口保留的时长（留给用户操作 / 查看登录态）。 */
export const NADO_KEEP_OPEN_MS = 180_000;

const POLL_MS = 1_500;
const TIMEOUT_MS = 150_000;

/** 卡片上「一键打开官网」的状态。 */
export type NadoOpenState =
  | { status: "opening" }
  | { status: "open" }
  | { status: "failed"; error: string };

/** 按地址找出该钱包的私钥，避免多账户 / 多钱包时用错序号。 */
function findKey(accountSlug: string, address: string): ExportedEvmKey {
  const keys = exportEvmPrivateKeys(accountSlug);
  const key = keys.find((k) => k.address.toLowerCase() === address.toLowerCase());
  if (!key) throw new Error("保险库里找不到该钱包的私钥");
  return key;
}

/** 一键打开官网并用该钱包登录；成功时浏览器窗口会保留一段时间。 */
export async function openWalletOnNado(accountSlug: string, address: string): Promise<NadoOpenState> {
  let key: ExportedEvmKey;
  try {
    key = findKey(accountSlug, address);
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }

  try {
    const res = await fetch("/api/nado/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallets: [key], keepOpenMs: NADO_KEEP_OPEN_MS, accountSlug }),
    });
    const started = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
    if (!res.ok || !started.jobId) {
      return { status: "failed", error: started.error ?? `启动失败 (${res.status})` };
    }
    return await waitForJob(started.jobId, key.address);
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/** 轮询任务，直到该钱包出现 ok / failed。
 *  keepOpen 期间任务仍是 running，但结果已经产出，所以看的是单个钱包的结果而不是任务状态。 */
async function waitForJob(jobId: string, address: string): Promise<NadoOpenState> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const res = await fetch(`/api/nado/login?jobId=${jobId}`, { cache: "no-store" });
      if (!res.ok) continue;
      const job = (await res.json()) as NadoLoginJobView;
      const row = job.results.find((r) => r.address.toLowerCase() === address.toLowerCase()) ?? job.results[0];
      if (!row) continue;
      if (row.status === "ok") return { status: "open" };
      if (row.status === "failed") return { status: "failed", error: row.error ?? "登录失败" };
    } catch { /* 网络抖动时继续下一轮 */ }
  }
  return { status: "failed", error: "登录超时" };
}
