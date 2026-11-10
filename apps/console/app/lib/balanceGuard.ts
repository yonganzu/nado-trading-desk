import type { WalletVM } from "@farm/ui";

/** 每跑完这么多轮做一次余额体检。 */
export const BALANCE_CHECK_EVERY = 10;

/** 余额低于这个数（USDT0）就不再参与跑量：连一笔最小单都下不了，继续跑只会整轮空转。 */
export const MIN_BALANCE_USDT0 = 5.5;

export interface BalanceGuardResult {
  makers: WalletVM[];
  takers: WalletVM[];
  /** 新的配对名单：入参没有手动配对时返回空（自动配对模式，引擎每轮自己洗牌） */
  pairs: Array<readonly [WalletVM, WalletVM]>;
  /** 余额低于阈值、被剔除出本次运行的钱包 */
  dropped: WalletVM[];
  /** 因为搭档被剔除而落单、这次重新补上的对数 */
  addedPairs: number;
  /** 剔除后凑不成对的落单钱包（奇数个时剩下的最后一个） */
  unpaired: WalletVM[];
}

/** 余额体检：剔除余额过低的钱包，并把「搭档被剔除后落单」的钱包重新配对。
 *  - 读不到余额（null）的钱包保持原样，一次读取失败不该让人退出跑量；
 *  - 自动配对模式（pairs 为空）：剔除后把多出来的一侧按顺序挪到另一边，保证每个钱包都有对手盘；
 *  - 手动配对模式：先保留两条腿都还在的配对，再把落单的钱包按原顺序两两补成新的一对。 */
export function guardByBalance(args: {
  makers: readonly WalletVM[];
  takers: readonly WalletVM[];
  pairs: ReadonlyArray<readonly [WalletVM, WalletVM]>;
  balanceOf: (walletId: string) => number | null;
  min?: number;
}): BalanceGuardResult {
  const min = args.min ?? MIN_BALANCE_USDT0;
  const isLow = (w: WalletVM): boolean => {
    const b = args.balanceOf(w.id);
    return b != null && b < min;
  };
  // 去重：同一个钱包可能同时出现在分组数组和配对名单里
  const seen = new Set<string>();
  const dropped: WalletVM[] = [];
  const visit = (w: WalletVM) => {
    if (seen.has(w.id)) return;
    seen.add(w.id);
    if (isLow(w)) dropped.push(w);
  };
  args.makers.forEach(visit);
  args.takers.forEach(visit);
  for (const [m, t] of args.pairs) { visit(m); visit(t); }
  const low = new Set(dropped.map((w) => w.id));
  const keep = (w: WalletVM): boolean => !low.has(w.id);

  if (args.pairs.length === 0) {
    // 自动配对：多出来的一侧挪到另一边，凑成等长，避免每轮都有钱包轮空
    const makers = args.makers.filter(keep);
    const takers = args.takers.filter(keep);
    while (makers.length > takers.length) takers.push(makers.pop()!);
    while (takers.length > makers.length) makers.push(takers.pop()!);
    return { makers, takers, pairs: [], dropped, addedPairs: 0, unpaired: [] };
  }

  const survivors = args.pairs.filter(([m, t]) => keep(m) && keep(t));
  const used = new Set<string>();
  for (const [m, t] of survivors) { used.add(m.id); used.add(t.id); }
  const orphans = [...args.makers, ...args.takers].filter((w) => keep(w) && !used.has(w.id));
  const pairs: Array<readonly [WalletVM, WalletVM]> = [...survivors];
  for (let i = 0; i + 1 < orphans.length; i += 2) pairs.push([orphans[i]!, orphans[i + 1]!] as const);
  return {
    // 手动配对模式下引擎只用 pairs 逐对开打；分组数组跟着配对走，收尾平仓才不会漏钱包
    makers: pairs.map(([m]) => m),
    takers: pairs.map(([, t]) => t),
    pairs,
    dropped,
    addedPairs: pairs.length - survivors.length,
    unpaired: orphans.length % 2 === 1 ? [orphans[orphans.length - 1]!] : [],
  };
}
