"use client";

// =============================================================================
// 单个钱包的「Nado 注册状态」检查（浏览器端）。
// 从保险库取出该钱包的私钥（仅内存）-> 交给本地 worker 无头登录官网 ->
// worker 先接受条款弹窗（浏览器本地状态），再看是否仍出现「设置用户名」引导，
// 出现 = 该钱包尚未完成注册。
//
// 结果由后端登记表按地址保存（.nado-registry.json），刷新页面后仍可一一对应。
// =============================================================================
import { exportEvmPrivateKeys } from "./custody";
import type { ExportedEvmKey } from "./custody";
import { checkStateFromEntry } from "./nadoRegistryModel";
import type { NadoRegistryEntry, WalletCheckState } from "./nadoRegistryModel";
import type { NadoLoginJobView } from "./nadoLoginTypes";

export type { WalletCheckState } from "./nadoRegistryModel";

const POLL_MS = 1_500;
const TIMEOUT_MS = 150_000;
const MAX_CONCURRENT = 2; // 每个检查都会起一个无头 Chrome，限制并发避免一次性点太多把内存打满

let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
}
function release(): void {
  const next = waiters.shift();
  if (next) next(); // 名额直接移交给排队者，active 不变
  else active--;
}

/** 读取后端已保存的全部结果，按小写地址索引（用于页面加载时回填）。 */
export async function loadStoredChecks(): Promise<Record<string, WalletCheckState>> {
  try {
    const res = await fetch("/api/nado/registry", { cache: "no-store" });
    if (!res.ok) return {};
    const body = (await res.json()) as { entries?: NadoRegistryEntry[] };
    const out: Record<string, WalletCheckState> = {};
    for (const entry of body.entries ?? []) {
      const state = checkStateFromEntry(entry);
      if (state) out[entry.address.toLowerCase()] = state;
    }
    return out;
  } catch {
    return {};
  }
}

/** 检查一个钱包是否已完成 Nado 注册；返回后端登记后的最终状态。 */
export async function checkWalletRegistration(accountSlug: string, address: string): Promise<WalletCheckState> {
  let key;
  try {
    // 按地址匹配，避免多账户时用错序号
    key = exportEvmPrivateKeys(accountSlug).find((k) => k.address.toLowerCase() === address.toLowerCase());
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  if (!key) return { status: "failed", error: "保险库里找不到该钱包的私钥" };

  await acquire();
  try {
    return await runCheck(key, accountSlug);
  } finally {
    release();
  }
}

async function runCheck(key: ExportedEvmKey, accountSlug: string): Promise<WalletCheckState> {
  const res = await fetch("/api/nado/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallets: [key], mode: "check", accountSlug }),
  });
  const started = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
  if (!res.ok || !started.jobId) {
    return { status: "failed", error: started.error ?? `启动检查失败 (${res.status})` };
  }

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const poll = await fetch(`/api/nado/login?jobId=${started.jobId}`, { cache: "no-store" });
      if (!poll.ok) continue;
      const job = (await poll.json()) as NadoLoginJobView;
      if (job.status === "running") continue;
      const row = job.results[0];
      if (!row) return { status: "failed", error: "任务没有返回结果" };
      if (row.status !== "ok") return { status: "failed", error: row.error ?? "检查失败" };
      // 优先用后端登记表里的结果（写入是异步的，短暂重试一下）
      const stored = await readStoredEntry(key.address);
      return checkStateFromEntry(stored)
        ?? (row.registered ? { status: "registered" } : { status: "unregistered" });
    } catch { /* 网络抖动时继续下一轮 */ }
  }
  return { status: "failed", error: "检查超时" };
}

/** 读取单个钱包在登记表中的最新状态（等后端把结果写完，最多重试 3 次）。 */
export async function readStoredCheck(address: string): Promise<WalletCheckState | undefined> {
  return checkStateFromEntry(await readStoredEntry(address));
}

/** 读取单个钱包在登记表中的记录（最多重试 3 次，等后端把结果写完）。 */
async function readStoredEntry(address: string): Promise<NadoRegistryEntry | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`/api/nado/registry?address=${address}`, { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { entry?: NadoRegistryEntry | null };
        if (body.entry) return body.entry;
      }
    } catch { /* 忽略单次失败 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}
