// GET /api/nado/clock — 量一次「本机 → sequencer」的时钟偏差，给浏览器校正下单用的时间戳。
//
// 为什么需要：下单的 nonce 里编了 recvTime（毫秒），expiration 也用本机时钟算。实测本机比
// sequencer 慢约 1000ms（未超 ~90s 的容忍窗口，所以还没报错），但一旦机器休眠/时区同步漂移，
// 就会踩到 2011 LATE_RECV_EXECUTION 或订单提前过期。这里用 /edge/query 的 ping/pong
// （回传 server_time 并原样回显 client_time）算出 offset = server − (client + rtt/2)。
//
// 顺带作用：这条请求会预热 relay → direct 网关的 TLS 连接，第一笔真实下单不必再付握手钱。
import { NextResponse } from "next/server";
import { chainIdFromCookieHeader } from "../../../lib/chainEnv";
import { engineBaseUrl } from "../../../lib/nadoEndpoints";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 60_000;      // 同一网络 60s 内复用，避免每次开面板都打一次
const SAMPLES = 3;            // 取中位数，压掉单次抖动
const MAX_OFFSET_MS = 60_000; // 超过这个量级视为测量异常，不下发（宁可不校正，也不要校正错）

interface ClockSample { offsetMs: number; rttMs: number }
const cache = new Map<number, { at: number; sample: ClockSample }>();

function enabled(): boolean {
  return process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true";
}

async function pingOnce(base: string): Promise<ClockSample> {
  const t0 = Date.now();
  const res = await fetch(`${base}/edge/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "ping", client_time: String(t0), id: 1 }),
    cache: "no-store",
  });
  const t1 = Date.now();
  const j = (await res.json()) as { server_time?: string; client_time?: string; status?: string };
  if (!res.ok || !j.server_time) throw new Error(`ping failed (${res.status})`);
  const rttMs = t1 - t0;
  const sent = Number(j.client_time ?? t0);
  const offsetMs = Number(j.server_time) - sent - Math.round(rttMs / 2);
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > MAX_OFFSET_MS) throw new Error(`implausible offset ${offsetMs}ms`);
  return { offsetMs, rttMs };
}

export async function GET(req: Request) {
  if (!enabled()) return NextResponse.json({ error: "live mode disabled (NADO_LIVE unset)" }, { status: 503 });
  const chainId = chainIdFromCookieHeader(req.headers.get("cookie"));
  const hit = cache.get(chainId);
  if (hit && Date.now() - hit.at < CACHE_MS) return NextResponse.json({ ...hit.sample, cached: true });

  try {
    const base = engineBaseUrl(chainId);
    const samples: ClockSample[] = [];
    for (let i = 0; i < SAMPLES; i++) samples.push(await pingOnce(base));
    // 中位数（按 offset 排序取中间那个），连同它的 rtt 一起回传
    samples.sort((a, b) => a.offsetMs - b.offsetMs);
    const sample = samples[Math.floor(samples.length / 2)]!;
    cache.set(chainId, { at: Date.now(), sample });
    return NextResponse.json({ ...sample, cached: false });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
