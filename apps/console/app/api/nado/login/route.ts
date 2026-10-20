// =============================================================================
// /api/nado/login — 本地「官网登录 / 注册」任务接口。
// POST：接收浏览器从保险库导出的钱包凭据（仅内存），启动 Playwright worker；
// GET ：按 jobId 轮询进度。私钥不会写入任务状态、日志或磁盘。
// 只允许 127.0.0.1 / localhost 访问，避免私钥经网络外泄。
// =============================================================================
import { NextResponse } from "next/server";
import { getNadoLoginJob, startNadoLoginJob } from "../../../lib/nadoLoginJobs";
import type { NadoLoginKey } from "../../../lib/nadoLoginJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const MAX_WALLETS = 200;

/** 仅允许本机请求：私钥只在本机浏览器与本地自动化进程之间传递。
 *  Next dev 可能补上 x-forwarded-for，因此只要 Host 与转发来源都是回环地址就放行。 */
function isLocalRequest(req: Request): boolean {
  const hostHeader = (req.headers.get("host") ?? "").toLowerCase();
  const hostname = (hostHeader.split(":")[0] || new URL(req.url).hostname).replace(/^\[|\]$/g, "");
  const forwarded = ((req.headers.get("x-forwarded-for") ?? "").split(",")[0] ?? "").trim().replace(/^\[|\]$/g, "");
  const loopback = ["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"];
  return loopback.includes(hostname) && (!forwarded || loopback.includes(forwarded));
}

export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "only localhost may start login jobs" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { wallets?: unknown; keepOpenMs?: unknown } | null;
  const raw = Array.isArray(body?.wallets) ? body.wallets : [];
  if (raw.length === 0) return NextResponse.json({ error: "wallets is empty" }, { status: 400 });
  if (raw.length > MAX_WALLETS) return NextResponse.json({ error: `too many wallets (max ${MAX_WALLETS})` }, { status: 400 });
  // 「登录并查看」模式：把浏览器窗口保留一段时间（0 ~ 10 分钟）
  const keepOpenMs = Math.max(0, Math.min(600_000, Number(body?.keepOpenMs) || 0));

  const keys: NadoLoginKey[] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i] as { index?: unknown; address?: unknown; privateKey?: unknown } | null;
    const address = typeof w?.address === "string" ? w.address : "";
    const privateKey = typeof w?.privateKey === "string" ? w.privateKey : "";
    if (!ADDRESS_RE.test(address)) return NextResponse.json({ error: `invalid address at #${i}` }, { status: 400 });
    if (!PRIVATE_KEY_RE.test(privateKey)) return NextResponse.json({ error: `invalid private key at #${i}` }, { status: 400 });
    keys.push({ index: typeof w?.index === "number" && Number.isInteger(w.index) ? w.index : i, address, privateKey });
  }

  const job = startNadoLoginJob(keys, keepOpenMs);
  return NextResponse.json({ jobId: job.id, total: job.total });
}

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "only localhost may read login jobs" }, { status: 403 });
  const jobId = new URL(req.url).searchParams.get("jobId") ?? "";
  const job = getNadoLoginJob(jobId);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  return NextResponse.json(job);
}
