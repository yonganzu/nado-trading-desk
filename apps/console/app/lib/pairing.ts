"use client";

import { useSyncExternalStore } from "react";

/** 手动配对：用户指定的「一个 maker + 一个 taker」。只存 walletId（不存对象），
 *  这样钱包列表刷新、余额变化都不会把配对冲掉；运行时再按 id 换回 WalletVM。 */
export interface ManualPair {
  id: string;
  makerId: string;
  takerId: string;
}

const STORAGE_KEY = "cohort.pairs";

function load(): ManualPair[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // 只接受结构完整的条目，旧版本/被手改过的数据直接丢掉，不让它污染配对
    return parsed.filter((p): p is ManualPair =>
      !!p && typeof p === "object" &&
      typeof (p as ManualPair).id === "string" &&
      typeof (p as ManualPair).makerId === "string" &&
      typeof (p as ManualPair).takerId === "string");
  } catch {
    return []; // 隐私模式 / 损坏数据：当作没有配对，不影响运行
  }
}

// 懒加载：首次读取前不碰 localStorage（SSR 时也能安全渲染）
let state: ManualPair[] | null = null;
const listeners = new Set<() => void>();
const EMPTY: ManualPair[] = []; // 服务端渲染用的稳定空快照

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function getSnapshot(): ManualPair[] {
  if (state === null) state = load();
  return state;
}

function getServerSnapshot(): ManualPair[] { return EMPTY; }

/** 写入并落本地；顺带广播，让左侧面板和右侧配对板同时刷新 */
function commit(next: ManualPair[]): void {
  state = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* 写不进去也不影响本次运行 */ }
  for (const l of listeners) l();
}

/** 配对的增删。一个钱包在一轮里只能出一条腿，所以新配对会先把占用同一钱包的旧配对移除。 */
export const manualPairs = {
  add(makerId: string, takerId: string): void {
    const cur = getSnapshot();
    const rest = cur.filter((p) => p.makerId !== makerId && p.takerId !== takerId);
    if (cur.length === rest.length && cur.some((p) => p.makerId === makerId && p.takerId === takerId)) return;
    commit([...rest, { id: `${makerId}__${takerId}`, makerId, takerId }]);
  },
  remove(id: string): void { commit(getSnapshot().filter((p) => p.id !== id)); },
  clear(): void { commit([]); },
};

/** 订阅手动配对列表：任何一处的增删都会让订阅者重渲染。 */
export function useManualPairs(): ManualPair[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
