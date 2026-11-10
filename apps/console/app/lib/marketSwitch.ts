// =============================================================================
// 点差不足时的标的自动切换。
//
// 背景：自成交要求买一卖一之间至少留 MIN_SPREAD_TICKS 个 tick，否则 maker 挂在内沿没有余量，
// 2–3s 的提交延迟里会被外部单跨价（sequencer 2008）。某个标的的盘口一旦收窄（实测 META
// bid 626.98 / ask 627.00），引擎只能整轮跳过，连续多轮后就会停下来等。
//
// 这里提供「换一个点差更宽的标的」的决策：行情只用 WS 的 all_bbo 快照（零 REST 配额、和
// 引擎取价同源），从所有支持 ≥MIN_LEVERAGE 杠杆的永续里挑点差最宽的一个。读不到行情 / 没有
// 合格标的时返回 null，引擎就继续用当前标的，行为与旧版一致。
// =============================================================================
import { getLiveConfig, productFor, type LiveConfig } from "./liveConfig";
import { getBboQuote } from "./bboCache";
import { MIN_LEVERAGE, MIN_SPREAD_TICKS } from "./tradingRules";

export interface MarketCandidate {
  /** 候选标的的市场 id（形如 nado:perp:META-PERP）。 */
  market: string;
  /** 该标的当前的买一卖一相隔几个 tick。 */
  ticks: number;
}

/** 某个标的当前的盘口点差（tick 数）。没有行情快照 / 单边盘口 / 非永续 → undefined。 */
export function spreadTicksOf(marketId: string, cfg: LiveConfig): number | undefined {
  const p = productFor(cfg, marketId);
  if (!p || p.kind !== "perp") return undefined;
  const q = getBboQuote(p.productId);
  if (!q) return undefined;
  const bid = Number(q.bid) / 1e18;
  const ask = Number(q.ask) / 1e18;
  const tick = Number(p.tickSize);
  if (!(bid > 0) || !(ask > 0) || !(tick > 0) || ask < bid) return undefined;
  return Math.round((ask - bid) / tick);
}

/** 挑一个可以换过去的标的：排除当前标的与本次运行里已经放弃过的标的，只保留点差
 *  ≥ MIN_SPREAD_TICKS 的，取点差最大的那个；并列时取先出现的（列表顺序稳定，行为可复现）。
 *  没有合格候选返回 null（调用方继续用当前标的）。 */
export async function pickFatterMarket(
  current: string,
  avoid: ReadonlySet<string> = new Set(),
): Promise<MarketCandidate | null> {
  const cfg = await getLiveConfig();
  if (!cfg.enabled) return null;
  // 和面板的 Market 列表同一套筛选：低杠杆标的保证金要求太高，开单会被 2006 拒掉。
  // 没有杠杆字段（离线 mock）时不过滤，避免把候选清空。
  const markets = (cfg.markets ?? []).filter((m) => (m.maxLeverage ?? MIN_LEVERAGE) >= MIN_LEVERAGE);
  let best: MarketCandidate | null = null;
  for (const m of markets) {
    if (m.id === current || avoid.has(m.id)) continue;
    const ticks = spreadTicksOf(m.id, cfg);
    if (ticks === undefined || ticks < MIN_SPREAD_TICKS) continue;
    if (!best || ticks > best.ticks) best = { market: m.id, ticks };
  }
  return best;
}
