"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, CheckIcon, CircleNotchIcon, EyeIcon, EyeSlashIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { WalletVM } from "@farm/ui";
import { WalletCard } from "./WalletCard";
import { excludedAddresses, setAddressExcluded, subscribeExclusions } from "../lib/accountingExclusions";
import type { WalletCheckState } from "../lib/walletCheck";
import type { NadoOpenState } from "../lib/nadoOpen";

// 纵向卡片墙：一行铺满容器宽度，行数向下延伸，纵向滚动。
// 按「行」虚拟化 —— 只有可见的几行（含 overscan）会挂载，1000 张卡片也能流畅滚动。
const CARD_H = 168;
const CARD_W = 230;
const GAP = 12;
const PAD = 16;

export function WalletGrid({ wallets, selectedId, onSelect, pickedIds, onTogglePick, checks, onCheck, nado, onOpenNado }: {
  wallets: WalletVM[];
  selectedId?: string;
  onSelect: (w: WalletVM) => void;
  /** 右侧手动勾选的钱包 id 集合（用于左侧自成交配对）；不传则不显示勾选框 */
  pickedIds?: Set<string>;
  /** 点击卡片左上角勾选框时触发；shift 为 true 表示按住 Shift 连选 */
  onTogglePick?: (w: WalletVM, shift: boolean) => void;
  /** 每个钱包的「Nado 注册状态」检查结果，按 wallet.id 索引。 */
  checks?: Record<string, WalletCheckState>;
  /** 点击卡片右上角的检查按钮时触发。 */
  onCheck?: (w: WalletVM) => void;
  /** 每个钱包「一键打开官网并登录」的状态，按 wallet.id 索引。 */
  nado?: Record<string, NadoOpenState>;
  /** 点击卡片右上角的「打开官网」按钮时触发。 */
  onOpenNado?: (w: WalletVM) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);

  // 被排除在 Accounting 统计之外的钱包地址（眼睛图标的开关状态）
  const [excluded, setExcluded] = useState<string[]>([]);
  useEffect(() => {
    setExcluded(excludedAddresses());
    return subscribeExclusions(() => setExcluded(excludedAddresses()));
  }, []);
  const excludedSet = new Set(excluded);

  // 根据容器宽度算每行能放几张卡片（窗口/侧栏宽度变化时自动重算）
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth - 2 * PAD;
      setCols(Math.max(1, Math.floor((w + GAP) / (CARD_W + GAP))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowCount = Math.max(1, Math.ceil(wallets.length / cols));
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_H + GAP,
    overscan: 3,
  });

  return (
    <div ref={scrollRef} className="h-full overflow-x-hidden overflow-y-auto" style={{ padding: PAD }}>
      <div style={{ height: rowVirtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((row) => {
          const start = row.index * cols;
          const slice = wallets.slice(start, start + cols);
          return (
            <div
              key={row.key}
              style={{ position: "absolute", top: row.start, left: 0, right: 0, height: CARD_H, display: "flex", gap: GAP }}
            >
              {slice.map((w) => {
                const check = checks?.[w.id];
                const running = check?.status === "running";
                const nadoState = nado?.[w.id];
                const opening = nadoState?.status === "opening";
                const picked = pickedIds?.has(w.id) ?? false;
                // 该钱包是否被排除在 Accounting 统计之外（眼睛斜杠 = 不计入）
                const hidden = excludedSet.has(w.address.value.toLowerCase());
                return (
                  <div key={w.id} style={{ width: CARD_W, height: CARD_H, flex: "0 0 auto", position: "relative" }}>
                    <WalletCard wallet={w} selected={w.id === selectedId} picked={picked} pickable={!!onTogglePick} onSelect={onSelect} check={check} nado={nadoState} />
                    {/* 勾选框：与卡片按钮是兄弟节点（不能嵌套 button），放在卡片左上角 */}
                    {onTogglePick && (
                      <button
                        type="button"
                        data-testid="wallet-pick"
                        aria-pressed={picked}
                        aria-label={picked ? `取消选择 #${w.index}` : `选择 #${w.index} 参与自成交配对`}
                        title="勾选参与自成交配对（Shift 点选可连续选中）"
                        onClick={(e) => { onTogglePick(w, e.shiftKey); }}
                        className={cn(
                          "absolute left-2.5 top-2.5 z-10 grid size-5 place-items-center rounded border text-kumo-default",
                          picked ? "border-kumo-brand bg-kumo-brand/15" : "border-kumo-line bg-kumo-base hover:bg-kumo-tint",
                        )}
                      >
                        {picked && <CheckIcon size={12} weight="bold" />}
                      </button>
                    )}
                    {/* 操作按钮与卡片按钮是兄弟节点（不能嵌套 button），定位在地址行右侧的空白处 */}
                    <div className="absolute right-2 top-9 flex items-center gap-0.5">
                      <button
                        type="button"
                        data-testid="wallet-nado-open"
                        title={opening ? "正在打开 Nado 官网并登录" : "一键打开 Nado 官网并登录"}
                        aria-label={`用 #${w.index} 打开 Nado 官网并登录`}
                        disabled={opening}
                        onClick={() => onOpenNado?.(w)}
                        className="grid size-5 place-items-center rounded text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:cursor-wait disabled:opacity-60"
                      >
                        {opening
                          ? <CircleNotchIcon size={12} className="animate-spin" />
                          : <ArrowSquareOutIcon size={12} />}
                      </button>
                      <button
                        type="button"
                        data-testid="wallet-check"
                        title={running ? "正在检查 Nado 注册状态与余额" : "检查 Nado 注册状态（同时刷新余额）"}
                        aria-label={`检查 #${w.index} 的 Nado 注册状态并刷新余额`}
                        disabled={running}
                        onClick={() => onCheck?.(w)}
                        className="grid size-5 place-items-center rounded text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:cursor-wait disabled:opacity-60"
                      >
                        {running
                          ? <CircleNotchIcon size={12} className="animate-spin" />
                          : <MagnifyingGlassIcon size={12} />}
                      </button>
                      {/* 统计开关：决定这个钱包的成交是否计入 Accounting 的汇总/积分/导出 */}
                      <button
                        type="button"
                        data-testid="wallet-stats-toggle"
                        aria-pressed={!hidden}
                        title={hidden ? "该钱包未计入 Accounting 统计（点击恢复）" : "不计入 Accounting 统计（隐藏该钱包对整体数据的影响）"}
                        aria-label={`切换 #${w.index} 是否计入 Accounting 统计`}
                        onClick={() => setAddressExcluded(w.address.value, !hidden)}
                        className={cn(
                          "grid size-5 place-items-center rounded hover:bg-kumo-tint",
                          hidden ? "text-kumo-inactive hover:text-kumo-subtle" : "text-kumo-subtle hover:text-kumo-default",
                        )}
                      >
                        {hidden ? <EyeSlashIcon size={12} /> : <EyeIcon size={12} />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
