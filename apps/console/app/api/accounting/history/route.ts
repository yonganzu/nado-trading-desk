// GET /api/accounting/history?subaccounts=0x…,0x…&perWallet=1000&page=200
// 通过 Nado 官方 indexer 查询历史订单（keyless、只读），把已成交订单折算成 Accounting 记录：
//   • amount 正负 → 买/卖；base_filled/quote_filled → 数量与名义额
//   • fee / realized_pnl 直接采用官方值（比本地 FIFO 更准）
// 分页：按 submissionIndex 游标逐页向前翻，每个钱包最多 perWallet 条（默认 1000，上限 2000）。
// 说明：indexer 在独立 host 上且拒绝跨域浏览器请求，所以由服务端转发。
import { NextResponse } from "next/server";
import { IndexerClient, INDEXER_CLIENT_ENDPOINTS } from "@nadohq/indexer-client";
import { CHAIN_ID_TO_CHAIN_ENV, subaccountFromHex } from "@nadohq/client";
import { inferTaker } from "@farm/ui";
import type { AccountingRecord } from "@farm/ui";
import { chainIdFromCookieHeader } from "../../../lib/chainEnv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const X18 = 1e18;
const MAX_PAGE = 200;
const DEFAULT_PER_WALLET = 1000;
const MAX_PER_WALLET = 2000;

// 每个链环境一个 client（网络由 cookie 决定，与 /api/nado/dda 一致）
const indexerByEnv = new Map<string, IndexerClient>();
function indexerFor(chainId: number): IndexerClient | null {
  const env = CHAIN_ID_TO_CHAIN_ENV[chainId];
  if (!env) return null;
  let c = indexerByEnv.get(env);
  if (!c) { c = new IndexerClient({ url: INDEXER_CLIENT_ENDPOINTS[env] }); indexerByEnv.set(env, c); }
  return c;
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const raw = url.searchParams.get("subaccounts") ?? "";
  const subs = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{64}$/.test(s));
  if (subs.length === 0) {
    return NextResponse.json({ ok: false, error: "subaccounts must be comma-separated 0x bytes32" }, { status: 400 });
  }
  const page = Math.min(Math.max(Number(url.searchParams.get("page") ?? MAX_PAGE) || MAX_PAGE, 1), MAX_PAGE);
  const perWallet = Math.min(Math.max(Number(url.searchParams.get("perWallet") ?? DEFAULT_PER_WALLET) || DEFAULT_PER_WALLET, 1), MAX_PER_WALLET);

  const chainId = chainIdFromCookieHeader(req.headers.get("cookie"));
  const indexer = indexerFor(chainId);
  if (!indexer) return NextResponse.json({ ok: false, error: `no Nado indexer for chainId ${chainId}` }, { status: 500 });

  try {
    const records: AccountingRecord[] = [];
    const seen = new Set<string>();
    let truncated = false;

    for (const hex of subs) {
      const { subaccountOwner, subaccountName } = subaccountFromHex(hex);
      let cursor: string | undefined;
      let fetched = 0;
      const pages = Math.ceil(perWallet / page);

      for (let i = 0; i < pages; i++) {
        const res = await indexer.getPaginatedSubaccountOrders({
          subaccountOwner,
          subaccountName,
          limit: page,
          startCursor: cursor,
        });
        for (const o of res.orders) {
          if (seen.has(o.digest)) continue;
          seen.add(o.digest);
          const size = Math.abs(o.baseFilled.toNumber()) / X18;
          const notional = Math.abs(o.quoteFilled.toNumber()) / X18;
          if (!(size > 0) || !(notional > 0)) continue; // 只统计已成交
          const fee = o.totalFee.toNumber() / X18;
          const tsSec = o.lastFillTimestamp.toNumber() || o.firstFillTimestamp.toNumber();
          const subaccount = o.subaccount.toLowerCase();
          records.push({
            id: `${subaccount}|${o.digest}|history`,
            subaccount,
            orderDigest: o.digest,
            walletId: subaccount.slice(0, 10), // 客户端导入时会用 subaccount → 钱包元信息补全
            market: `product:#${o.productId}`, // 客户端导入时会按 product → market 映射补全
            side: o.amount.gt(0) ? "buy" : "sell",
            price: notional / size,
            size,
            notional,
            fee,
            realizedPnl: o.realizedPnl.toNumber() / X18,
            // indexer 不返回 is_taker：用费率反推（maker ≈1bps / taker ≈3.5bps）
            taker: inferTaker(fee, notional),
            status: "filled",
            ts: Math.round(tsSec * 1000),
          });
          fetched += 1;
        }
        if (!res.meta.hasMore || !res.meta.nextCursor) break;
        cursor = res.meta.nextCursor;
        if (fetched >= perWallet) { truncated = true; break; }
      }
      if (fetched >= perWallet) truncated = true;
    }

    return NextResponse.json({ ok: true, records, count: records.length, truncated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
