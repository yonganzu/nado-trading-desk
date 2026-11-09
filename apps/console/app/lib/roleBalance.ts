// =============================================================================
// 余额监测 + maker/taker 角色自动互换
//
// 背景：自成交跑久了，两个钱包的保证金会往一边漂 —— 开仓价 P1 与平仓价 P2 之间有价差时，
// 一多一空的两个钱包必然一赚一亏（合计为零，但单个钱包的余额会越拉越开）。
// 弱侧余额被掏空后，那一侧要么被 eligible 判成无抵押、要么下单被 sequencer 拒，
// 整轮就直接跳过了。
//
// 做法：每次 run 开跑前（仓位已由 flattenAll 清零）读一次参与钱包的保证金；
// 当「弱侧平均 / 强侧平均」低于阈值（或绝对差过大）时，把强侧最富的钱包与弱侧最穷的钱包
// 互换角色（同时写回 cohort 标签，面板上能直接看到），并就地替换本次 run 用的数组，随后整段跑完不再变动。
//
// 为什么只在开跑前查：跑起来之后仓位是连续的，中途换角色容易出现「一半仓位在老角色、
// 一半在新角色」的错位，反而要额外平仓，得不偿失。
//
// 成本：每钱包 1 个 per-IP 读令牌，一次 run 只查一次。
// =============================================================================
import type { WalletVM } from "@farm/ui";
import { readWalletBalances } from "./liveContext";
import { setWalletCohort } from "./custody";

/** 弱侧平均余额 / 强侧平均余额 低于它就算「不平衡」（0.85 = 弱侧不到强侧的 85%）。 */
export const ROLE_GAP_RATIO = 0.85;

/** 两侧平均余额的绝对差超过它也算失衡（USDT0）：小余额时比例不敏感，用绝对差兜住。 */
export const ROLE_MIN_DIFF_USDT0 = 3;

const short = (w: WalletVM) => w.address.value.slice(0, 6);

/** 读一个钱包的保证金余额（USDT0）。读不到返回 null —— 调用方据此放弃本次决策。 */
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

const avg = (list: readonly WalletVM[], m: Map<string, number>): number =>
  list.length ? list.reduce((s, w) => s + (m.get(w.id) ?? 0), 0) / list.length : 0;

/**
 * 检查两边保证金是否失衡，失衡就把角色互换。
 * @param makers 本次 run 正在用的 maker 列表（会被就地修改，下一轮立即生效）
 * @param takers 同上
 * @returns 是否发生了互换
 */
export async function rebalanceRoles(
  makers: WalletVM[],
  takers: WalletVM[],
  log: (msg: string) => void,
): Promise<boolean> {
  if (!makers.length || !takers.length) return false;

  // 逐个读（串行，别和下单抢并发）；任意一个读不到就放弃这次决策 —— 宁可不动，也不乱换
  const margins = new Map<string, number>();
  for (const w of [...makers, ...takers]) {
    const v = await marginOf(w.id);
    if (v === null) {
      log(`⚖ 余额检查跳过：${short(w)} 读数失败（限速/网络），下一轮再试`);
      return false;
    }
    margins.set(w.id, v);
  }

  const am = avg(makers, margins);
  const at = avg(takers, margins);
  const strongerIsMaker = am >= at;
  const strongAvg = strongerIsMaker ? am : at;
  const weakAvg = strongerIsMaker ? at : am;
  const pct = strongAvg > 0 ? Math.round((weakAvg / strongAvg) * 100) : 100;
  // 每次检查都打一行：能确认「确实在看余额」，而不是静默什么都不做
  log(
    `⚖ 余额：maker $${am.toFixed(2)} / taker $${at.toFixed(2)}` +
      `（弱侧 ${pct}%，阈值 ${Math.round(ROLE_GAP_RATIO * 100)}% 或差 $${ROLE_MIN_DIFF_USDT0}）`,
  );
  // 强侧没钱（或两边都接近 0）时不动：没有可比较的基准
  if (!(strongAvg > 0)) return false;
  // 比例和绝对差都没越过阈值 → 本来就算平衡，不用换
  if (weakAvg / strongAvg >= ROLE_GAP_RATIO && strongAvg - weakAvg < ROLE_MIN_DIFF_USDT0) return false;

  const strongList = strongerIsMaker ? makers : takers;
  const weakList = strongerIsMaker ? takers : makers;
  // 强侧挑最富的、弱侧挑最穷的互换：换完两边的平均值立刻靠近
  const rich = strongList.reduce((a, b) => ((margins.get(b.id) ?? 0) > (margins.get(a.id) ?? 0) ? b : a));
  const poor = weakList.reduce((a, b) => ((margins.get(b.id) ?? 0) < (margins.get(a.id) ?? 0) ? b : a));
  if (rich.id === poor.id) return false;

  const richTo: "maker" | "taker" = strongerIsMaker ? "taker" : "maker";
  const poorTo: "maker" | "taker" = strongerIsMaker ? "maker" : "taker";

  try {
    // 串行写：cohort 是共享标签库上的「读-改-写」，并行会互相覆盖
    await setWalletCohort(rich.id, richTo);
    await setWalletCohort(poor.id, poorTo);
  } catch (e) {
    log(`⚠ 角色互换失败：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }

  // 就地替换数组元素：本次 run 的后续轮次立刻用新角色（不必等面板重新拉钱包列表）
  const si = strongList.indexOf(rich);
  const wi = weakList.indexOf(poor);
  if (si >= 0) strongList[si] = poor;
  if (wi >= 0) weakList[wi] = rich;

  const a = margins.get(rich.id) ?? 0;
  const b = margins.get(poor.id) ?? 0;
  log(
    `⇄ 余额失衡，互换角色：${short(rich)} $${a.toFixed(2)} → ${richTo}` +
      ` ↔ ${short(poor)} $${b.toFixed(2)} → ${poorTo}` +
      `（弱侧/强侧 ${(weakAvg / strongAvg * 100).toFixed(0)}%）`,
  );
  return true;
}
