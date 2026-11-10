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
import { placeOrderLive, closePositionLive, closeAllPositionsLive, cancelLive, marketTouchLive, readWalletBalances, readPositionSizeLive, beginPriorityReads, endPriorityReads, takeWriteTiming, type WriteTiming } from "./liveContext";
import { activeNetwork } from "./chainEnv";
import { shuffle } from "./rand";
import { MIN_SPREAD_TICKS } from "./tradingRules";
import { ensureClockOffset } from "./nadoClock";
import { balancePairRoles, ROLE_BALANCE_ENABLED } from "./roleBalance";
import { pickFatterMarket } from "./marketSwitch";
import { getLiveConfig, productFor } from "./liveConfig";
import { startBboCache, stopBboCache, getBboQuote } from "./bboCache";
import { notePairInventory, inventorySummary, resetInventoryWatch,
  inventoryOverThreshold, clearInventory, setInventorySimulation, setInventoryThreshold, INVENTORY_THRESHOLD_USDT0,
} from "./inventoryWatch";
import { accountingLedger } from "./accountingLedger";

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
  /** 余额失衡自动换了 maker/taker 角色后触发：页面的钱包列表据此重新拉取，标签立刻更新（不必等整轮跑完）。 */
  onRolesChanged?: () => void;
  /** 页面缓存的余额查询（walletId → USDT0 数值）；没有读数返回 null。
   *  逐对角色平衡优先用它，省掉每个钱包一次 per-IP 读。 */
  balanceOf?: (walletId: string) => number | null;
  /** 角色被逐对调换后，从页面重新取一次 maker / taker 分组，下一轮按新角色配对。 */
  reloadRoles?: () => { makers: WalletVM[]; takers: WalletVM[] } | null;
  /** 点差不足连续多轮后自动换了标的：页面据此同步 Market 选择框，避免面板显示的还是旧标的。 */
  onMarketChanged?: (market: string) => void;
}

export interface RoundResult {
  pairs: number;
  /** Pairs whose maker + taker both submitted (NOT a fill count — fills come from WS reconcile). */
  traded: number;
  /** Pairs skipped because the spread was too tight / the book one-sided for a clean self-cross. */
  skipped: number;
  errors: number;
  /** 本轮因为余额偏低而互换了 maker/taker 角色的对数（调用方据此重新分组）。 */
  roleSwaps: number;
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

/** 点差不足属于「市场暂时打不了自成交」，不是引擎卡住：给它更长的等待窗口，
 *  否则盘口一收窄就 3 轮退场（实测 META bid 626.98 / ask 627.00 就是这样停的）。 */
const THIN_SPREAD_LIMIT = 60;

/** 连续多少轮点差不足就尝试换标的：5 轮足够排除一次短暂的抖动，又不会在窄盘口上白等太久。
 *  换到更宽的标的后计数归零；找不到合格标的则再等 5 轮重试。 */
const THIN_SPREAD_SWITCH_AFTER = 5;

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
      // 读失败（429 / 网络抖动）必须和「真的没保证金」分开：readWalletBalances 内部把异常吞成
      // undefined，直接按 0 处理会让一次限速就把有钱的钱包误判成「无抵押」，进而整轮/整 run 停下
      // （实测 16:45:54 就是这样停的）。所以先退避重读 3 次。
      let balances: Awaited<ReturnType<typeof readWalletBalances>>["balances"];
      for (let attempt = 0; attempt < 3; attempt++) {
        balances = (await readWalletBalances(w.id)).balances;
        if (balances) break;
        if (attempt < 2) await sleepMs(500 * (attempt + 1)); // 0.5s → 1s
      }
      if (!balances) {
        // 三次都读不到 = 状态未知（不是「没钱」）：放行，让下单时的引擎校验兜底（2006 会安全拒绝）
        hooks.log(`⚠ ${short(w)} (${role}) 余额读不到（限速/网络），按「未知」放行。`);
        ok.push(w);
        continue;
      }
      const quote = balances.find((b) => b.scope === "margin");
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

/** 从 WS 的 all_bbo 快照里取盘口（零 REST 配额、毫秒级）。取不到 / 过期 / 单边 → undefined，
 *  调用方回退到 REST 读盘口。all_bbo 的价格是 x18 定点的，这里除回人类小数。 */
async function cachedTouch(market: string): Promise<{ bid: number; ask: number; tick: number; tickStr: string } | undefined> {
  try {
    const cfg = await getLiveConfig(); // 本地已缓存，不发请求
    const p = productFor(cfg, market);
    if (!p) return undefined;
    const q = getBboQuote(p.productId);
    if (!q) return undefined;
    const bid = Number(q.bid) / 1e18;
    const ask = Number(q.ask) / 1e18;
    const tick = Number(p.tickSize);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || !(tick > 0)) return undefined;
    if (!(bid > 0) || !(ask > 0) || ask < bid) return undefined;
    return { bid, ask, tick, tickStr: p.tickSize };
  } catch {
    return undefined;
  }
}

/** 取自成交价；拿不到时返回跳过原因（空盘口 / 点差太窄），方便在日志里判断是不是选错了品种。 */
async function selfCrossPrice(walletId: string, market: string, makerSide: "buy" | "sell"): Promise<
  { price: string; priceNum: number } | { skip: string }
> {
  // 优先吃 WS 快照：这一步原来要占一次 REST 读配额（per-IP 只有 ~2 次/秒），
  // 排队严重时「round 开始 → maker 提交」能到 7s。缓存过期或没有行情时再走 REST。
  const cached = await cachedTouch(market);
  const touch = cached ?? await marketTouchLive(walletId, market);
  if (!touch) throw new Error(`品种 ${market} 在当前网络没有对应的产品（选错品种或网络不匹配）`);
  // 读失败（限速 / 网络抖动）不能当成「空盘口」，两者原因和处置完全不同（WS 快照不会有 failed）
  if ("failed" in touch && touch.failed) return { skip: "读盘口失败（限速 429 或网络抖动），本轮跳过" };
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

/** 平仓一次：区分「已确认平掉」「读不到持仓（429 等，无法确认）」「下单被拒」三种情况。
 *  失败时把真实原因带出去 —— 以前这里 catch 掉了错误，日志只剩「未确认」，没法判断是限速、
 *  没流动性还是保证金不足（2006），排障只能靠猜。 */
async function flattenOnce(walletId: string, market: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await closePositionLive(walletId, market);
    if (!r.closed) return { ok: true }; // 本来就没仓
    // 下单成功 ≠ 已平掉：薄盘上的 reduceOnly IOC 可能一笔都没成交（或只成交一部分）。
    // 等撮合结果落到「持仓」，再读一次真实仓位确认，残留就继续重试 —— 以前缺这一步，
    // 会出现「日志说在平仓、实际仓位一点没动」的情况。
    await sleepMs(400);
    const left = await readPositionSizeLive(walletId, market);
    if (Math.abs(left) > 1e-9) return { ok: false, error: `平仓单已发但仍有 ${left} 未平` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 平仓 + 确认重试：429 / 读持仓失败按 1s→2s→4s 退避重读，最多 4 次；
 *  仍失败则标记为「未确认平仓」，交给下一对的 dirtyWallets 再清扫。返回是否确认平掉。 */
async function flattenWithRetry(walletId: string, market: string, hooks: RoundHooks, label: string): Promise<boolean> {
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await flattenOnce(walletId, market);
    if (r.ok) {
      dirtyWallets.delete(walletId);
      return true;
    }
    if (r.error) lastError = r.error;
    await sleepMs(1000 * (attempt + 1));
  }
  dirtyWallets.add(walletId);
  hooks.log(`✗ flatten ${label} 未确认（已重试 4 次${lastError ? `，最后一次原因：${lastError.slice(0, 140)}` : ""}；下一对开始前会再平一次）`);
  return false;
}

/** 净额对冲模式下的「按需平仓」：只有该钱包在这个市场的净仓顶到阈值才真平，平完把虚拟净仓归零。
 *  没顶到就原地保留 —— 这一对的两条腿方向相反、数量相同，仓位在同一市场的不同钱包之间互相抵消。 */
async function flattenIfOverThreshold(w: WalletVM, market: string, hooks: RoundHooks, label: string): Promise<void> {
  if (!inventoryOverThreshold(w.id, market)) return;
  if (await flattenWithRetry(w.id, market, hooks, label)) clearInventory(w.id, market);
}

/** 平仓也走自成交（新模式）：上一轮的**吃单方**挂一张 reduce-only + post-only，上一轮的**挂单方**
 *  用 reduce-only IOC 去吃它 —— 两条平仓腿在同一价格上互相对敲，不再各自去撞外部盘口。
 *
 *  角色对应（开仓时 maker 方向 = makerSide）：
 *    makerSide=buy  → maker 持多、taker 持空 → 平仓：taker 挂 buy、maker 吃 sell
 *    makerSide=sell → maker 持空、taker 持多 → 平仓：taker 挂 sell、maker 吃 buy
 *  即「挂单方 = 上一轮的吃单方，方向与上一轮 maker 相同」，两个钱包每对各当一次 maker / taker。
 *
 *  失败（仓位不足、点差不够、挂单被第三方吃掉、IOC 没吃到）统一返回 ok=false，由调用方回退市价平仓。 */
async function closePairSelfCross(
  maker: WalletVM, taker: WalletVM, market: string, hooks: RoundHooks,
  makerSide: "buy" | "sell", takerSide: "buy" | "sell", size: string | number,
): Promise<{ ok: boolean; price?: string; ms: number; error?: string }> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  let restingVenueId: string | undefined;
  try {
    // 不再读两边的真实持仓（每对省 2 个 REST 令牌，429 概率明显下降）：
    // 自成交的开仓两腿是「同一价位上的唯一对手方」，一边成交多少另一边就是多少，
    // 所以两边仓位天然等量 —— 平仓数量直接用这一对的数量。
    // 万一某条腿没成交 / 只部分成交，reduce-only 超量会被拒或被引擎截断，绝不会反向开仓，
    // 最后仍由调用方回退市价平仓兜底（那条路径会重新读真实持仓）。
    const qty = Number(size);
    if (!(qty > 0)) return { ok: false, ms: ms(), error: `数量无效（${size}）` };
    // 平仓价同样取「离挂单方这一侧最近」的内沿 tick，给吃单腿留最大的量
    const px = await selfCrossPrice(taker.id, market, makerSide);
    if ("skip" in px) return { ok: false, ms: ms(), error: px.skip };

    // 平仓一对要发 4 笔写（开仓 2 + 平仓 2），很容易撞上 per-IP 写配额。
    // 命中 429 时先退避重试一次再认输 —— 直接回退市价平仓等于把省下的点差又吐回去。
    const tryPlace = async (
      fn: () => Promise<Awaited<ReturnType<typeof placeOrderLive>>>,
    ): Promise<Awaited<ReturnType<typeof placeOrderLive>>> => {
      try {
        return await fn();
      } catch (e) {
        if (!isRateLimited(e)) throw e;
        hooks.log(`⏳ 平仓自成交撞到限速，退避 ${RATE_LIMIT_BACKOFF_MS / 1000}s 后重试`);
        await sleepMs(RATE_LIMIT_BACKOFF_MS);
        return await fn();
      }
    };

    // ① 上一轮的吃单方挂 reduce-only + post-only（既不主动吃别人，也不会反向开仓）
    const rest = await tryPlace(() => placeOrderLive(taker.id, market, {
      side: makerSide, size: qty, price: px.price,
      postOnly: true, reduceOnly: true, jobId: `close-${Date.now()}-r`, signal: hooks.signal,
    }));
    restingVenueId = rest.venueId;
    try {
      // ② 上一轮的挂单方 IOC 去吃它
      await tryPlace(() => placeOrderLive(maker.id, market, {
        side: takerSide, size: qty, price: px.price,
        taker: true, reduceOnly: true, jobId: `close-${Date.now()}-t`, signal: hooks.signal,
      }));
    } catch (e) {
      // 吃单腿失败：挂单还留在盘口上，先撤掉再抛出去，避免残留挂单被第三方吃掉
      await cancelLive(taker.id, market, restingVenueId).catch(() => {});
      throw e;
    }
    restingVenueId = undefined;
    // 撮合结果落到持仓有延迟，等一下再复核两边是否都归零
    await sleepMs(400);
    const [m2, t2] = await Promise.all([
      readPositionSizeLive(maker.id, market),
      readPositionSizeLive(taker.id, market),
    ]);
    if (Math.abs(m2) > 1e-9 || Math.abs(t2) > 1e-9) {
      return { ok: false, price: px.price, ms: ms(), error: `仍有残留（maker ${m2} / taker ${t2}）` };
    }
    return { ok: true, price: px.price, ms: ms() };
  } catch (e) {
    if (restingVenueId) await cancelLive(taker.id, market, restingVenueId).catch(() => {});
    return { ok: false, ms: ms(), error: e instanceof Error ? e.message : String(e) };
  }
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

/** 收尾方式（三个同级模式）：
 *  - pair      逐对平仓：每对结束，两个钱包各自市价平掉（外部成交，跨点差）
 *  - selfCross 平仓自成交：两条平仓腿也互相对敲（同价成交，不跨点差，自成交量翻倍）
 *  - hedge     净额对冲：不平，仓位留在钱包里互相抵消，单钱包净仓顶到阈值才平 */
export type FlattenMode = "pair" | "selfCross" | "hedge";

// 由 runContinuous 的 opts.mode 决定（opts.hedge 仍兼容）
let MODE: FlattenMode = "pair";

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
      // 库存观察（只统计）：按成交累加虚拟净仓，模拟「不平仓会积累多少、阈值策略下能省多少」。
      // 真实流程仍在 finally 里平仓，这里不改变任何下单行为。
      notePairInventory({
        makerId: maker.id, takerId: taker.id, market: cfg.market,
        symbol: symbolOfMarket(cfg.market), makerSide, size, price: Number(px.priceNum),
      });
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
      if (MODE === "hedge") {
        // 净额对冲：仓位保留在钱包里（同一市场的两侧彼此抵消），只有单钱包净仓顶到阈值才平掉，
        // 这样「每对两笔市价平仓」的外部成交量就没有了 —— 代价是单钱包敞口变大，需要足够的保证金。
        // 串行执行：两个钱包的仓位方向相反，同时发市价单容易在同一档流动性上互撞，也会一次性
        // 打满 relay 的读/写配额；串行更稳，且每笔失败都能拿到单独的原因。
        if (inventoryOverThreshold(maker.id, cfg.market) || inventoryOverThreshold(taker.id, cfg.market)) {
          hooks.log("◆ 单钱包净仓达到阈值，开始平仓");
        }
        await flattenIfOverThreshold(maker, cfg.market, hooks, short(maker));
        await flattenIfOverThreshold(taker, cfg.market, hooks, short(taker));
      } else if (MODE === "selfCross") {
        // 平仓自成交：两条平仓腿互相对敲，成交在同一内沿价上 —— 不跨点差，且这对的成交量翻倍。
        // 失败（点差不够 / 挂单被抢 / IOC 没吃到）就回退成市价平仓，保证不残留仓位。
        const r = await closePairSelfCross(maker, taker, cfg.market, hooks, makerSide, takerSide, size);
        if (r.ok) {
          // 两边都归零了，把库存观察里的虚拟净仓同步清零
          clearInventory(maker.id, cfg.market);
          clearInventory(taker.id, cfg.market);
          hooks.log(`↩ 平仓自成交：${short(taker)} 挂 ${makerSide} ↔ ${short(maker)} 吃 ${takerSide} @ ${r.price}（${(r.ms / 1000).toFixed(1)}s）`);
        } else {
          hooks.log(`⚠ 平仓自成交未完成（${r.error}），回退市价平仓`);
          await Promise.all([
            flattenWithRetry(maker.id, cfg.market, hooks, short(maker)),
            flattenWithRetry(taker.id, cfg.market, hooks, short(taker)),
          ]);
        }
      } else {
        // 两个钱包的平仓互不依赖（不同钱包 = 不同 nonce lane），并行执行能把这段收尾时间砍掉一半。
        await Promise.all([
          flattenWithRetry(maker.id, cfg.market, hooks, short(maker)),
          flattenWithRetry(taker.id, cfg.market, hooks, short(taker)),
        ]);
      }
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
    return { pairs: 0, traded: 0, skipped: 0, errors: 0, roleSwaps: 0 };
  }
  // 手动配对优先：用户指定的一对一关系按原顺序跑；没指定时才用「两侧洗牌后 1:1」的原有逻辑
  const pairs = cfg.manualPairs && cfg.manualPairs.length > 0
    ? cfg.manualPairs.map(([m, t]) => [m, t] as [WalletVM, WalletVM])
    : buildPairs(makers, takers);
  if (pairs.length === 0) {
    hooks.log("No pairs — need at least one maker and one taker.");
    return { pairs: 0, traded: 0, skipped: 0, errors: 0, roleSwaps: 0 };
  }
  // 逐对角色平衡：每对里 taker 的保证金必须高于 maker（taker 手续费更高、消耗更快）。
  // 手动配对 = 用户把角色定死了，不覆盖；总开关关闭时整段跳过（零额外读）。
  let roleSwaps = 0;
  if (ROLE_BALANCE_ENABLED && !(cfg.manualPairs && cfg.manualPairs.length > 0)) {
    const balanced = await balancePairRoles(pairs, hooks.balanceOf, hooks.log);
    roleSwaps = balanced.swapped;
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
  // 库存观察：每轮末尾输出累计口径（虚拟净仓 / 峰值 / 阈值策略下能省多少），只打日志不干预交易。
  for (const line of inventorySummary()) hooks.log(line);
  return { pairs: pairs.length, traded, skipped, errors, roleSwaps };
}

/** 这批钱包的累计已实现盈亏（**不含手续费**）：直接读成交账本里逐笔的 realizedPnl
 *  （本地 FIFO 配对，开仓成交记 0）。取两次采样的差值，就是这一轮的毛盈亏。 */
function realizedPnlOf(walletIds: ReadonlySet<string>): number {
  let sum = 0;
  for (const r of accountingLedger.records) {
    if (!walletIds.has(r.walletId)) continue;
    if (typeof r.realizedPnl === "number" && Number.isFinite(r.realizedPnl)) sum += r.realizedPnl;
  }
  return sum;
}

/** 面板上保留的交易摘要：第几轮 + 本轮盈亏（手续费不在这里扣，另有账本统计）。 */
const roundPnlLine = (round: number, pnl: number): string =>
  `▶ round ${round} 完成｜本轮盈亏 ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT0（不含手续费）`;

/** Run rounds back to back until the signal aborts — the continuous benchmark loop behind the Run/Pause
 *  toggle. The round SIDE is re-rolled each round (so the maker cohort alternates between buying and
 *  selling over time), and abort is honored between rounds AND, via runRound, between pairs — so Pause
 *  stops within the current pair, not at the end of a long round. 对与对之间留 PAIR_GAP_MS 的间隔，
 *  命中限速时按倍数退避重试 —— 宁可慢一点，也不要因为 429 把整轮都跳过、甚至把 IP 打封。 */
export async function runContinuous(makers: readonly WalletVM[], takers: readonly WalletVM[], base: Omit<RoundConfig, "makerBuys"> & { maxRounds?: number; hedge?: boolean; hedgeThreshold?: number; mode?: FlattenMode }, hooks: RoundHooks): Promise<void> {
  const net = activeNetwork();
  if (!net.isTestnet && !base.mainnetConfirmed) {
    hooks.log(MAINNET_UNCONFIRMED_MSG);
    return;
  }
  const caps: Caps = { wallet: net.caps.walletUsdt0, cohort: net.caps.cohortUsdt0 };
  const state = freshCapState();
  // 时钟预热：把第一次 ensureClockOffset 的 3 次 ping（dev 模式下还有 /api/nado/clock 的路由编译）
  // 挪出下单关键路径 —— 实测首轮的「本地耗时」会因为它多出 3s 左右。
  await ensureClockOffset().catch(() => {});
  // 库存观察的统计口径 = 一次 run（Pause 后重跑会重新开始累计）
  resetInventoryWatch();
  // 模式选择：净额对冲时统计要跟踪「真实净仓」（不能被模拟截断），否则阈值判断会失准；
  // 两种平仓模式都是「每对做完就归零」，净值只用于展示，保留模拟口径即可。
  MODE = base.mode ?? (base.hedge === true ? "hedge" : "pair");
  setInventorySimulation(MODE !== "hedge");
  const threshold = base.hedgeThreshold && base.hedgeThreshold > 0 ? base.hedgeThreshold : INVENTORY_THRESHOLD_USDT0;
  setInventoryThreshold(threshold);
  hooks.log(
    MODE === "hedge"
      ? `◆ 模式：净额对冲 — 仓位留在钱包里互相抵消，单钱包净仓 ≥ ${threshold} USDT0 才平`
      : MODE === "selfCross"
        ? "◆ 模式：平仓自成交 — 平仓两腿互相对敲，不跨点差，自成交量翻倍"
        : "◆ 模式：逐对平仓 — 每对结束都平掉两腿",
  );
  // Eligibility: only wallets with collateral trade (orders are gasless, so gas isn't required). Snapshot
  // at run start — log each ineligible wallet once, then run the eligible subset.
  // 这两个数组会被「逐对余额平衡 / 重新分组」整体替换，所以用 let
  let eMakers = await eligible(makers, "maker", hooks);
  let eTakers = await eligible(takers, "taker", hooks);
  // 手动配对的名单也要过一遍「可交易」检查：任一腿不可用就跳过这一对，别拖累其它配对
  const pinned = base.manualPairs?.filter(([m, t]) => eMakers.includes(m) && eTakers.includes(t)) ?? [];
  // 手动配对 = 用户把 maker/taker 角色定死了，余额自动平衡不去覆盖它
  if (pinned.length) hooks.log("⚖ 手动配对已锁定角色，余额自动平衡不生效。");
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
  let thinSpread = 0; // 连续「点差不足」的轮次（不计入 noTrade）
  // 当前标的：点差连续不足 THIN_SPREAD_SWITCH_AFTER 轮时会被换掉，所以不能直接用 base.market
  let activeMarket = base.market;
  // 本次运行里已经因为点差不足放弃过的标的：避免在两个窄盘口之间来回跳；
  // 一旦有轮次真正成交（说明市场恢复了），就清空重新允许。
  const avoidedMarkets = new Set<string>();
  // 本轮盈亏的采样基准。成交回执（WS）有一小段延迟，所以「上一轮的结算」放到下一轮开头再做：
  // 既不用在轮次之间插等待，也不会把还没落账的成交算漏。
  const runWalletIds = new Set([...eMakers, ...eTakers].map((w) => w.id));
  let pnlMark: { round: number; base: number } | null = null;
  // 取价改用 WS 的 all_bbo 快照：一轮一对的开头不再消耗 REST 读配额（per-IP ~2 次/秒），
  // 排队造成的「round 开始 → maker 提交」空等随之消失。地址与页面点差监听同源。
  const cfgForBbo = await getLiveConfig().catch(() => undefined);
  if (cfgForBbo?.wsSubscribeUrl) startBboCache(cfgForBbo.wsSubscribeUrl);
  // 开跑之前先把这批钱包的残留仓位清掉（上一次运行被 Pause / 429 打断时可能留下敞口）。
  // closeAllPositionsLive 读一次持仓，再对每个非零仓位发 reduce-only 穿价 IOC，等同市价全平。
  await flattenAll([...eMakers, ...eTakers], hooks, "start");
  // 角色平衡改为「每轮开始前」在 runRound 里逐对执行（见 roleBalance.ts），这里不再单独查一次。
  while (!hooks.signal?.aborted) {
    round++;
    // 结算上一轮（此时它的成交已经全部落账）
    if (pnlMark) hooks.log(roundPnlLine(pnlMark.round, realizedPnlOf(runWalletIds) - pnlMark.base));
    hooks.onRoundStart?.();
    const makerBuys = Math.random() < 0.5;
    hooks.log(`▶ round ${round} — makers ${makerBuys ? "buy" : "sell"}`);
    pnlMark = { round, base: realizedPnlOf(runWalletIds) };
    const r = await runRound(eMakers, eTakers, { ...base, market: activeMarket, makerBuys, manualPairs: pinned }, hooks, caps, state);
    // 本轮有对互换了角色：cohort 标签已经写回，重新从页面取一次分组，下一轮按新角色配对；
    // 同时通知页面刷新钱包，maker / taker 标签立刻更新（不必等整轮跑完）。
    if (r.roleSwaps > 0) {
      const reloaded = hooks.reloadRoles?.();
      if (reloaded) { eMakers = reloaded.makers; eTakers = reloaded.takers; }
      hooks.onRolesChanged?.();
    }
    // Stop when the run can't make progress: an empty cohort, a cohort that hit its cumulative cap, or a
    // run of consecutive rounds that trade nothing (a tight market or every wallet capped) — a single
    // transient dead round is tolerated. A normal round keeps looping (the setTimeout(0) yields between).
    if (r.pairs === 0) { hooks.log("■ nothing to trade — stopping."); break; }
    // 用户指定了轮次上限（>0）时，跑满就停；0/未填表示一直跑到 Pause
    if (base.maxRounds && round >= base.maxRounds) { hooks.log(`■ ${round} round(s) done — stopping.`); break; }
    if (state.maker >= caps.cohort || state.taker >= caps.cohort) { hooks.log(`■ cohort spend cap ($${caps.cohort}) reached — stopping.`); break; }
    // 点差不足单独计数（见 THIN_SPREAD_LIMIT）：不算引擎故障，只是市场暂时没有内沿空间，
    // 所以这类轮次不计入 noTrade（否则盘口一收窄照样 3 轮退场）。
    const thinRound = r.traded === 0 && r.skipped > 0 && r.errors === 0;
    noTrade = r.traded > 0 ? 0 : thinRound ? noTrade : noTrade + 1;
    if (noTrade >= NO_TRADE_LIMIT) { hooks.log(`■ no pairs traded in ${NO_TRADE_LIMIT} rounds — stopping.`); break; }
    thinSpread = thinRound ? thinSpread + 1 : 0;
    // 有成交 = 盘口恢复了，把「放弃过的标的」清空，允许以后重新换回去
    if (r.traded > 0) avoidedMarkets.clear();
    // 连续 5 轮点差不足：换一个点差更宽的标的继续，而不是继续在窄盘口上白等。
    // 每满 5 轮才尝试一次（5/10/15…），避免每轮重复查找；换成功才把计数归零，
    // 找不到合格标的就继续累计 —— 真的一直没有宽盘口时仍由下面的 THIN_SPREAD_LIMIT 收尾。
    if (thinSpread >= THIN_SPREAD_SWITCH_AFTER && thinSpread % THIN_SPREAD_SWITCH_AFTER === 0) {
      const pick = await pickFatterMarket(activeMarket, avoidedMarkets);
      if (pick) {
        avoidedMarkets.add(activeMarket);
        hooks.log(`⇄ 点差连续 ${thinSpread} 轮不足 ${MIN_SPREAD_TICKS} tick — 自动切换标的 ${symbolOfMarket(activeMarket)} → ${symbolOfMarket(pick.market)}（当前点差 ${pick.ticks} tick）`);
        activeMarket = pick.market;
        hooks.onMarketChanged?.(activeMarket);
        thinSpread = 0;
      } else {
        hooks.log(`⚠ 点差连续 ${thinSpread} 轮不足 ${MIN_SPREAD_TICKS} tick，但暂时没有其它点差够宽的标的 — 继续用 ${symbolOfMarket(activeMarket)}`);
      }
    }
    if (thinSpread >= THIN_SPREAD_LIMIT) { hooks.log(`■ 点差连续 ${THIN_SPREAD_LIMIT} 轮不足 ${MIN_SPREAD_TICKS} tick — stopping.`); break; }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // 循环结束（跑满轮次 / 提前停止 / Pause）后再清扫一遍：有未平仓位就市价全部平掉，
  // 不留敞口给下一次运行。这里不带 signal，Pause 也会照常执行。
  await flattenAll([...eMakers, ...eTakers], hooks, "end");
  // 收尾平仓的单子也可能就是这个 run 的最后成交：停之前把最后一轮的盈亏补上
  if (pnlMark) hooks.log(roundPnlLine(pnlMark.round, realizedPnlOf(runWalletIds) - pnlMark.base));
  stopBboCache(); // 收尾后关掉行情订阅（页面自己的点差监听不受影响）
  hooks.log("■ stopped.");
}
