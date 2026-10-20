// =============================================================================
// Nado 注册结果登记表（服务端，仅本机运行）。
// 以钱包地址为唯一键，记录每个钱包最近一次的注册 / 检查结果，
// 这样页面刷新、dev server 重启后结果仍然一一对应地保留。
// 只保存地址、用户名与状态，永远不保存私钥。
// 合并规则见 nadoRegistryModel.ts（纯逻辑，有单元测试）。
// =============================================================================
import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyCheck, applyFailure, applyLogin } from "./nadoRegistryModel";
import type { CheckInput, FailureInput, LoginInput, NadoRegistryEntry } from "./nadoRegistryModel";

export type { NadoRegistryEntry } from "./nadoRegistryModel";

const FILE = join(process.cwd(), ".nado-registry.json");

let cache: Record<string, NadoRegistryEntry> | null = null;
// 所有读写串行执行，避免并发检查时互相覆盖 JSON 文件
let queue: Promise<unknown> = Promise.resolve();

function normalize(address: string): string {
  return address.toLowerCase();
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function load(): Promise<Record<string, NadoRegistryEntry>> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8")) as unknown;
    cache = parsed && typeof parsed === "object" ? (parsed as Record<string, NadoRegistryEntry>) : {};
  } catch {
    // 文件不存在 / 损坏：从空表开始
    cache = {};
  }
  return cache;
}

/** 先写临时文件再 rename，避免进程中断留下半个 JSON。 */
async function flush(): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cache ?? {}, null, 2), "utf8");
  await rename(tmp, FILE);
}

/** 把一条记录合并进登记表并落盘。 */
async function commit(entry: NadoRegistryEntry): Promise<NadoRegistryEntry> {
  const all = await load();
  all[entry.address] = entry;
  await flush();
  return entry;
}

/** 有一致结论的检查结果（出现 = 已注册，未出现 = 未注册）。 */
export function recordCheck(input: CheckInput): Promise<NadoRegistryEntry> {
  return enqueue(async () => commit(applyCheck((await load())[normalize(input.address)], input)));
}

/** 完整注册成功（登录 + 引导流程走完）。 */
export function recordLogin(input: LoginInput): Promise<NadoRegistryEntry> {
  return enqueue(async () => commit(applyLogin((await load())[normalize(input.address)], input)));
}

/** 检查 / 登录失败：保留已有的结论，只记录错误与尝试时间。 */
export function recordFailure(input: FailureInput): Promise<NadoRegistryEntry> {
  return enqueue(async () => commit(applyFailure((await load())[normalize(input.address)], input)));
}

export function listRegistry(): Promise<NadoRegistryEntry[]> {
  return enqueue(async () => {
    const all = await load();
    return Object.values(all).sort((a, b) => (b.checkedAt ?? b.lastAttemptAt) - (a.checkedAt ?? a.lastAttemptAt));
  });
}

export function getRegistryEntry(address: string): Promise<NadoRegistryEntry | null> {
  return enqueue(async () => (await load())[normalize(address)] ?? null);
}
