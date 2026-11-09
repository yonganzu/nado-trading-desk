// =============================================================================
// ASH 交易终端的服务端只读客户端。
//
// ASH 的 HTTP API 只监听 127.0.0.1 且要求 Bearer Token（Token 由 ASH 自己生成在
// data/admin_token.txt）。浏览器拿不到这个文件，所以由 Next 服务端代读 Token 并转发，
// 页面只请求 /api/ash/signals。这里不做任何写操作（pause/resume/emergency 不代理）。
// =============================================================================
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE = "http://127.0.0.1:8788";
const TIMEOUT_MS = 4_000;

/** ASH 的地址；可用ASH_API_BASE 覆盖。 */
export function ashBase(): string {
  return (process.env.ASH_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");
}

/** Token 文件的候选路径：环境变量优先，其次按 monorepo 的相对位置找 ASH 的 data 目录。 */
function tokenCandidates(): string[] {
  const custom = process.env.ASH_TOKEN_FILE;
  return [
    custom,
    // apps/console → 仓库根 → ASH 目录（正常的开发布局）
    path.resolve(process.cwd(), "../../../ASH_AutoTrader_v1.0_Headless_API_Paper/ASH_AutoTrader_v1/data/admin_token.txt"),
    // 兜底：直接在本仓库相邻位置找
    path.resolve(process.cwd(), "../../ASH_AutoTrader_v1.0_Headless_API_Paper/ASH_AutoTrader_v1/data/admin_token.txt"),
    path.resolve(process.cwd(), "../ASH_AutoTrader_v1.0_Headless_API_Paper/ASH_AutoTrader_v1/data/admin_token.txt"),
  ].filter((p): p is string => Boolean(p));
}

/** 读取 ASH 的管理 Token；找不到时给出可操作的报错。 */
function ashToken(): string {
  const fromEnv = (process.env.ASH_ADMIN_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  for (const file of tokenCandidates()) {
    try {
      const token = fs.readFileSync(file, "utf8").trim();
      if (token) return token;
    } catch {
      // 该候选路径不存在，继续下一个
    }
  }
  throw new Error("找不到 ASH 管理 Token：请设置 ASH_TOKEN_FILE / ASH_ADMIN_TOKEN，或先启动 ASH 生成 data/admin_token.txt");
}

/** GET 一个 ASH 只读接口；非 2xx / 超时直接抛错，由调用方决定是否降级。 */
export async function ashGet<T>(pathname: string): Promise<T> {
  const res = await fetch(`${ashBase()}${pathname}`, {
    headers: { authorization: `Bearer ${ashToken()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ASH ${pathname} 返回 HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** POST 到 ASH；目前只用于仓位同步（ASH 侧只读入，不会因此下单）。 */
export async function ashPost<T>(pathname: string, body: unknown): Promise<T> {
  const res = await fetch(`${ashBase()}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ashToken()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ASH ${pathname} 返回 HTTP ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * POST 到 ASH 并把 4xx 也当成"业务拒绝"返回（不抛错）。
 * 调参 / 切品种需要把 ASH 的中文拒绝原因原样展示给用户，
 * 用 ashPost 会把整段 "HTTP 400 {json}" 一起抛出来。
 */
export async function ashPostResult<T>(pathname: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${ashBase()}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ashToken()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  return { status: res.status, data: data as T };
}
