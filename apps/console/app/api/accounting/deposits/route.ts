// GET /api/accounting/deposits?subaccounts=0x…,0x…
// 通过 Nado 官方 indexer 查询每个子账户的资金进出事件（deposit_collateral 充值 / withdraw_collateral 提币），
// 供 Accounting 面板计算「净充值 = 充值 − 提币」。
//   • amount 是 18 位定点数，换算成 USDT0
//   • 分页用 submissionIndex 游标向前翻，每个钱包最多 MAX_EVENTS 条
// 说明：indexer 在独立 host 且拒绝浏览器跨域请求，所以由服务端转发（与 history 路由一致）。
import { NextResponse } from "next/server";
import { IndexerClient, INDEXER_CLIENT_ENDPOINTS } from "@nadohq/indexer-client";
import { CHAIN_ID_TO_CHAIN_ENV, subaccountFromHex } from "@nadohq/client";
import { chainIdFromCookieHeader } from "../../../lib/chainEnv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const X18 = 1e18;
const PAGE = 100;
const MAX_EVENTS = 500;

// 每个链环境一个 client（网络由 cookie 决定，与 /api/accounting/history 一致）
const indexerByEnv = new Map<string, IndexerClient>();
function indexerFor(chainId: number): IndexerClient | null {
  const env = CHAIN_ID_TO_CHAIN_ENV[chainId];
  if (!env) return null;
  let c = indexerByEnv.get(env);
  if (!c) { c = new IndexerClient({ url: INDEXER_CLIENT_ENDPOINTS[env] }); indexerByEnv.set(env, c); }
  return c;
}

/** 一条资金进出记录（金额恒为正，方向看 type）。 */
export interface DepositRecord {
  /** 子账户 bytes32（含钱包地址前缀） */
  subaccount: string;
  /** deposit = 充值（转入），withdraw = 提币（转出） */
  type: "deposit" | "withdraw";
  /** USDT0 数量（正数） */
  amount: number;
  /** 毫秒时间戳 */
  ts: number;
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const subs = (url.searchParams.get("subaccounts") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{64}$/.test(s));
  if (subs.length === 0) {
    return NextResponse.json({ ok: false, error: "subaccounts must be comma-separated 0x bytes32" }, { status: 400 });
  }

  const indexer = indexerFor(chainIdFromCookieHeader(req.headers.get("cookie")));
  if (!indexer) return NextResponse.json({ ok: false, error: "no Nado indexer for this chain" }, { status: 500 });

  try {
    const records: DepositRecord[] = [];
    const seen = new Set<string>();
    let truncated = false;

    for (const hex of subs) {
      const { subaccountOwner, subaccountName } = subaccountFromHex(hex);
      let cursor: string | undefined;
      let fetched = 0;

      for (let i = 0; i < Math.ceil(MAX_EVENTS / PAGE); i++) {
        const res = await indexer.getPaginatedSubaccountCollateralEvents({
          subaccountOwner,
          subaccountName,
          // withdraw_collateral 是旧版提币，withdraw_collateral_v2 是新版（两者都要，否则提币会漏）
          eventTypes: ["deposit_collateral", "withdraw_collateral", "withdraw_collateral_v2"],
          limit: PAGE,
          startCursor: cursor,
        });
        for (const e of res.events) {
          const key = `${hex.toLowerCase()}|${e.submissionIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // 提币事件的 amount 是负数（如 -4000000000000000002），充值是正数；这里统一取绝对值 + 方向
          const isWithdraw = e.eventType.startsWith("withdraw");
          const amount = Math.abs(e.amount.toNumber() / X18);
          if (!(amount > 0)) continue;
          records.push({
            subaccount: hex.toLowerCase(),
            type: isWithdraw ? "withdraw" : "deposit",
            amount,
            ts: Math.round(e.timestamp.toNumber() * 1000),
          });
          fetched += 1;
        }
        if (!res.meta.hasMore || !res.meta.nextCursor) break;
        if (fetched >= MAX_EVENTS) { truncated = true; break; }
        cursor = res.meta.nextCursor;
      }
    }

    records.sort((a, b) => b.ts - a.ts);
    return NextResponse.json({ ok: true, records, count: records.length, truncated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
