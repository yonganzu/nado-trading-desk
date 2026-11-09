"use client";

// =============================================================================
// 外部交易信号的「领取 + 执行」端（浏览器）。
//
// 外部策略只能把信号放进本机队列；真正的签名必须发生在已解锁的标签页里。
// 这个 hook 每 2 秒拉一次待处理信号，领取后在标签页内调用 placeOrderLive 下单，
// 再回读一次持仓/挂单作为执行快照，连同结果回写给服务端。
// 同一信号只会被一个标签页领走（服务端 claim 保证）。
//
// 熔断：连续失败 3 次自动暂停 60 秒，避免策略异常时把队列刷成一片失败。
// 标签页关闭即停止消费信号——需要持续执行时让 /ash 页面保持打开。
// =============================================================================
import { useEffect, useRef, useState } from "react";
import { cohortWallets, isUnlocked } from "./custody";
import { cancelLive, cancelTriggerOrderLive, placeOrderLive, placeTriggerOrderLive, resolveProductLive } from "./liveContext";
import { reconcileWallet } from "./live";
import type { SignalOrderEcho, StrategyExecution, StrategySignal } from "./strategySignalModel";

const POLL_MS = 2_000;
const BATCH = 3;              // 每轮最多执行几条，避免长时间占住轮询
const MAX_FAILURES = 3;       // 连续失败多少次触发熔断
const COOLDOWN_MS = 60_000;   // 熔断暂停时长

export interface StrategyBridgeState {
  /** 待执行的信号数 */
  pending: number;
  /** 最近一次执行结果 */
  last?: { at: number; ok: boolean; label: string };
  /** 拉取队列失败的原因 / 熔断提示 */
  error?: string;
}

interface ExecResult {
  ok: boolean;
  label: string;
  order?: SignalOrderEcho;
  execution?: StrategyExecution;
}

/** 在标签页内执行一条信号：按地址找保险库钱包，内核签下单，私钥不出浏览器。
 *  地址来源：信号自带（外部策略显式指定）优先；留空时用网页「策略执行」选定的钱包范围。
 *  范围含多个地址时是跟单模式——每个钱包各开一份，互不影响。 */
async function runSignal(signal: StrategySignal, execWallets: string[]): Promise<ExecResult> {
  const explicit = (signal.wallet || "").trim().toLowerCase();
  const targets = explicit ? [explicit] : execWallets.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!targets.length) return { ok: false, label: "未选择执行钱包：请在 /ash 页面「策略执行」里指定" };

  const cohort = cohortWallets();
  type One = { address: string; ok: boolean; label: string; order?: SignalOrderEcho; execution?: StrategyExecution };
  const results: One[] = [];

  for (const target of targets) {
    const wallet = cohort.find((w) => w.address.toLowerCase() === target);
    if (!wallet) {
      results.push({ address: target, ok: false, label: "当前保险库没有该钱包地址" });
      continue;
    }

    // 撤单：带 digest 时撤条件单（条件单不在常规挂单列表里）；
    // 否则按「同市场 + 同方向 + 同价格」在实盘挂单里定位，逐张撤销。
    // 找不到匹配视为已撤销/已成交（幂等），不报错——ASH 可能重复发同一条撤单。
    if (signal.action === "cancel") {
      try {
        if (signal.digest) {
          const r = await cancelTriggerOrderLive(wallet.walletId, signal.market, [signal.digest]);
          results.push({ address: target, ok: true, label: `已撤条件单 ${r.cancelled} 张` });
          continue;
        }
        const snap = await reconcileWallet(wallet.walletId);
        const want = Number(signal.price);
        const eps = Math.max(Math.abs(want) * 1e-6, 1e-9);
        const hits = (snap.openOrders ?? []).filter(
          (o) =>
            o.market === signal.market &&
            o.side === signal.side &&
            Math.abs(Number(o.price) - want) <= eps,
        );
        if (hits.length === 0) {
          results.push({ address: target, ok: true, label: "无匹配挂单（已撤销或已成交）" });
          continue;
        }
        let cancelled = 0;
        for (const o of hits) {
          if (!o.venueId) continue;
          const r = await cancelLive(wallet.walletId, signal.market, o.venueId);
          cancelled += r.cancelled.length;
        }
        results.push({ address: target, ok: true, label: `已撤 ${cancelled}/${hits.length} 张挂单` });
      } catch (e) {
        results.push({ address: target, ok: false, label: errText(e) });
      }
      continue;
    }

    try {
      // 先把信号里的品种写法解析成唯一品种（marketId / symbol / productId 均可）：
      // 解析失败直接报「未知品种」，绝不落到默认品种；解析结果同时用于下单和回显。
      const product = await resolveProductLive(signal.market);
      // 条件单：签名后提交到 trigger 服务，触发前不占盘口；返回 digest 供策略按 digest 撤单
      if (signal.kind === "trigger") {
        if (!signal.triggerType || !signal.triggerPrice || !signal.price) {
          throw new Error("条件单缺少 triggerType / triggerPrice / price");
        }
        const t = await placeTriggerOrderLive(wallet.walletId, product.marketId, {
          side: signal.side,
          size: signal.size,
          price: signal.price,
          triggerType: signal.triggerType,
          triggerPrice: signal.triggerPrice,
          reduceOnly: signal.reduceOnly,
        });
        results.push({
          address: target,
          ok: true,
          label: `条件单 ${t.status} ${product.symbol}${t.digest ? ` ${t.digest.slice(0, 10)}…` : ""}`,
          order: { digest: t.digest, status: t.status, market: product.marketId, productId: product.productId },
        });
        continue;
      }
      const order = await placeOrderLive(wallet.walletId, product.marketId, {
        side: signal.side,
        size: signal.size,
        // market 信号交给盘口对手价（taker），limit 信号用策略给的价
        price: signal.kind === "market" ? undefined : signal.price,
        taker: signal.kind === "market",
        // 策略可显式要求"普通 GTC"（可挂可吃），用于确认追单
        ...(signal.postOnly === false ? { postOnly: false } : {}),
        reduceOnly: signal.reduceOnly,
        // 幂等：同一 clientId / 信号 / 钱包在标签页内重试不会重复下单
        jobId: `sig:${signal.clientId ?? signal.id}:${target}`,
      });

      // 下单后回读一次账户，把持仓/挂单回给策略（读失败不影响订单本身）
      let execution: StrategyExecution | undefined;
      try {
        const snap = await reconcileWallet(wallet.walletId);
        // 用解析后的 marketId 匹配持仓：信号可能只给了 symbol，直接拿 signal.market 会匹配不到
        const pos = snap.positions?.find((p) => p.market === product.marketId);
        execution = {
          position: pos
            ? { side: pos.side, size: String(pos.size), entryPrice: String(pos.entryPrice) }
            : { side: "flat", size: "0", entryPrice: "0" },
          openOrders: snap.openOrders?.length,
        };
      } catch { /* 快照只是反馈，缺失不影响下单结果 */ }

      const venueId = order.venueId ? ` #${order.venueId}` : "";
      results.push({
        address: target, ok: true, label: `${order.status} ${product.symbol}${venueId}`,
        order: { digest: order.venueId, status: order.status, market: product.marketId, productId: product.productId },
        execution,
      });
    } catch (e) {
      results.push({ address: target, ok: false, label: errText(e) });
    }
  }

  const okOnes = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const first = okOnes[0];
  const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

  if (!okOnes.length) {
    return {
      ok: false,
      label: results.length === 1 ? failed[0]!.label : `${results.length} 个钱包全部失败：${failed[0]!.label}`,
    };
  }
  if (failed.length) {
    return {
      ok: false,
      label: `${okOnes.length}/${results.length} 成功 · ${short(failed[0]!.address)} 失败：${failed[0]!.label}`,
      order: first!.order, execution: first!.execution,
    };
  }
  return {
    ok: true,
    label: results.length === 1 ? first!.label : `${okOnes.length}/${results.length} 成功 · ${first!.label}`,
    order: first!.order, execution: first!.execution,
  };
}

/** 把任意抛出物转成可读文案。SDK 有时直接抛普通对象，String(obj) 只会得到 "[object Object]"，
 *  导致信号失败原因在页面上无法排查。 */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; error?: unknown; code?: unknown };
    const msg = typeof o.message === "string" ? o.message : typeof o.error === "string" ? o.error : "";
    if (msg) return o.code === undefined ? msg : `${msg}（code=${String(o.code)}）`;
    try {
      return JSON.stringify(e).slice(0, 300);
    } catch {
      return "未知错误";
    }
  }
  return String(e);
}

/** 轮询并执行外部策略信号；enabled 为 false（未解锁 / 未开启 live）时不工作。
 *  execWallets 是网页「策略执行」选定的钱包范围（信号未带地址时使用）；
 *  多个地址 = 跟单模式，一笔信号在每个钱包各开一份。 */
export function useStrategyBridge(enabled: boolean, execWallets: string[] = []): StrategyBridgeState {
  const [state, setState] = useState<StrategyBridgeState>({ pending: 0 });
  const busy = useRef(false);
  const failures = useRef(0);
  const pausedUntil = useRef(0);
  // 用 ref 保存最新范围，避免数组引用变化导致轮询重启；依赖用排好序的字符串 key
  const walletsRef = useRef<string[]>(execWallets);
  walletsRef.current = execWallets;
  const walletKey = [...execWallets].sort().join(",");

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (stopped) return;
      if (busy.current || !isUnlocked()) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      if (Date.now() < pausedUntil.current) {
        const secs = Math.ceil((pausedUntil.current - Date.now()) / 1000);
        setState((s) => ({ ...s, error: `连续失败已熔断，${secs} 秒后自动恢复` }));
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      busy.current = true;
      try {
        const res = await fetch(`/api/strategy/signal?status=pending&limit=100`, { cache: "no-store" });
        if (!res.ok) throw new Error(`信号接口返回 ${res.status}`);
        const body = (await res.json()) as { signals?: StrategySignal[] };
        const queue = body.signals ?? [];
        let pending = queue.length;
        let last: StrategyBridgeState["last"];

        for (const signal of queue.slice(0, BATCH)) {
          if (stopped) break;
          // 领取：被别的标签页抢先时返回 409，这里直接跳过
          const claimed = await fetch(`/api/strategy/signal/${signal.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "claim" }),
          });
          if (!claimed.ok) continue;
          const { claimToken } = (await claimed.json()) as { claimToken?: string };
          if (!claimToken) continue;

          let result: ExecResult;
          try {
            result = await runSignal(signal, walletsRef.current);
          } catch (e) {
            result = { ok: false, label: errText(e) };
          }

          await fetch(`/api/strategy/signal/${signal.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "result",
              token: claimToken,
              status: result.ok ? "done" : "error",
              error: result.ok ? undefined : result.label,
              order: result.order,
              execution: result.execution,
            }),
          }).catch(() => { /* 结果回写失败时租约到期会自动重试 */ });

          // 熔断计数：成功清零，连续失败到阈值就暂停一段时间
          if (result.ok) {
            failures.current = 0;
          } else {
            failures.current += 1;
            if (failures.current >= MAX_FAILURES) {
              pausedUntil.current = Date.now() + COOLDOWN_MS;
              failures.current = 0;
            }
          }

          pending = Math.max(0, pending - 1);
          last = { at: Date.now(), ok: result.ok, label: result.label };
          if (!stopped) {
            setState((s) => ({ pending, last: last ?? s.last, error: result.ok ? undefined : result.label }));
          }
        }

        if (!stopped) {
          setState((s) => ({ pending, last: last ?? s.last, error: last && !last.ok ? last.label : s.error }));
        }
      } catch (e) {
        if (!stopped) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        busy.current = false;
        if (!stopped) timer = setTimeout(tick, POLL_MS);
      }
    };

    timer = setTimeout(tick, 1_000);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [enabled, walletKey]);

  return state;
}
