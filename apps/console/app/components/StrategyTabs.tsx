"use client";

import { useState } from "react";
import type { WalletVM } from "@farm/ui";
import type { Market } from "@farm/adapter-api";
import { bulk } from "../lib/bulk";
import { BulkPanel } from "./BulkPanel";
import { TradingStrategy } from "./TradingStrategy";

/** 上次选中的标签存这里，刷新后停在同一张卡片上 */
const TAB_KEY = "nado.strategyTab";

type Tab = "bulk" | "strategy";

/** 左侧栏的两个交易面板（Bulk action / Trading strategy）合成一张「文件夹标签」卡片：
 *  选项卡在上方凸出、同一时刻只显示一个面板的内容。切换标签时把另一个面板正在跑的任务停掉
 *  ——自成交循环在 TradingStrategy 卸载时会自己 abort，Bulk 是常驻单例，必须显式 halt + 停定时任务。 */
export function StrategyTabs({ wallets, liveMarkets, isLive = false, onWalletChanged, onRefreshBalances }: {
  wallets: WalletVM[];
  liveMarkets?: Market[];
  isLive?: boolean;
  onWalletChanged?: () => void;
  onRefreshBalances?: (walletIds: string[]) => Promise<void> | void;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "bulk"; // 服务端渲染时给个默认值
    return window.localStorage.getItem(TAB_KEY) === "strategy" ? "strategy" : "bulk";
  });

  // 切标签 = 停掉即将被隐藏的那个面板的任务
  const select = (next: Tab) => {
    if (next === tab) return;
    if (tab === "bulk") bulk.halt(); // halt() 内部已经把定时任务一起停掉
    setTab(next);
    try { window.localStorage.setItem(TAB_KEY, next); } catch { /* 隐私模式下忽略 */ }
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "bulk", label: "Bulk action" },
    { id: "strategy", label: "Trading strategy" },
  ];

  return (
    <div className="flex flex-col">
      {/* 文件夹分页式表头：选中的标签与下面的卡片同色、压住卡片上边框，形成一张纸上的小分页 */}
      <div role="tablist" aria-label="Trading panels" className="flex items-end gap-1 pl-2">
        {tabs.map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => select(t.id)}
              className={[
                "relative z-10 -mb-px rounded-t-md border border-kumo-line px-2.5 py-1 text-xs font-medium transition-colors",
                on
                  ? "border-b-transparent bg-kumo-base text-kumo-default"
                  : "bg-kumo-canvas text-kumo-subtle hover:text-kumo-default",
              ].join(" ")}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="rounded-b-lg border border-kumo-line bg-kumo-base p-3">
        {tab === "bulk" ? (
          <BulkPanel wallets={wallets} liveMarkets={liveMarkets} embedded />
        ) : (
          <TradingStrategy
            wallets={wallets}
            markets={liveMarkets ?? []}
            onWalletChanged={onWalletChanged}
            onRefreshBalances={onRefreshBalances}
            isLive={isLive}
          />
        )}
      </div>
    </div>
  );
}
