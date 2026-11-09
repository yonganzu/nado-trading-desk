// POST /api/nado/relay/{execute|query} — the KEYLESS relay. The browser signs in-tab
// and sends the already-signed payload here; this route forwards the bytes to the Nado
// sequencer and returns the response. It holds NO key and does no signing — it only
// exists because the sequencer refuses cross-origin browser requests (CORS 403). This
// is the custody-free server the graduation demotes the old server-key route toward.
// 主网转发到 direct 网关（东京同机房，比官方边缘域名少一跳），测试网/回退走官方端点。
import { NextResponse } from "next/server";
import { chainIdFromCookieHeader } from "../../../../lib/chainEnv"; // per-request network from the cookie
import { engineBaseUrl } from "../../../../lib/nadoEndpoints";      // direct 网关 / 官方端点二选一

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOW = new Set(["execute", "query"]); // only these sequencer paths are forwardable

function enabled(): boolean {
  return process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true";
}

// 429 retry-with-backoff. The relay is the single choke point for ALL sequencer traffic
// (reads via /query AND writes via /execute), and the sequencer rate-limits per IP — the
// Next server's egress IP, shared by the whole cohort. Bounded exponential backoff (honoring
// Retry-After when present) smooths the transient per-IP 429s a multi-wallet burst triggers,
// without masking a sustained overload (we give up after RETRY_MAX and return the 429).
const RETRY_MAX = 4;
const RETRY_BASE_MS = 400;
const RETRY_CAP_MS = 8_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// Backoff with JITTER. Without it, a cohort-wide burst that all 429s retries in lockstep at
// identical offsets (400/800/…) and re-triggers the 429 together (thundering herd). We
// decorrelate each retry by ±50% so the retries spread out instead of re-colliding.
function retryAfterMs(res: Response, attempt: number): number {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    // Honor Retry-After as a FLOOR, then add a little jitter above it so concurrent callers
    // that all got the same header don't fire again in lockstep.
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000 + Math.floor(Math.random() * 500), RETRY_CAP_MS);
  }
  const base = RETRY_BASE_MS * 2 ** attempt; // 400 → 800 → 1600 → 3200ms
  return Math.min(Math.floor(base * (0.5 + Math.random())), RETRY_CAP_MS); // ±50% jitter around base
}

export async function POST(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  if (!enabled()) return NextResponse.json({ error: "live mode disabled (NADO_LIVE unset)" }, { status: 503 });
  const { path } = await ctx.params;
  const seg = (path ?? []).join("/");
  if (!ALLOW.has(seg)) return NextResponse.json({ error: `relay path '${seg}' not allowed` }, { status: 400 });
  // Forward to the sequencer for the SELECTED network (from the cookie), resolved per request.
  // 主网 = direct 网关（东京同机房），测试网 = 官方端点。
  const BASE = engineBaseUrl(chainIdFromCookieHeader(req.headers.get("cookie")));
  const body = await req.text(); // opaque: a signed execute payload or a public query
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${BASE}/${seg}`, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (r.status === 429 && attempt < RETRY_MAX) {
        await r.body?.cancel().catch(() => {}); // drain the rate-limit body before retrying
        await sleep(retryAfterMs(r, attempt));
        continue;
      }
      const text = await r.text();
      // 把「这次请求一共打了几次 sequencer」回传给浏览器（1 = 没重试）。面板据此区分
      // 「两腿间隔」里的尖峰到底是 relay 的 429 静默重试拖出来的，还是 sequencer 本身慢。
      return new NextResponse(text, {
        status: r.status,
        headers: { "content-type": "application/json", "x-relay-attempts": String(attempt + 1) },
      });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
