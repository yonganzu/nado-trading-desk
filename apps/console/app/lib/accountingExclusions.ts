// =============================================================================
// 账本统计的「排除名单」。
//
// 用途：某些钱包的成交不该算进整体统计（例如自己手动操作的人工钱包、借用钱包、误连账户），
// 它们会把 Accounting 页的汇总、积分成本、自成交比例和导出一起污染。
// 现在可以在钱包面板上逐个开关（眼睛图标），选择是否把该钱包计入统计；
// 名单按**地址**存 localStorage，刷新后仍然有效；原始账本不动（随时可以再打开）。
//
// 映射方式：账本记录只存 walletId（live:N），地址 → walletId 的对应关系来自当前解锁的
// 舰库会话（cohortWallets）。未解锁 / 找不到映射时原样返回，绝不误删别人的数据。
// =============================================================================
import { cohortWallets } from "./custody";

/** localStorage 键：被隐藏（不计入统计）的钱包地址列表。 */
const STORAGE_KEY = "nado.accountingExcluded";

/** 当前排除的地址（小写）。 */
const excluded = new Set<string>();
/** 是否已从 localStorage 读过一次。 */
let hydrated = false;
/** 变更订阅者（Accounting 面板、钱包卡片用它刷新）。 */
const listeners = new Set<() => void>();

/** 首次使用时从 localStorage 恢复；服务端渲染环境直接跳过。 */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const list = JSON.parse(raw) as unknown;
    if (Array.isArray(list)) {
      for (const a of list) if (typeof a === "string") excluded.add(a.toLowerCase());
    }
  } catch {
    // 隐私模式 / 内容损坏：当作没有排除名单
  }
}

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...excluded]));
  } catch {
    // 存储不可用就只保留内存状态
  }
}

function notify(): void {
  for (const fn of listeners) fn();
}

/** 当前被排除的地址列表（小写）。 */
export function excludedAddresses(): string[] {
  hydrate();
  return [...excluded];
}

/** 这个地址是否被排除在统计之外。 */
export function isAddressExcluded(address: string): boolean {
  hydrate();
  return excluded.has(address.toLowerCase());
}

/** 打开 / 关闭某个地址的统计参与。 */
export function setAddressExcluded(address: string, on: boolean): void {
  hydrate();
  const key = address.toLowerCase();
  if (on === excluded.has(key)) return;
  if (on) excluded.add(key);
  else excluded.delete(key);
  persist();
  notify();
}

/** 订阅排除名单变化，返回取消订阅函数。 */
export function subscribeExclusions(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 当前会话里，这些地址对应的 walletId。 */
function excludedWalletIds(): Set<string> {
  hydrate();
  const ids = new Set<string>();
  if (!excluded.size) return ids;
  for (const w of cohortWallets()) {
    if (excluded.has(w.address.toLowerCase())) ids.add(w.walletId);
  }
  return ids;
}

/** 过滤掉排除名单里的成交。映射不到时不删任何记录。 */
export function withoutExcludedWallets<T extends { walletId: string }>(records: readonly T[]): T[] {
  const ids = excludedWalletIds();
  return ids.size ? records.filter((r) => !ids.has(r.walletId)) : records.slice();
}
