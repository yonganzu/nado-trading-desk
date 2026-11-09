// =============================================================================
// 浏览器侧成交账本（单例）：消费公共 WS `fill` 帧 → 生成 AccountingRecord。
//
// 口径：
//   • 只统计已成交（fill），未成交挂单不入账；
//   • fee 直接用 Nado 回执（带符号，maker 返佣为负）；
//   • realizedPnl 由本地 FIFO 按 `walletId|market` 配对，开仓成交记 0；
//   • 记录按 `subaccount|order_digest|timestamp|filled_qty` 去重，WS 重放不会重复计数。
//
// 数据同时落库到服务端（/api/accounting），刷新页面后自动回放，并重建 FIFO 队列。
// =============================================================================
import { inferTaker } from "@farm/ui";
import type { AccountingRecord } from "@farm/ui";

export interface WalletMeta {
  walletId: string;
  accountName?: string;
  cohorts?: readonly string[];
}

interface Lot {
  side: "buy" | "sell";
  price: number;
  size: number;
}

/** 内存中保留的记录条数（服务端保留全量 20000 条）。 */
const MAX_RECORDS = 5000;
const API_URL = "/api/accounting";

// 自成交判定阈值：同市场、反方向、来自不同钱包，且在时间/价格/数量上都足够接近
/** 两条腿的成交时间差上限（毫秒）：自成交引擎先 maker 后 taker，间隔通常在秒级 */
const SELF_CROSS_WINDOW_MS = 10_000;
/** 价格相对容差：历史订单均价含手续费，允许 0.5% 偏差 */
const SELF_CROSS_PRICE_TOL = 0.005;
/** 数量相对容差：允许部分成交造成的 2% 偏差 */
const SELF_CROSS_SIZE_TOL = 0.02;
/** 待配对队列上限（只保留近期的未配对成交） */
const MAX_UNMATCHED = 5000;

/**
 * 数字归一化：Nado 的 WS 帧可能是 x18 整数串，也可能是人类小数。
 * 实际价格/数量/手续费不会超过 1e12，因此绝对值 >= 1e12 时按 x18 缩放。
 */
export function normalizeAmount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.abs(n) >= 1e12 ? n / 1e18 : n;
}

/** 布尔字段兜底：服务端偶尔以字符串下发。 */
function isTrue(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

export class AccountingLedger {
  /** 就地变更（UI 侧靠 version() 触发重渲染，避免每次记录都复制大数组）。 */
  readonly records: AccountingRecord[] = [];
  private seen = new Set<string>();
  private lots = new Map<string, Lot[]>();
  private walletBySub = new Map<string, WalletMeta>();
  private marketByProduct = new Map<number, string>();
  private listeners = new Set<() => void>();
  private _version = 0;
  private _ready = false;
  private hydrating = false;
  private pending: AccountingRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 已从 WS 收到的订单摘要（subaccount|digest），用于避免历史回补重复计数 */
  private liveDigests = new Set<string>();
  /** 已从历史回补导入的订单摘要 */
  private historyDigests = new Set<string>();
  /** 尚未判定为自成交的成交（按到达顺序），供后续反方向成交配对 */
  private unmatched: AccountingRecord[] = [];

  /** @param persist 是否落库到 /api/accounting（单测里传 false，避免网络与定时器）。 */
  constructor(private readonly persist: boolean = true) {}

  version(): number {
    return this._version;
  }

  /** 首次服务端回放是否完成（完成后 UI 才值得展示「历史」数据）。 */
  ready(): boolean {
    return this._ready;
  }

  /** subaccount → 钱包元信息（@param entries 由 page.tsx 的 live.wallets 派生）。 */
  setWalletIndex(entries: ReadonlyArray<{ subaccount: string; meta: WalletMeta }>): void {
    this.walletBySub.clear();
    for (const e of entries) {
      if (!e.subaccount) continue;
      this.walletBySub.set(e.subaccount.toLowerCase(), e.meta);
    }
  }

  /** product_id → market（@param entries 由 live.markets / live.products 派生）。 */
  setMarketIndex(entries: ReadonlyArray<{ productId: number; market: string }>): void {
    this.marketByProduct.clear();
    for (const e of entries) {
      if (!Number.isFinite(e.productId) || !e.market) continue;
      this.marketByProduct.set(e.productId, e.market);
    }
  }

  /** 解析一帧公共 WS `fill`；成功入账返回记录，忽略/重复返回 null。 */
  record(frame: Record<string, unknown>, ts?: number): AccountingRecord | null {
    if (frame["type"] !== "fill") return null;
    const subaccount = String(frame["subaccount"] ?? "").toLowerCase();
    if (!subaccount) return null;

    const price = normalizeAmount(frame["price"]);
    const size = normalizeAmount(frame["filled_qty"]);
    if (!(price > 0) || !(size > 0)) return null; // 缺价/缺量（例如 mock 帧）直接跳过

    const digest = String(frame["order_digest"] ?? frame["digest"] ?? "");
    const rawQty = String(frame["filled_qty"] ?? "");
    const id = `${subaccount}|${digest}|${String(frame["timestamp"] ?? "")}|${rawQty}`;
    if (this.seen.has(id)) return null;
    // 该订单已被历史回补导入：WS 再推同一订单不重复计数
    const digestKey = digest ? `${subaccount}|${digest}` : "";
    if (digestKey && this.historyDigests.has(digestKey)) return null;

    const productId = normalizeAmount(frame["product_id"]);
    const market = this.marketByProduct.get(productId) ?? `product:#${productId}`;

    const meta = this.walletBySub.get(subaccount);
    const walletId = meta?.walletId ?? subaccount.slice(0, 10);
    const side: "buy" | "sell" = isTrue(frame["is_bid"]) ? "buy" : "sell";
    const fee = normalizeAmount(frame["fee"]);
    const taker = isTrue(frame["is_taker"]);
    const realizedPnl = this.applyLots(`${walletId}|${market}`, side, price, size);

    const rec: AccountingRecord = {
      id,
      subaccount,
      orderDigest: digest || undefined,
      walletId,
      accountName: meta?.accountName,
      cohorts: meta?.cohorts,
      market,
      side,
      price,
      size,
      notional: price * size,
      fee,
      realizedPnl,
      taker,
      status: "filled",
      ts: ts ?? Date.now(),
    };

    this.seen.add(id);
    if (digestKey) this.liveDigests.add(digestKey);
    this.records.push(rec);
    // 自成交判定：命中会把本条与对手记录都标记成 selfCross（对手记录重新落库覆盖旧值）
    this.detectSelfCross(rec);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    if (this.persist) this.queueForPersistence(rec);
    this.bump();
    return rec;
  }

  /**
   * 导入官方 indexer 的历史订单（已按订单聚合，字段来自 getOrders）：
   * 带官方 realized_pnl 的记录直接采用；同时重建 FIFO 队列，供后续 WS 成交接着算。
   * 与 WS 已记的同订单（subaccount|digest）自动跳过，避免重复计数。
   */
  importRecords(list: readonly AccountingRecord[]): number {
    let added = 0;
    for (const raw of list) {
      const rec: AccountingRecord = { ...raw };
      // 历史接口只给 product_id，用已注册的 product → market 映射补全
      if (rec.market.startsWith("product:#")) {
        const pid = Number(rec.market.slice("product:#".length));
        rec.market = this.marketByProduct.get(pid) ?? rec.market;
      }
      // 用 subaccount → 钱包元信息补全（历史接口只给 subaccount hex）
      const meta = rec.subaccount ? this.walletBySub.get(rec.subaccount.toLowerCase()) : undefined;
      if (meta) {
        rec.walletId = meta.walletId;
        rec.accountName = meta.accountName;
        rec.cohorts = meta.cohorts;
      }
      const digestKey = rec.subaccount && rec.orderDigest ? `${rec.subaccount}|${rec.orderDigest}` : "";
      if (digestKey && this.liveDigests.has(digestKey)) continue; // 该订单的成交已由 WS 入账
      if (rec.id && this.seen.has(rec.id)) continue;

      const price = rec.price ?? 0;
      const size = rec.size ?? (price > 0 ? rec.notional / price : 0);
      // 历史订单没有 is_taker：按手续费率（maker 1bps / taker 3.5bps）反推
      if (rec.taker === undefined) rec.taker = inferTaker(rec.fee, rec.notional);
      if (price > 0 && size > 0) {
        const fifoPnl = this.applyLots(`${rec.walletId}|${rec.market}`, rec.side, price, size);
        if (rec.realizedPnl === undefined) rec.realizedPnl = fifoPnl; // 官方没给才用本地 FIFO
      }
      if (rec.id) this.seen.add(rec.id);
      if (digestKey) this.historyDigests.add(digestKey);
      this.records.push(rec);
      // 历史订单同样参与自成交判定（不同钱包的反方向近似成交会被一起标记）
      this.detectSelfCross(rec);
      if (this.persist) this.queueForPersistence(rec);
      added += 1;
    }
    if (added > 0) {
      this.records.sort((a, b) => a.ts - b.ts);
      if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
      // 截断后可能有记录被移出内存，重新对齐待配对队列
      this.rebuildUnmatched();
      this.bump();
    }
    return added;
  }

  /** 清空内存账本与服务端落库。 */
  async reset(): Promise<void> {
    this.records.length = 0;
    this.seen.clear();
    this.lots.clear();
    this.pending.length = 0;
    this.liveDigests.clear();
    this.historyDigests.clear();
    this.unmatched.length = 0;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.bump();
    if (!this.persist) return;
    try {
      await fetch(API_URL, { method: "DELETE" });
    } catch { /* 服务端不可用时只清内存 */ }
  }

  /** 订阅账本变化（record / 回放完成 / reset）。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 从服务端回放历史记录；只执行一次。 */
  hydrate(): void {
    if (this.hydrating || this._ready) return;
    this.reload();
  }

  /** 强制从服务端（本地落库文件）重新拉一遍并合并进账本：不清空现有记录，按 id 去重。
   *  打开 Accounting 弹窗时调用，这样「首次 fetch 恰好赶上开发服务器重编译失败」也不会
   *  让账本永远停在空状态（旧实现失败后 _ready 就固定为 true，再也不会重试）。 */
  reload(): void {
    if (this.hydrating) return;
    this.hydrating = true;
    void fetch(API_URL, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { records?: unknown }) => {
        const list = Array.isArray(data?.records) ? (data.records as AccountingRecord[]) : [];
        for (const rec of list) this.seed(rec);
        this.records.sort((a, b) => a.ts - b.ts);
        // 回放完成后重建待配对队列：旧数据可能没有 selfCross 标记，这里统一补判
        this.rebuildUnmatched();
        // 旧数据（历史订单）可能缺 taker 标记，按手续费率补判并重新落库
        this.backfillTaker();
      })
      .catch(() => { /* 首次没落库/服务端不可用：保持现有记录，下次打开再试 */ })
      .finally(() => {
        this._ready = true;
        this.hydrating = false;
        this.bump();
      });
  }

  /** 回放一条历史记录：去重 + 重建 FIFO 队列（realizedPnl 以历史值保留）。 */
  private seed(rec: AccountingRecord): void {
    if (rec.id) {
      if (this.seen.has(rec.id)) return;
      this.seen.add(rec.id);
    }
    this.records.push(rec);
    if (rec.subaccount && rec.orderDigest) this.liveDigests.add(`${rec.subaccount}|${rec.orderDigest}`);
    const price = rec.price ?? 0;
    const size = rec.size ?? (price > 0 ? rec.notional / price : 0);
    if (price > 0 && size > 0) this.applyLots(`${rec.walletId}|${rec.market}`, rec.side, price, size);
  }

  /** 按 FIFO 平掉反向仓位并返回本条已实现盈亏；剩余数量作为新仓位入队。 */
  private applyLots(key: string, side: "buy" | "sell", price: number, size: number): number {
    const lots = this.lots.get(key) ?? [];
    const matchSide: "buy" | "sell" = side === "buy" ? "sell" : "buy";
    let remain = size;
    let pnl = 0;
    for (const lot of lots) {
      if (remain <= 0) break;
      if (lot.side !== matchSide || lot.size <= 0) continue;
      const qty = Math.min(lot.size, remain);
      // 平空：开仓价 − 成交价；平多：成交价 − 开仓价
      pnl += side === "buy" ? (lot.price - price) * qty : (price - lot.price) * qty;
      lot.size -= qty;
      remain -= qty;
    }
    const open = lots.filter((lot) => lot.size > 1e-12);
    if (remain > 1e-12) open.push({ side, price, size: remain });
    this.lots.set(key, open);
    return pnl;
  }

  /**
   * 自成交判定：在待配对队列里找一条「另一钱包 + 同市场 + 反方向 + 时间/价格/数量接近」的成交。
   * 命中则把双方都标记成 selfCross（对手记录重新落库覆盖旧值）；未命中则本条进入待配对队列。
   * @returns 是否配对成功
   */
  private detectSelfCross(rec: AccountingRecord): boolean {
    if (rec.selfCross === true) return false;
    const price = rec.price ?? 0;
    const size = rec.size ?? 0;
    if (!(price > 0) || !(size > 0)) return false;

    for (let i = this.unmatched.length - 1; i >= 0; i -= 1) {
      const c = this.unmatched[i];
      if (!c) continue;
      if (c.selfCross === true) { this.unmatched.splice(i, 1); continue; }
      if (c.walletId === rec.walletId) continue; // 必须来自两个不同钱包
      if (c.market !== rec.market) continue; // 必须是同一市场
      if (c.side === rec.side) continue; // 必须是反方向（一方买、一方卖）
      if (Math.abs(c.ts - rec.ts) > SELF_CROSS_WINDOW_MS) continue; // 时间必须相近
      const cp = c.price ?? 0;
      const cs = c.size ?? 0;
      if (!(cp > 0) || !(cs > 0)) continue;
      if (Math.abs(cp - price) / Math.max(cp, price) > SELF_CROSS_PRICE_TOL) continue;
      if (Math.abs(cs - size) / Math.max(cs, size) > SELF_CROSS_SIZE_TOL) continue;

      c.selfCross = true;
      rec.selfCross = true;
      this.unmatched.splice(i, 1);
      if (this.persist) {
        this.queueForPersistence(c); // 对手记录此前已落库，需重新写入覆盖
        this.queueForPersistence(rec);
      }
      return true;
    }

    // 未配对：留在队列里等后续另一钱包的反方向成交
    this.unmatched.push(rec);
    if (this.unmatched.length > MAX_UNMATCHED) {
      this.unmatched.splice(0, this.unmatched.length - MAX_UNMATCHED);
    }
    return false;
  }

  /** 回放历史后重建待配对队列：按时间顺序重新配对尚未标记的成交（兼容旧数据）。 */
  private rebuildUnmatched(): void {
    this.unmatched.length = 0;
    for (const rec of this.records) {
      if (rec.selfCross === true) continue; // 已判定过的订单不再参与配对
      this.detectSelfCross(rec);
    }
  }

  /** 补判 maker/taker：缺 taker 标记的记录按手续费率反推（maker 1bps / taker 3.5bps），并重新落库。 */
  private backfillTaker(): void {
    for (const rec of this.records) {
      if (rec.taker !== undefined) continue;
      const taker = inferTaker(rec.fee, rec.notional);
      if (taker === undefined) continue;
      rec.taker = taker;
      if (this.persist) this.queueForPersistence(rec);
    }
  }

  private queueForPersistence(rec: AccountingRecord): void {
    this.pending.push(rec);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 300);
  }

  /** 批量落库；失败时保留待写队列并延后重试（不丢成交）。 */
  private async flush(): Promise<void> {
    const batch = this.pending.splice(0, this.pending.length);
    if (batch.length === 0) return;
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ records: batch }),
      });
      if (!res.ok) throw new Error(`POST ${res.status}`);
    } catch {
      this.pending.unshift(...batch);
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, 2000);
      }
    }
  }

  private bump(): void {
    this._version += 1;
    for (const fn of this.listeners) {
      try { fn(); } catch { /* 单个监听器出错不影响其它 */ }
    }
  }
}

/** 全局单例；浏览器中构造时立刻开始回放服务端历史。 */
export const accountingLedger = new AccountingLedger();
if (typeof window !== "undefined") accountingLedger.hydrate();
