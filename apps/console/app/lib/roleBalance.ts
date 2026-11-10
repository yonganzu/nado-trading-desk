// =============================================================================
// 配对内的 maker/taker 角色平衡
//
// 规则：**每一对里，吃单方（taker）的余额必须高于挂单方（maker）**。
// 吃单每笔 3.5bp、挂单 1bp，taker 一侧的保证金消耗更快；让 taker 始终更富，
// 两侧「被掏空」的时点才会一致，不会出现一侧已经没钱、另一侧还堆着一堆保证金。
//
// 时机：每轮开始前，pair 已经按当轮洗牌结果配对好了，逐对比较余额；
// 某一对里 taker 比 maker 少（超过 1 美分容差）就**只把这一对**的两个钱包角色对调，
// 引擎本轮直接用新角色下单，同时写回 cohort 标签让面板同步。
//
// 余额来源：优先用页面已经扫到的 WalletVM.quoteBalance（零 REST 开销）；没有读数的钱包
// 才现场读一次（1 个 per-IP 令牌）——撞上 429 就跳过这一对的决策，宁可不动也不拿 0 当余额。
// =============================================================================
import type { WalletVM } from "@farm/ui";
import { readWalletBalances } from "./liveContext";
import { setWalletCohort } from "./custody";

/** 逐对「taker 余额必须更高」的角色平衡开关。
 *  默认关闭：自成交每轮里同一个钱包会各当一次 maker 和一次 taker（开仓挂单、平仓去吃），
 *  手续费同样是 1bp + 3.5bp，两侧的盈亏/费用完全对称，没有必要按余额调换角色。
 *  以后若要重新启用，把它改回 true 即可（引擎已接好 balancePairRoles / reloadRoles）。 */
export const ROLE_BALANCE_ENABLED = false;

/** 判定「taker 比 maker 少」的容差（USDT0）：几美分的抖动不值得来回翻转角色。 */
export const ROLE_SWAP_EPS_USDT0 = 0.01;

const short = (w: WalletVM) => w.address.value.slice(0, 6);

/** 读一个钱包的保证金余额（USDT0）。读不到返回 null —— 调用方据此跳过该对的决策。 */
async function marginOf(walletId: string): Promise<number | null> {
  try {
    const r = await readWalletBalances(walletId);
    const quote = r.balances?.find((b) => b.scope === "margin");
    if (!quote) return null;
    const n = Number(quote.total ?? 0);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export interface PairRebalanceResult {
  /** 检查过的对数。 */
  checked: number;
  /** 实际互换角色的对数。 */
  swapped: number;
  /** 因为余额读不到而跳过决策的对数。 */
  unknown: number;
}

/**
 * 每一对内部核对角色：taker 余额少于 maker 就把这一对互换。
 * 直接修改传入的 pairs（元素就地交换），调用方随后的下单会按新角色执行。
 * @param pairs  本轮已经配对好的 [maker, taker] 列表
 * @param cached 页面缓存的余额查询（walletId → USDT0 数值）；没有读数返回 null
 * @param log    日志
 */
export async function balancePairRoles(
  pairs: Array<[WalletVM, WalletVM]>,
  cached: ((walletId: string) => number | null) | undefined,
  log: (msg: string) => void,
): Promise<PairRebalanceResult> {
  const result: PairRebalanceResult = { checked: 0, swapped: 0, unknown: 0 };
  if (!pairs.length) return result;

  // 一轮只读一次：先查页面缓存，缓存没有的钱包再现场读
  const balances = new Map<string, number | null>();
  const balanceOf = async (w: WalletVM): Promise<number | null> => {
    if (balances.has(w.id)) return balances.get(w.id) ?? null;
    const c = cached?.(w.id) ?? null;
    const v = c !== null ? c : await marginOf(w.id);
    balances.set(w.id, v);
    return v;
  };

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    const makerBal = await balanceOf(pair[0]);
    const takerBal = await balanceOf(pair[1]);
    if (makerBal === null || takerBal === null) {
      result.unknown++;
      continue;
    }
    result.checked++;
    // taker 已经不低（符合规则）：不动这一对
    if (takerBal >= makerBal - ROLE_SWAP_EPS_USDT0) continue;

    // 只换这一对：数组元素就地交换，随后 runPair 按新角色开仓
    const oldMaker = pair[0];
    const oldTaker = pair[1];
    pair[0] = oldTaker;
    pair[1] = oldMaker;

    // 写回标签：原 maker → taker、原 taker → maker。
    // 注意必须用交换前的两个引用，不能用 pair[1]（交换后它已经是原 maker 了，
    // 会把刚写的 taker 又改回 maker —— 面板看起来就「从没换过」）。
    let failed = 0;
    try { await setWalletCohort(oldMaker.id, "taker"); } catch { failed++; }
    try { await setWalletCohort(oldTaker.id, "maker"); } catch { failed++; }

    result.swapped++;
    log(
      `⇄ pair ${i + 1}：taker ${short(oldTaker)} $${takerBal.toFixed(2)} 低于 maker ${short(oldMaker)} $${makerBal.toFixed(2)}` +
        ` —— 这一对互换角色${failed ? `（${failed} 个标签写回失败，面板可能滞后）` : ""}`,
    );
  }

  if (result.unknown) {
    log(`⚖ 余额检查跳过 ${result.unknown} 对：有钱包没有读数（限速/未扫描），这些对不换角色`);
  }
  return result;
}
