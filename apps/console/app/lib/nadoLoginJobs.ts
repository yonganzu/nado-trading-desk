// =============================================================================
// 「官网登录 / 注册」本地任务管理（仅在 Node 服务端运行）。
// 负责：把浏览器传来的钱包凭据（仅内存）通过 stdin 交给 Playwright worker，
// 解析 worker 的 NDJSON 进度，并维护最近若干任务的内存状态供页面轮询。
// 注意：任务对象只保存地址与状态，从不保存私钥。
// =============================================================================
import "server-only";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { recordCheck, recordFailure, recordLogin } from "./nadoRegistry";
import { registryUpdateFor } from "./nadoRegistryModel";

export interface NadoLoginKey { index: number; address: string; privateKey: string }
export type { WalletLoginStatus, WalletLoginResult, NadoLoginJobView } from "./nadoLoginTypes";
import type { WalletLoginResult, WalletLoginStatus } from "./nadoLoginTypes";

export type NadoLoginJob = {
  id: string;
  status: "running" | "done" | "failed";
  total: number;
  finished: number;
  startedAt: number;
  results: WalletLoginResult[];
  log: string[];
  mode: "login" | "check";
  accountSlug?: string;
};

const jobs = new Map<string, NadoLoginJob>();
const MAX_JOBS = 20; // 只保留最近 20 个任务，避免内存无限增长

/** 定位 worker 脚本（兼容从仓库根或 apps/console 启动）。 */
function workerPath(): string {
  const candidates = [
    join(process.cwd(), "server", "nado-login", "worker.mjs"),
    join(process.cwd(), "apps", "console", "server", "nado-login", "worker.mjs"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("找不到 server/nado-login/worker.mjs");
  return found;
}

function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.status !== "running") jobs.delete(id);
  }
}

/** 启动一个登录任务；返回创建好的任务（私钥不会进入任务对象）。
 *  `keepOpenMs` > 0 表示「登录并查看」模式：确认成功后浏览器窗口保留一段时间。
 *  `mode = "check"` 表示只检查注册状态：无头登录后观察引导弹窗，不做引导操作。
 *  `accountSlug` 只用于把结果登记到注册表（便于按账户对齐）。 */
export function startNadoLoginJob(
  keys: NadoLoginKey[],
  keepOpenMs = 0,
  mode: "login" | "check" = "login",
  accountSlug?: string,
): NadoLoginJob {
  const job: NadoLoginJob = {
    id: randomUUID(),
    status: "running",
    total: keys.length,
    finished: 0,
    startedAt: Date.now(),
    results: keys.map((k) => ({ index: k.index, address: k.address, status: "pending" })),
    log: [],
    mode,
    accountSlug,
  };
  jobs.set(job.id, job);
  pruneJobs();

  const child = spawn(process.execPath, [workerPath()], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // 私钥只在内存中通过 stdin 传给 worker，不写文件、不进日志
  child.stdin.write(JSON.stringify({ wallets: keys, keepOpenMs, mode }));
  child.stdin.end();

  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let nl = buffered.indexOf("\n");
    while (nl >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line) handleWorkerLine(job, line);
      nl = buffered.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) pushLog(job, text);
  });

  child.on("error", (e) => {
    job.status = "failed";
    pushLog(job, `worker 启动失败: ${e.message}`);
  });

  child.on("close", (code) => {
    if (job.status === "running") {
      // worker 未显式发出 done 就退出：把未完成的钱包标记为失败，避免页面一直转圈
      for (const r of job.results) {
        if (r.status === "pending" || r.status === "running") {
          r.status = "failed";
          r.error = r.error ?? `worker 提前退出（code=${code ?? "unknown"}）`;
          recordResult(job, r);
        }
      }
      job.status = "failed";
      pushLog(job, `worker 退出，code=${code ?? "unknown"}`);
    }
  });

  return job;
}

function handleWorkerLine(job: NadoLoginJob, line: string): void {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(line) as Record<string, unknown>; } catch {
    pushLog(job, line.slice(0, 300));
    return;
  }

  if (msg.type === "wallet") {
    const index = Number(msg.index);
    const result = job.results.find((r) => r.index === index);
    if (result) {
      const wasFinished = result.status === "ok" || result.status === "failed";
      const status = msg.status as WalletLoginStatus;
      result.status = status;
      result.error = typeof msg.error === "string" ? msg.error : undefined;
      result.ms = typeof msg.ms === "number" ? msg.ms : undefined;
      if (typeof msg.username === "string") result.username = msg.username;
      if (typeof msg.registered === "boolean") result.registered = msg.registered;
      // 同一钱包只计一次完成，避免成功后又收到收尾错误导致 finished 超过总数
      if (!wasFinished && (status === "ok" || status === "failed")) {
        job.finished++;
        recordResult(job, result);
      }
    }
    return;
  }
  if (msg.type === "done") {
    job.status = job.results.every((r) => r.status === "ok") ? "done" : "failed";
    return;
  }
  if (msg.type === "fatal") {
    job.status = "failed";
    pushLog(job, `worker fatal: ${String(msg.error ?? "unknown")}`);
    return;
  }
  if (msg.type === "start") pushLog(job, `${job.mode === "check" ? "开始检查" : "开始登录"} ${String(msg.total)} 个钱包`);
  if (msg.type === "log") pushLog(job, `钱包 #${String(msg.index)} ${String(msg.note ?? "")}`);
}

/** 把单个钱包的最终结果写入注册表（按地址一一对应）。
 *  写盘失败只记日志，不影响任务本身的成功 / 失败判定。 */
function recordResult(job: NadoLoginJob, result: WalletLoginResult): void {
  const update = registryUpdateFor(job.mode, result, job.accountSlug);
  if (!update) return;
  const onError = (e: unknown) => pushLog(job, `注册表写入失败：${e instanceof Error ? e.message : String(e)}`);
  if (update.kind === "check") void recordCheck(update).catch(onError);
  else if (update.kind === "login") void recordLogin(update).catch(onError);
  else void recordFailure(update).catch(onError);
}

function pushLog(job: NadoLoginJob, line: string): void {
  job.log.push(`[${new Date().toISOString()}] ${line}`);
  if (job.log.length > 60) job.log.splice(0, job.log.length - 60);
}

export function getNadoLoginJob(id: string): NadoLoginJob | undefined {
  return jobs.get(id);
}
