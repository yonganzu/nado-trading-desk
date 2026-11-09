// =============================================================================
// 账本统计的「排除名单」。
//
// 用途：某些地址的成交不属于自己的 fleet（外部钱包 / 借用钱包 / 误连的账户），
// 它们会把 Accounting 页的汇总、积分成本、自成交比例和导出一起污染。
// 这里按**地址**维护排除名单，展示时统一过滤；原始账本不动（可随时移除恢复）。
//
// 映射方式：账本记录只存 walletId（live:N），地址 → walletId 的对应关系来自当前解锁的
// 舰库会话（cohortWallets）。未解锁 / 找不到映射时原样返回，绝不误删别人的数据。
// =============================================================================
import { cohortWallets } from "./custody";

/** 要从统计里剔除的钱包地址（一律小写比较）。
 *  默认留空 = 不排除任何地址；需要时按下面的示例填自己的地址。 */
export const EXCLUDED_WALLET_ADDRESSES: ReadonlySet<string> = new Set([
  // "0x0123456789abcdef0123456789abcdef01234567",
]);

/** 当前会话里，这些地址对应的 walletId。 */
function excludedWalletIds(): Set<string> {
  const ids = new Set<string>();
  for (const w of cohortWallets()) {
    if (EXCLUDED_WALLET_ADDRESSES.has(w.address.toLowerCase())) ids.add(w.walletId);
  }
  return ids;
}

/** 过滤掉排除名单里的成交。映射不到时不删任何记录。 */
export function withoutExcludedWallets<T extends { walletId: string }>(records: readonly T[]): T[] {
  const ids = excludedWalletIds();
  return ids.size ? records.filter((r) => !ids.has(r.walletId)) : records.slice();
}
