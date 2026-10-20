"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowSquareOutIcon, CircleNotchIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { WalletVM } from "@farm/ui";
import { WalletCard } from "./WalletCard";
import type { WalletCheckState } from "../lib/walletCheck";
import type { NadoOpenState } from "../lib/nadoOpen";

// The horizontal card wall: rows fill the viewport height, columns extend rightward.
// Virtualized by COLUMN — only the visible columns (+overscan) mount, so ~1000 cards
// scroll smoothly. One wallet = one card.
const CARD_H = 168;
const CARD_W = 230;
const GAP = 12;
const PAD = 16;

export function WalletGrid({ wallets, selectedId, onSelect, checks, onCheck, nado, onOpenNado }: {
  wallets: WalletVM[];
  selectedId?: string;
  onSelect: (w: WalletVM) => void;
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
  const [rows, setRows] = useState(4);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight - 2 * PAD;
      setRows(Math.max(1, Math.floor((h + GAP) / (CARD_H + GAP))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const columns = Math.max(1, Math.ceil(wallets.length / rows));
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_W + GAP,
    overscan: 3,
  });

  return (
    <div ref={scrollRef} className="h-full overflow-x-auto overflow-y-hidden" style={{ padding: PAD }}>
      <div style={{ width: colVirtualizer.getTotalSize(), height: "100%", position: "relative" }}>
        {colVirtualizer.getVirtualItems().map((col) => {
          const start = col.index * rows;
          const slice = wallets.slice(start, start + rows);
          return (
            <div
              key={col.key}
              style={{ position: "absolute", top: 0, left: col.start, width: CARD_W, height: "100%", display: "flex", flexDirection: "column", gap: GAP }}
            >
              {slice.map((w) => {
                const check = checks?.[w.id];
                const running = check?.status === "running";
                const nadoState = nado?.[w.id];
                const opening = nadoState?.status === "opening";
                return (
                  <div key={w.id} style={{ height: CARD_H, flex: "0 0 auto", position: "relative" }}>
                    <WalletCard wallet={w} selected={w.id === selectedId} onSelect={onSelect} check={check} nado={nadoState} />
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
                        title={running ? "正在检查 Nado 注册状态" : "检查 Nado 注册状态"}
                        aria-label={`检查 #${w.index} 的 Nado 注册状态`}
                        disabled={running}
                        onClick={() => onCheck?.(w)}
                        className="grid size-5 place-items-center rounded text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:cursor-wait disabled:opacity-60"
                      >
                        {running
                          ? <CircleNotchIcon size={12} className="animate-spin" />
                          : <MagnifyingGlassIcon size={12} />}
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
