// =============================================================================
// /api/nado/login — 本地「官网登录 / 注册」任务接口。
// POST：接收浏览器从保险库导出的钱包凭据（仅内存），启动 Playwright worker；
// GET ：按 jobId 轮询进度；DELETE：手动停止任务（结束浏览器进程）。
// 私钥不会写入任务状态、日志或磁盘。
// 只允许 127.0.0.1 / localhost 访问，避免私钥经网络外泄。
// =============================================================================
import { NextResponse } from "next/server";
import { getNadoLoginJob, latestNadoLoginJob, startNadoLoginJob, stopNadoLoginJob } from "../../../lib/nadoLoginJobs";
import { isLocalRequest } from "../../../lib/localRequest";
import type { NadoLoginKey } from "../../../lib/nadoLoginJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const MAX_WALLETS = 200;

export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "only localhost may start login jobs" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as {
    wallets?: unknown; keepOpenMs?: unknown; mode?: unknown; accountSlug?: unknown; concurrency?: unknown; headless?: unknown;
  } | null;
  const raw = Array.isArray(body?.wallets) ? body.wallets : [];
  if (raw.length === 0) return NextResponse.json({ error: "wallets is empty" }, { status: 400 });
  if (raw.length > MAX_WALLETS) return NextResponse.json({ error: `too many wallets (max ${MAX_WALLETS})` }, { status: 400 });
  // 「登录并查看」模式：把浏览器窗口保留一段时间（0 ~ 10 分钟）
  const keepOpenMs = Math.max(0, Math.min(600_000, Number(body?.keepOpenMs) || 0));
  // "check" = 只检查注册状态（无头）；默认 = 完整登录 + 注册引导
  const mode = body?.mode === "check" ? "check" : "login";
  // 账户 slug 只用于登记表归类（不参与自动化）
  const accountSlug = typeof body?.accountSlug === "string" && body.accountSlug.length <= 64 ? body.accountSlug : undefined;
  // 并发数：同一个浏览器内同时登录几个钱包（1 ~ 8），越大越快、越吃内存
  const concurrency = Math.max(1, Math.min(8, Math.floor(Number(body?.concurrency) || 1)));
  // 默认无窗口运行（不渲染界面，更快更省内存）；传 false 才显示浏览器窗口
  const headless = body?.headless !== false;

  const keys: NadoLoginKey[] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i] as { index?: unknown; address?: unknown; privateKey?: unknown } | null;
    const address = typeof w?.address === "string" ? w.address : "";
    const privateKey = typeof w?.privateKey === "string" ? w.privateKey : "";
    if (!ADDRESS_RE.test(address)) return NextResponse.json({ error: `invalid address at #${i}` }, { status: 400 });
    if (!PRIVATE_KEY_RE.test(privateKey)) return NextResponse.json({ error: `invalid private key at #${i}` }, { status: 400 });
    keys.push({ index: typeof w?.index === "number" && Number.isInteger(w.index) ? w.index : i, address, privateKey });
  }

  const job = startNadoLoginJob(keys, keepOpenMs, mode, accountSlug, concurrency, headless);
  return NextResponse.json({ jobId: job.id, total: job.total });
}

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "only localhost may read login jobs" }, { status: 403 });
  const url = new URL(req.url);
  // latest=1：取最近一个任务（可按 accountSlug 过滤），用于离开页面后回来恢复进度
  if (url.searchParams.get("latest") === "1") {
    const job = latestNadoLoginJob(url.searchParams.get("accountSlug") ?? undefined);
    return NextResponse.json({ job: job ?? null });
  }
  const jobId = url.searchParams.get("jobId") ?? "";
  const job = getNadoLoginJob(jobId);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  return NextResponse.json(job);
}

/** 手动停止正在运行的任务（页面上的「停止注册」按钮）。
 *  未处理的钱包会被标记为失败（错误信息「已手动停止」），worker 与浏览器进程一并结束。 */
export async function DELETE(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "only localhost may stop login jobs" }, { status: 403 });
  const jobId = new URL(req.url).searchParams.get("jobId") ?? "";
  const job = getNadoLoginJob(jobId);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  const stopped = stopNadoLoginJob(jobId);
  return NextResponse.json({ stopped, job });
}
