// POST /api/nado/trigger/{execute|query} — 条件单（trigger service）的无金钥中继。
//
// 浏览器在标签页内把条件单签好名后提交到这里，本路由只转发字节，不持有私钥、不做签名。
// 与 /api/nado/relay 分开的原因：
//   1) trigger 服务是另一个 host（api.*.nado.xyz/trigger/v1），不是 sequencer；
//   2) 它要求 Accept-Encoding 带上 gzip/br/deflate（Node fetch 默认已带，浏览器带 Origin 直连
//      还要依赖第三方 Cookie，稳定性差），统一走服务端中继更可靠。
import { NextResponse } from "next/server";
import { CHAIN_ID_TO_CHAIN_ENV, TRIGGER_CLIENT_ENDPOINTS } from "@nadohq/client";
import { chainIdFromCookieHeader } from "../../../../lib/chainEnv"; // per-request network from the cookie

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOW = new Set(["execute", "query"]); // 只允许这两个 trigger 服务路径

function enabled(): boolean {
  return process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true";
}

// 429 退避：与 sequencer 中继同策略（每 IP 限流，多钱包并发会瞬时 429）。
const RETRY_MAX = 4;
const RETRY_BASE_MS = 400;
const RETRY_CAP_MS = 8_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function retryAfterMs(res: Response, attempt: number): number {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000 + Math.floor(Math.random() * 500), RETRY_CAP_MS);
  }
  const base = RETRY_BASE_MS * 2 ** attempt;
  return Math.min(Math.floor(base * (0.5 + Math.random())), RETRY_CAP_MS);
}

export async function POST(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  if (!enabled()) return NextResponse.json({ error: "live mode disabled (NADO_LIVE unset)" }, { status: 503 });
  const { path } = await ctx.params;
  const seg = (path ?? []).join("/");
  if (!ALLOW.has(seg)) return NextResponse.json({ error: `trigger relay path '${seg}' not allowed` }, { status: 400 });
  // 按 cookie 里的网络选择对应的 trigger 服务（testnet / mainnet）
  const BASE = TRIGGER_CLIENT_ENDPOINTS[CHAIN_ID_TO_CHAIN_ENV[chainIdFromCookieHeader(req.headers.get("cookie"))]!];
  const body = await req.text(); // 已签名的 execute 载荷，或带签名的 query
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${BASE}/${seg}`, {
        method: "POST",
        // trigger 服务前置的 Cloudflare 规则要求声明压缩算法，否则直接 403
        headers: { "content-type": "application/json", "accept-encoding": "gzip, deflate, br" },
        body,
      });
      if (r.status === 429 && attempt < RETRY_MAX) {
        await r.body?.cancel().catch(() => {});
        await sleep(retryAfterMs(r, attempt));
        continue;
      }
      const text = await r.text();
      return new NextResponse(text, { status: r.status, headers: { "content-type": "application/json" } });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
