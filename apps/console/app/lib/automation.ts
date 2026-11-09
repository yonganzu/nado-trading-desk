// The self-cross load engine. A "round" trades every maker↔taker pair once: the maker rests a post-only
// order at a tick STRICTLY INSIDE the spread and the taker crosses it with an IOC hard-limited to that
// same price. Because the price sits between the real best bid and ask (≥1 tick from each), the maker
// rests alone there and the taker can reach only that maker — never third-party liquidity. A pair whose
// spread is too tight for an interior tick (or whose book is one-sided/empty) is SKIPPED, not forced.
// Each traded pair then flattens and clears any resting remainder, so the next round starts flat.
//
// This is the lean in-tab loop over the liveContext primitives — no node coordinator — driven by the
// sidebar's Run/Pause toggle: continuous rounds with per-wallet + per-cohort cumulative caps, a per-run
// typed-RUN confirm off testnet, and eligibility gating. Eligibility admits wallets WITH COLLATERAL
// (readiness funded|ready), not strict "ready": Nado orders are gasless, so collateral is the real
// requirement, and gas is stale-while-revalidate (a strict-ready gate would flakily skip tradeable
// wallets). A pair whose placement throws is retried a few times, then skipped.
import type { WalletVM } from "@farm/ui";
import { placeOrderLive, closePositionLive, closeAllPositionsLive, cancelLive, marketTouchLive, readWalletBalances, beginPriorityReads, endPriorityReads, takeWriteTiming, type WriteTiming } from "./liveContext";
import { activeNetwork } from "./chainEnv";
import { shuffle } from "./rand";
import { MIN_SPREAD_TICKS } from "./tradingRules";

/** Logged when the engine refuses an off-testnet run that wasn't confirmed — the UI's typed-RUN gate is
 *  the real guard; this backstop catches a non-UI caller. One string so UI + engine never drift. */
export const MAINNET_UNCONFIRMED_MSG = "✗ mainnet automation needs the typed RUN confirm.";

/** 每对之间的间隔（毫秒）：共享的 per-IP 读预算只有 ~2 次/秒，连续猛发会把预算打空、
 *  触发 429（读不到盘口 → 整对跳过），于是「发得越快、成交越少」。
 *  留一段间隔，让每对的两条腿（挂单 + 吃单）都有配额可用，成交率反而更高。 */
const PAIR_GAP_MS = 1200;

/** 命中限速（429）后的额外退避：第 N 次重试等 N × 该值，避免把封禁窗口越撞越长。 */
const RATE_LIMIT_BACKOFF_MS = 4000;

/** 判断异常是不是限速：relay 的 429 / 明确的 rate limit 文案。 */
function isRateLimited(e: unknown): boolean {
  const msg = (e as Error)?.message ?? String(e);
  return /429|rate.?limit|too many requests/i.test(msg);
}

/** 可被 abort 打断的等待：Pause 时立即返回，不拖住收尾。 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface RoundConfig {
  /** Market id to trade (resolves to a live product; the whole round stays on this one market). */
  market: string;
  /** Per-pair USDT0 notional is drawn uniformly from [minNotional, maxNotional]. */
  minNotional: number;
  maxNotional: number;
  /** The round's side: true → makers buy / takers sell, false → the reverse. Re-rolled per round. */
  makerBuys: boolean;
  /** Required to run off testnet — the UI sets it only after the per-run typed-RUN confirm. */
  mainnetConfirmed?: boolean;
  /** 用户手动指定的 [maker, taker] 配对。非空时按这个顺序逐对开打（不再随机重排），
   *  为空则沿用原来的「两侧随机洗牌后 1:1 配对」。 */
  manualPairs?: ReadonlyArray<readonly [WalletVM, WalletVM]>;
}

export interface RoundHooks {
  /** Append one human-readable line to the sidebar automation log. */
  log: (msg: string) => void;
  /** Cooperative cancel — checked between pairs and threaded into the in-tab calls that start new work. */
  signal?: AbortSignal;
  /** Fires as each round begins — the filmstrip refills its drained queue. */
  onRoundStart?: () => void;
  /** Fires when a pair begins trading — the filmstrip moves it leftmost. */
  onPairStart?: (pair: readonly [WalletVM, WalletVM]) => void;
  /** Fires when a pair finishes — the filmstrip drains it; a "traded" one also feeds the metrics (+ ms). */
  onPairEnd?: (pair: readonly [WalletVM, WalletVM], outcome: "traded" | "skipped" | "error", ms: number) => void;
}

export interface RoundResult {
  pairs: number;
  /** Pairs whose maker + taker both submitted (NOT a fill count — fills come from WS reconcile). */
  traded: number;
  /** Pairs skipped because the spread was too tight / the book one-sided for a clean self-cross. */
  skipped: number;
  errors: number;
}

const short = (w: WalletVM) => w.address.value.slice(0, 6);

/** 市场 id 的最后一段就是符号（"nado:perp:BTC-PERP" → "BTC-PERP"）；日志里带上它，
 *  一眼就能确认引擎用的是不是面板里选的那个品种。 */
const symbolOfMarket = (id: string) => id.split(":").pop() ?? id;

/** 单腿日志片段：总耗时 + 三段拆分（本地组装/签名 · 等令牌 · relay 往返）+ relay 重试次数。
 *  例：2.2s（本地 0.2s / relay 2.0s）—— 哪一段占比大，就说明延迟卡在哪一环。 */
const legStr = (ms: number, t: WriteTiming): string => {
  const local = Math.max(0, ms - t.waitMs - t.relayMs);
  const parts = [`本地 ${(local / 1000).toFixed(1)}s`];
  if (t.waitMs >= 50) parts.push(`等令牌 ${(t.waitMs / 1000).toFixed(1)}s`);
  parts.push(`relay ${(t.relayMs / 1000).toFixed(1)}s`);
  if (t.attempts > 1) parts.push(`重试 ${t.attempts - 1} 次`);
  return `${(ms / 1000).toFixed(1)}s（${parts.join(" / ")}）`;
};

const decimals = (tickStr: string): number => {
  const i = tickStr.indexOf(".");
  return i < 0 ? 0 : tickStr.length - i - 1;
};

/** Consecutive rounds that trade nothing before the continuous loop gives up — tolerates a transient
 *  tight spread or sequencer blip, but stops when the market can't host a self-cross or every wallet is
 *  capped. */
const NO_TRADE_LIMIT = 3;

/** Extra attempts for a pair whose placement throws (a transient relay blip) before it's skipped. */
const PAIR_RETRIES = 2;

/** Cumulative spend ceilings for a run (USDT0 notional): per-wallet bounds any single wallet's total,
 *  per-cohort bounds each side's total. From net.caps; Infinity when unbounded. */
interface Caps { wallet: number; cohort: number }
/** Running totals for the current run: notional per wallet, and per cohort side. */
interface CapState { perWallet: Map<string, number>; maker: number; taker: number }

function freshCapState(): CapState { return { perWallet: new Map(), maker: 0, taker: 0 }; }

/** The reason a pair can't trade without breaching a cumulative cap, or null if it fits. */
function capReason(maker: WalletVM, taker: WalletVM, notional: number, caps: Caps, state: CapState): string | null {
  const total = (id: string): number => state.perWallet.get(id) ?? 0;
  if (total(maker.id) + notional > caps.wallet) return `${short(maker)} at its $${caps.wallet} wallet cap（可用 NEXT_PUBLIC_NADO_MAX_WALLET_USDT0 调高，或把 Volume/pair 调小）`;
  if (total(taker.id) + notional > caps.wallet) return `${short(taker)} at its $${caps.wallet} wallet cap（可用 NEXT_PUBLIC_NADO_MAX_WALLET_USDT0 调高，或把 Volume/pair 调小）`;
  if (state.maker + notional > caps.cohort) return `maker cohort at its $${caps.cohort} cap（可用 NEXT_PUBLIC_NADO_MAX_COHORT_USDT0 调高）`;
  if (state.taker + notional > caps.cohort) return `taker cohort at its $${caps.cohort} cap（可用 NEXT_PUBLIC_NADO_MAX_COHORT_USDT0 调高）`;
  return null;
}

/** Add a traded pair's notional to the per-wallet + per-cohort running totals. */
function bumpCaps(state: CapState, makerId: string, takerId: string, notional: number): void {
  state.perWallet.set(makerId, (state.perWallet.get(makerId) ?? 0) + notional);
  state.perWallet.set(takerId, (state.perWallet.get(takerId) ?? 0) + notional);
  state.maker += notional;
  state.taker += notional;
}

/** The subset of wallets eligible to trade — those with collateral (readiness "funded" or "ready"). Nado
 *  orders are gasless, so collateral is the real requirement; a wallet with none can't place. Logs each
 *  ineligible wallet's reason once, at run start.
 *  页面刚打开、或余额还没被扫到时，所有钱包都会显示 `unfunded`（因为「没读到」按 0 处理）。
 *  直接据此拒绝会误杀——所以对显示 unfunded 的钱包现场读一次保证金，读到 >0 就放行。 */
async function eligible(wallets: readonly WalletVM[], role: string, hooks: RoundHooks): Promise<WalletVM[]> {
  const ok: WalletVM[] = [];
  for (const w of wallets) {
    if (w.readiness !== "unfunded") { ok.push(w); continue; }
    try {
      const reads = await readWalletBalances(w.id);
      const quote = reads.balances?.find((b) => b.scope === "margin");
      const margin = Number(quote?.total ?? 0);
      if (margin > 0) { ok.push(w); continue; }
      hooks.log(`⊘ ${short(w)} (${role}) not eligible — no collateral（现场读数 margin ${margin}）。`);
    } catch (e) {
      hooks.log(`⊘ ${short(w)} (${role}) not eligible — 读余额失败：${(e as Error).message}`);
    }
  }
  return ok;
}

/** The self-cross price: a tick STRICTLY inside the spread. A post-only order there does not cross (the
 *  real bid/ask are ≥1 tick away), and an IOC hard-limited to it can fill only against that resting order
 *  — the engine's own maker. Needs a ≥3-tick spread so an interior tick exists with MARGIN; returns null
 *  when the book is too tight or one-sided (the caller SKIPS that pair). Returns a tick-exact decimal
 *  STRING so placeOrderLive's fixed-point alignDown reproduces it with no float drift. Pure — unit-reasoned,
 *  and exercised end-to-end by the 1-tick-book e2e.
 *  传 makerSide 时优先取「离自己这一侧最近」的内沿 tick（买单贴 bid、卖单贴 ask）：对手侧的余量最大
 *  （点差 N tick → 余量 N−1），同时价格仍优于该侧最优价，不会丢掉自己的排队优先。 */
export function interiorTickPrice(bid: number, ask: number, tick: number, tickStr: string, makerSide?: "buy" | "sell"): string | null {
  if (!(bid > 0) || !(ask > 0) || !(tick > 0)) return null; // empty / one-sided book
  const bidTicks = Math.round(bid / tick);
  const askTicks = Math.round(ask / tick);
  if (askTicks - bidTicks < MIN_SPREAD_TICKS) return null; // 点差太窄：余量不足以扛住 2–3s 的提交延迟
  const midTicks = Math.round((bidTicks + askTicks) / 2);
  const pTicks =
    makerSide === "buy" ? bidTicks + 1 :
    makerSide === "sell" ? askTicks - 1 :
    Math.min(Math.max(midTicks, bidTicks + 1), askTicks - 1);
  return (pTicks * tick).toFixed(decimals(tickStr));
}

/** 取自成交价；拿不到时返回跳过原因（空盘口 / 点差太窄），方便在日志里判断是不是选错了品种。 */
async function selfCrossPrice(walletId: string, market: string, makerSide: "buy" | "sell"): Promise<
  { price: string; priceNum: number } | { skip: string }
> {
  const touch = await marketTouchLive(walletId, market);
  if (!touch) throw new Error(`品种 ${market} 在当前网络没有对应的产品（选错品种或网络不匹配）`);
  // 读失败（限速 / 网络抖动）不能当成「空盘口」，两者原因和处置完全不同
  if (touch.failed) return { skip: "读盘口失败（限速 429 或网络抖动），本轮跳过" };
  const price = interiorTickPrice(touch.bid, touch.ask, touch.tick, touch.tickStr, makerSide);
  if (price !== null) return { price, priceNum: Number(price) };
  if (!(touch.bid > 0) || !(touch.ask > 0)) return { skip: `盘口为空或单边（bid ${touch.bid} / ask ${touch.ask}）` };
  const ticks = touch.tick > 0 ? Math.round((touch.ask - touch.bid) / touch.tick) : 0;
  return { skip: `点差只有 ${ticks} tick（bid ${touch.bid} / ask ${touch.ask}，tick ${touch.tickStr}），需要 ≥${MIN_SPREAD_TICKS} tick` };
}

/** Pair makers to takers 1:1 in shuffled order; min(count) pairs form and any surplus on the longer side
 *  sits the round out. Both sides are shuffled so pairings vary round to round. */
export function buildPairs(makers: readonly WalletVM[], takers: readonly WalletVM[]): Array<[WalletVM, WalletVM]> {
  const m = shuffle(makers);
  const t = shuffle(takers);
  const n = Math.min(m.length, t.length);
  const pairs: Array<[WalletVM, WalletVM]> = [];
  for (let i = 0; i < n; i++) pairs.push([m[i]!, t[i]!]);
  return pairs;
}

/** 固定等待（收尾专用：不能被 Pause 打断，否则会漏掉撤单/平仓）。 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 收尾前还挂着仓位（上一轮平仓没确认成功）的钱包：下一对开始前先强制平掉，
 *  否则残留仓位会一路累积，最终把保证金健康度压到 2006「Insufficient account health」。 */
const dirtyWallets = new Set<string>();

/** 平仓一次：区分「已确认平掉」「读不到持仓（429 等，无法确认）」「下单被拒」三种情况。 */
async function flattenOnce(walletId: string, market: string): Promise<"flat" | "retry"> {
  try {
    await closePositionLive(walletId, market);
    return "flat"; // closed=0（本来就平）或已发出平仓单
  } catch {
    return "retry";
  }
}

/** 平仓 + 确认重试：429 / 读持仓失败按 1s→2s→4s 退避重读，最多 4 次；
 *  仍失败则标记为「未确认平仓」，交给下一对的 dirtyWallets 再清扫。返回是否确认平掉。 */
async function flattenWithRetry(walletId: string, market: string, hooks: RoundHooks, label: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await flattenOnce(walletId, market) === "flat") {
      dirtyWallets.delete(walletId);
      return true;
    }
    await sleepMs(1000 * (attempt + 1));
  }
  dirtyWallets.add(walletId);
  hooks.log(`✗ flatten ${label} 未确认（已重试 4 次，可能残留敞口，下一对开始前会再平一次）`);
  return false;
}

/** 一键清扫一组钱包的**全部**未平仓位：逐个读一次持仓，把每个非零仓位用 reduce-only 穿价 IOC
 *  市价平掉（本来就平的只花一次读）。用于「开跑之前」和「循环结束之后」的兜底。
 *  返回仍无法确认平掉的钱包个数。 */
async function flattenAll(wallets: readonly WalletVM[], hooks: RoundHooks, phase: "start" | "end"): Promise<number> {
  const seen = new Set<string>();
  let failed = 0;
  let closed = 0;
  beginPriorityReads();
  try {
    for (const w of wallets) {
      if (seen.has(w.id)) continue; // maker / taker 两个列表可能重复
      seen.add(w.id);
      // 429 / 网络抖动时按 1s→2s→3s 退避重读，最多 4 次
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        try { closed += await closeAllPositionsLive(w.id); ok = true; }
        catch { await sleepMs(1000 * (attempt + 1)); }
      }
      if (ok) dirtyWallets.delete(w.id); else failed++;
    }
  } finally {
    endPriorityReads();
  }
  const label = phase === "start" ? "开盘前" : "收尾";
  if (failed) hooks.log(`⚠ ${label}清扫：${failed}/${seen.size} 个钱包无法确认（可能仍残留敞口，请到持仓面板核对）。`);
  else hooks.log(`✓ ${label}清扫完成 — ${seen.size} 个钱包已检查，发出 ${closed} 笔市价平仓单。`);
  return failed;
}

/** Trade one pair, or skip it when the spread can't host a clean self-cross. On ANY outcome the finally
 *  clears a resting maker remainder and flattens both wallets, so a mid-pair failure never leaks a live
 *  order or leaves inventory for the next round. */
async function runPair([maker, taker]: [WalletVM, WalletVM], i: number, cfg: RoundConfig, hooks: RoundHooks, caps: Caps, state: CapState): Promise<"traded" | "skipped"> {
  const t0 = Date.now();
  const spent = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  // 整对期间提升读取优先级：页面的后台轮询（余额/持仓/挂单）会让位，
  // 否则共享的 per-IP 读预算被后台吃掉后，taker 腿可能排在 20+ 秒之后才发出去，
  // 而 maker 一直挂在盘口上 —— 正是这段时间被外部吃掉、导致 2056「IOC 不跨价」。
  beginPriorityReads();
  try {
    // 上一轮没确认平掉的钱包先清扫，避免残留仓位把健康度压到 2006
    for (const w of [maker, taker]) {
      if (dirtyWallets.has(w.id) && !(await flattenWithRetry(w.id, cfg.market, hooks, short(w)))) {
        hooks.log(`⊘ pair ${i + 1} skipped @ ${symbolOfMarket(cfg.market)} — 残留仓位未能平掉（${short(w)}），先不打这一对（${spent()}）。`);
        return "skipped";
      }
    }
    const makerSide = cfg.makerBuys ? "buy" : "sell";
    // 先算出 maker 的方向，再取价：自成交价要取「离自己这一侧最近」的内沿 tick（对手侧余量最大）
    const px = await selfCrossPrice(maker.id, cfg.market, makerSide);
    if ("skip" in px) {
      hooks.log(`⊘ pair ${i + 1} skipped @ ${symbolOfMarket(cfg.market)} — ${px.skip}（${short(maker)} ↔ ${short(taker)}，${spent()}）。`);
      return "skipped";
    }
    const notional = cfg.minNotional + Math.random() * (cfg.maxNotional - cfg.minNotional);
    // Cumulative caps: skip (don't place) a pair that would push a wallet or a cohort past its ceiling.
    const capped = capReason(maker, taker, notional, caps, state);
    if (capped) {
      hooks.log(`⊘ pair ${i + 1} skipped — ${capped}.`);
      return "skipped";
    }
    const size = notional / px.priceNum;
    const takerSide = cfg.makerBuys ? "sell" : "buy";
    const tag = `pair${i + 1}-${Date.now()}`; // jobId for placeOrderLive's own idempotent submit; a pair-level retry uses a fresh tag, and the finally cancels any maker a failed attempt left resting
    let makerSubmitted = false;
    let makerVenueId: string | undefined;
    let legsMs = 0; // maker 挂上 → taker 发出之间的间隔（暴露窗口）
    let makerMs = 0;   // maker 腿自身耗时（组装+签名+relay+sequencer）
    let takerMs = 0;   // taker 腿自身耗时（= 两腿间隔的暴露窗口）
    // 两腿各自的耗时分解（等令牌 / relay 往返 / 本地），由 liveContext 的 transport 记录
    let makerT: WriteTiming = { waitMs: 0, relayMs: 0, attempts: 1 };
    let takerT: WriteTiming = { waitMs: 0, relayMs: 0, attempts: 1 };
    try {
      makerSubmitted = true; // set BEFORE the await — a maker order that lands but whose call throws must still be cancelled
      const tMakerStart = Date.now();
      const makerOrder = await placeOrderLive(maker.id, cfg.market, { side: makerSide, size, price: px.price, jobId: `${tag}-m`, signal: hooks.signal });
      makerMs = Date.now() - tMakerStart;
      makerT = takeWriteTiming();
      // 记住交易所侧的挂单 id：收尾时直接按 id 撤，省掉一次 getOpenOrders 读（每对少一次受限读，
      // 缩短从「挂单」到「吃单」的窗口，也降低 429 概率）
      makerVenueId = makerOrder.venueId;
      const tMaker = Date.now();
      await placeOrderLive(taker.id, cfg.market, { side: takerSide, size, price: px.price, taker: true, jobId: `${tag}-t`, signal: hooks.signal });
      legsMs = Date.now() - tMaker;
      takerMs = legsMs;
      takerT = takeWriteTiming();
      bumpCaps(state, maker.id, taker.id, notional); // count it only once both legs are in
      // 两腿间隔拆成 maker 提交 / taker 提交，再拆成「本地 / 等令牌 / relay」：
      // relay 占比高 = 网络或 sequencer 慢；本地占比高 = 签名/组装慢；带「重试 n 次」= 被 429 拖的。
      hooks.log(`✓ pair ${i + 1}: ${short(maker)} ${makerSide} ↔ ${short(taker)} ${takerSide} · ${notional.toFixed(0)} USDT0 @ ${px.price}（${spent()}，两腿间隔 ${(legsMs / 1000).toFixed(1)}s：maker 提交 ${legStr(makerMs, makerT)}，taker 提交 ${legStr(takerMs, takerT)}）`);
      return "traded";
    } finally {
      // Cleanup must NOT be cancellable by the same abort that triggers a Pause — otherwise a mid-pair
      // Pause would strand a resting maker order and un-flattened inventory. So the cancel + flattens run
      // with NO signal: abort stops NEW work, never the cleanup of work already placed. The taker's IOC
      // never rests, so only the maker can leave a resting remainder — cancel it before the flatten reads
      // the position; then flatten both (reduce-only crossing IOC; a no-op when already flat).
      if (makerSubmitted) await cancelLive(maker.id, cfg.market, makerVenueId).catch((e) => hooks.log(`⚠ cancel ${short(maker)} failed: ${(e as Error).message}`));
      // 撮合结果落到「持仓」有一小段延迟：立刻读可能还是 0，于是不平仓、把敞口漏到下一轮。
      // 等一小会儿再读，代价 0.25s，换来的是「每对结束必然平掉」。
      await sleepMs(250);
      await flattenWithRetry(maker.id, cfg.market, hooks, short(maker));
      await flattenWithRetry(taker.id, cfg.market, hooks, short(taker));
    }
  } finally {
    endPriorityReads();
  }
}

/** Run ONE round: trade every maker↔taker pair once, sequentially — the shared per-IP read budget and
 *  the per-wallet nonce lanes make concurrent pairs race, so pairs go one at a time. A pair that throws
 *  is logged and skipped; a pair that would breach a cumulative cap is skipped too; the round carries on.
 *  Off testnet the engine refuses unless cfg.mainnetConfirmed is set (the UI's typed-RUN gate), a backstop
 *  a non-UI caller can't bypass. caps/state default to unbounded + fresh for a standalone round. */
export async function runRound(makers: readonly WalletVM[], takers: readonly WalletVM[], cfg: RoundConfig, hooks: RoundHooks, caps: Caps = { wallet: Infinity, cohort: Infinity }, state: CapState = freshCapState()): Promise<RoundResult> {
  if (!activeNetwork().isTestnet && !cfg.mainnetConfirmed) {
    hooks.log(MAINNET_UNCONFIRMED_MSG);
    return { pairs: 0, traded: 0, skipped: 0, errors: 0 };
  }
  // 手动配对优先：用户指定的一对一关系按原顺序跑；没指定时才用「两侧洗牌后 1:1」的原有逻辑
  const pairs = cfg.manualPairs && cfg.manualPairs.length > 0
    ? cfg.manualPairs.map(([m, t]) => [m, t] as [WalletVM, WalletVM])
    : buildPairs(makers, takers);
  if (pairs.length === 0) {
    hooks.log("No pairs — need at least one maker and one taker.");
    return { pairs: 0, traded: 0, skipped: 0, errors: 0 };
  }
  let traded = 0;
  let skipped = 0;
  let errors = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (hooks.signal?.aborted) { hooks.log("stopped."); break; }
    // Re-check the network each pair: a mid-round switch to mainnet (which doesn't carry this run's
    // confirm) stops the round at the next pair, not after it.
    if (!activeNetwork().isTestnet && !cfg.mainnetConfirmed) { hooks.log(MAINNET_UNCONFIRMED_MSG); break; }
    const pair = pairs[i]!;
    hooks.onPairStart?.(pair);
    const t0 = Date.now();
    // Retry a pair whose placement throws (a transient blip) a few times before giving up on it.
    let outcome: "traded" | "skipped" | undefined;
    for (let attempt = 0; attempt <= PAIR_RETRIES; attempt++) {
      try { outcome = await runPair(pair, i, cfg, hooks, caps, state); break; }
      catch (e) {
        if (hooks.signal?.aborted) break; // a pause, not a failure — the loop-top check ends the round
        // 限速时先退避再重试：立刻重发只会继续撞 429（而且会拉长封禁窗口）
        const wait = isRateLimited(e) ? RATE_LIMIT_BACKOFF_MS * (attempt + 1) : 600 * (attempt + 1);
        if (attempt < PAIR_RETRIES) {
          hooks.log(`↻ pair ${i + 1} retry ${attempt + 1}/${PAIR_RETRIES}（等待 ${wait}ms）: ${(e as Error).message}`);
          await sleepAbortable(wait, hooks.signal);
          continue;
        }
        errors++;
        hooks.log(`✗ pair ${i + 1} failed: ${(e as Error).message}`);
        break;
      }
    }
    if (outcome === "traded") traded++; else if (outcome === "skipped") skipped++;
    hooks.onPairEnd?.(pair, outcome ?? "error", Date.now() - t0);
    // 对与对之间留出间隔，避免把共享的 per-IP 读预算打空（429 会连累后面所有对）
    if (i < pairs.length - 1) await sleepAbortable(PAIR_GAP_MS, hooks.signal);
  }
  hooks.log(`round complete: ${traded}/${pairs.length} traded${skipped ? `, ${skipped} skipped` : ""}${errors ? `, ${errors} error(s)` : ""}`);
  return { pairs: pairs.length, traded, skipped, errors };
}

/** Run rounds back to back until the signal aborts — the continuous benchmark loop behind the Run/Pause
 *  toggle. The round SIDE is re-rolled each round (so the maker cohort alternates between buying and
 *  selling over time), and abort is honored between rounds AND, via runRound, between pairs — so Pause
 *  stops within the current pair, not at the end of a long round. 对与对之间留 PAIR_GAP_MS 的间隔，
 *  命中限速时按倍数退避重试 —— 宁可慢一点，也不要因为 429 把整轮都跳过、甚至把 IP 打封。 */
export async function runContinuous(makers: readonly WalletVM[], takers: readonly WalletVM[], base: Omit<RoundConfig, "makerBuys"> & { maxRounds?: number }, hooks: RoundHooks): Promise<void> {
  const net = activeNetwork();
  if (!net.isTestnet && !base.mainnetConfirmed) {
    hooks.log(MAINNET_UNCONFIRMED_MSG);
    return;
  }
  const caps: Caps = { wallet: net.caps.walletUsdt0, cohort: net.caps.cohortUsdt0 };
  const state = freshCapState();
  // Eligibility: only wallets with collateral trade (orders are gasless, so gas isn't required). Snapshot
  // at run start — log each ineligible wallet once, then run the eligible subset.
  const eMakers = await eligible(makers, "maker", hooks);
  const eTakers = await eligible(takers, "taker", hooks);
  // 手动配对的名单也要过一遍「可交易」检查：任一腿不可用就跳过这一对，别拖累其它配对
  const pinned = base.manualPairs?.filter(([m, t]) => eMakers.includes(m) && eTakers.includes(t)) ?? [];
  if (base.manualPairs?.length && pinned.length === 0) {
    hooks.log("■ 手动配对的钱包都不可交易（无抵押）——stopping.");
    hooks.log("■ stopped.");
    return;
  }
  if (eMakers.length === 0 || eTakers.length === 0) {
    hooks.log("■ no eligible maker/taker pair — stopping.");
    hooks.log("■ stopped.");
    return;
  }
  let round = 0;
  let noTrade = 0;
  // 开跑之前先把这批钱包的残留仓位清掉（上一次运行被 Pause / 429 打断时可能留下敞口）。
  // closeAllPositionsLive 读一次持仓，再对每个非零仓位发 reduce-only 穿价 IOC，等同市价全平。
  await flattenAll([...eMakers, ...eTakers], hooks, "start");
  while (!hooks.signal?.aborted) {
    round++;
    hooks.onRoundStart?.();
    const makerBuys = Math.random() < 0.5;
    hooks.log(`▶ round ${round} — makers ${makerBuys ? "buy" : "sell"}`);
    const r = await runRound(eMakers, eTakers, { ...base, makerBuys, manualPairs: pinned }, hooks, caps, state);
    // Stop when the run can't make progress: an empty cohort, a cohort that hit its cumulative cap, or a
    // run of consecutive rounds that trade nothing (a tight market or every wallet capped) — a single
    // transient dead round is tolerated. A normal round keeps looping (the setTimeout(0) yields between).
    if (r.pairs === 0) { hooks.log("■ nothing to trade — stopping."); break; }
    // 用户指定了轮次上限（>0）时，跑满就停；0/未填表示一直跑到 Pause
    if (base.maxRounds && round >= base.maxRounds) { hooks.log(`■ ${round} round(s) done — stopping.`); break; }
    if (state.maker >= caps.cohort || state.taker >= caps.cohort) { hooks.log(`■ cohort spend cap ($${caps.cohort}) reached — stopping.`); break; }
    noTrade = r.traded === 0 ? noTrade + 1 : 0;
    if (noTrade >= NO_TRADE_LIMIT) { hooks.log(`■ no pairs traded in ${NO_TRADE_LIMIT} rounds — stopping.`); break; }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // 循环结束（跑满轮次 / 提前停止 / Pause）后再清扫一遍：有未平仓位就市价全部平掉，
  // 不留敞口给下一次运行。这里不带 signal，Pause 也会照常执行。
  await flattenAll([...eMakers, ...eTakers], hooks, "end");
  hooks.log("■ stopped.");
}
