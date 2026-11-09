"use client";

// =============================================================================
// 仓位同步（标签页通道）：把「执行钱包」在 Nado 的真实仓位推给 ASH。
//
// ASH 默认已改为后端直连 Nado（execution.nadoBridge.positionSource=backend），
// 那时本 hook 的仓位数据会被 ASH 拒收，但"记住网页选定的执行钱包"仍然生效——
// 后端据此决定盯哪个地址。positionSource=browser 时才由本 hook 提供仓位数据。
//
// 推动频率：仓位变化立刻推，不变也每 15 秒心跳一次。
// =============================================================================
import { useEffect, useRef } from "react";
import type { LiveWallet } from "./live";

const PUSH_MS = 5_000;        // 检查间隔
const HEARTBEAT_MS = 15_000;  // 仓位没变化时的心跳间隔

interface SyncPayload {
  wallet: string;
  at: number;
  openOrders: number;
  positions: Array<{ market: string; side: string; size: string; entryPrice: string }>;
}

export function usePositionSync(enabled: boolean, execWallet: string, wallets: LiveWallet[] | undefined): void {
  // 定时器里要读最新值，但不想每次 live 刷新都重建定时器
  const latest = useRef({ enabled, execWallet, wallets });
  latest.current = { enabled, execWallet, wallets };
  const lastSig = useRef("");
  const lastAt = useRef(0);

  useEffect(() => {
    if (!enabled || !execWallet) return;
    let stopped = false;

    const push = async () => {
      if (stopped) return;
      const state = latest.current;
      if (!state.enabled || !state.execWallet) return;
      const wallet = state.wallets?.find((w) => w.address.toLowerCase() === state.execWallet);
      // 这个钱包还没被读过 → 等下一轮，别把空数组当成"无仓位"推过去
      if (!wallet || wallet.positions === undefined) return;

      const payload: SyncPayload = {
        wallet: state.execWallet,
        at: Date.now(),
        openOrders: wallet.openOrders?.length ?? 0,
        positions: wallet.positions
          .filter((p) => Number(p.size) > 0)
          .map((p) => ({
            market: String(p.market),
            side: p.side,
            size: String(p.size),
            entryPrice: String(p.entryPrice ?? "0"),
          })),
      };

      const sig = JSON.stringify(payload.positions);
      const changed = sig !== lastSig.current;
      if (!changed && Date.now() - lastAt.current < HEARTBEAT_MS) return;
      lastSig.current = sig;
      lastAt.current = Date.now();

      try {
        await fetch("/api/ash/position-sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        // 网络/ASH 未启动：下一轮自动重试，不打断页面
      }
    };

    void push();
    const timer = setInterval(() => void push(), PUSH_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [enabled, execWallet]);
}
