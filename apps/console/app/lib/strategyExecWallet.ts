"use client";

// =============================================================================
// 策略信号的「执行钱包」选择（浏览器本地持久化）。
//
// 外部策略（ASH）只出信号、不再需要填钱包地址：到底用哪些钱包下单，由操作者在网页
// 「策略执行」面板里指定。模型分两层：
//   group     左列当前查看的分组（账户名）；空串 = 全部分组。只是视图筛选，不影响已勾选
//   addresses 真正要执行的钱包地址集合。可跨分组任意勾选，也可以一键全选
// 勾选多个钱包时是跟单模式：ASH 的一笔信号会在每个钱包各开一份。
//
// 选择存在 localStorage，同一浏览器的其它标签页通过 storage 事件同步。
// =============================================================================
import { useCallback, useEffect, useState } from "react";

const KEY = "nado.strategy.execScope";
const LEGACY_KEY = "nado.strategy.execWallet"; // 旧版只存单个地址，读取时兼容

/** 执行钱包的选择范围。 */
export interface ExecScope {
  /** 左列当前查看的分组；空串 = 全部分组（只影响右列显示哪些钱包） */
  group: string;
  /** 真正要执行的钱包地址集合（小写）；空数组 = 还没选，此时不执行任何钱包 */
  addresses: string[];
}

export const EMPTY_SCOPE: ExecScope = { group: "", addresses: [] };

/** 从 localStorage 恢复选择；兼容旧的单地址 / 组内全部两种格式。 */
export function readExecScope(): ExecScope {
  if (typeof window === "undefined") return EMPTY_SCOPE;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { group?: unknown; addresses?: unknown; address?: unknown };
      // 旧格式用单数 address（空串表示「该组全部」），新格式用 addresses 数组
      const list = Array.isArray(parsed.addresses)
        ? parsed.addresses.map((a) => String(a).toLowerCase()).filter(Boolean)
        : typeof parsed.address === "string" && parsed.address
          ? [parsed.address.toLowerCase()]
          : [];
      return {
        group: typeof parsed.group === "string" ? parsed.group : "",
        addresses: [...new Set(list)],
      };
    }
    const legacy = (window.localStorage.getItem(LEGACY_KEY) ?? "").trim().toLowerCase();
    return legacy ? { group: "", addresses: [legacy] } : EMPTY_SCOPE;
  } catch {
    return EMPTY_SCOPE;
  }
}

/** 保存选择。 */
export function writeExecScope(scope: ExecScope): void {
  if (typeof window === "undefined") return;
  const next: ExecScope = {
    group: scope.group ?? "",
    addresses: [...new Set((scope.addresses ?? []).map((a) => a.toLowerCase()).filter(Boolean))],
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
    // 同步旧 key：只有一个钱包时写地址，否则清除，保证只认单地址的旧逻辑仍然一致
    if (next.addresses.length === 1) window.localStorage.setItem(LEGACY_KEY, next.addresses[0]!);
    else window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // 隐私模式等写不进去时只影响持久化，本次会话内的内存状态仍然生效
  }
}

/** React 侧读写执行范围：[当前选择, 更新函数]。 */
export function useExecScope(): [ExecScope, (scope: ExecScope) => void] {
  const [scope, setScope] = useState<ExecScope>(EMPTY_SCOPE);

  useEffect(() => {
    setScope(readExecScope()); // 首次挂载时从本地恢复（SSR 阶段先渲染空值）
    const onStorage = (e: StorageEvent): void => {
      if (e.key === KEY || e.key === LEGACY_KEY) setScope(readExecScope());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((next: ExecScope) => {
    const normalized: ExecScope = {
      group: next.group ?? "",
      addresses: [...new Set((next.addresses ?? []).map((a) => a.toLowerCase()).filter(Boolean))],
    };
    writeExecScope(normalized);
    setScope(normalized);
  }, []);

  return [scope, update];
}

/** 把勾选的地址过滤成当前保险库真实存在的钱包（钱包可能已被删除）。
 *  group 只用于界面筛选，不参与这里的选择。 */
export function resolveExecAddresses(
  scope: ExecScope,
  wallets: { address: string; account?: string }[],
): string[] {
  if (!scope.addresses.length) return [];
  const valid = new Set(wallets.map((w) => w.address.toLowerCase()));
  return scope.addresses.filter((a) => valid.has(a));
}
