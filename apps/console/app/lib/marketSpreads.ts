// =============================================================================
// 全市场点差检测：订阅 sequencer 的 `all_bbo` 流（一次订阅覆盖所有产品，
// 服务端固定约 300ms 推一帧全市场买一/卖一快照），据此算出每个标的的买一卖一相隔几个 tick。
//
// 为什么不逐标的查盘口：REST 限速按出口 IP 共享（浏览器与服务器共用同一配额），
// 十几只标的串行查一次就会触发长时间 429。all_bbo 走 WS，不消耗 REST 配额。
// 协议与 liveStream 一致：{ id, method: "subscribe", stream: { type } }。
//
// 频率控制（点差不需要毫秒级精度，300ms 一帧全量计算纯属浪费）：
//   - 帧照收，但默认 `intervalMs = 1000` 才算一次，计算量降到 1/3；
//   - 判定合格立刻生效；判定不合格要连续 `confirmFrames = 2` 次才真的排除，
//     避免一帧 1 tick 抖动就把标的从 Market 列表里闪掉；
//   - 页面不可见（切到别的标签页）时直接跳过解析与计算，回到页面后下一帧立刻恢复。
// =============================================================================
export interface SpreadProduct {
  marketId: string;
  productId: number;
  /** 人类可读的价格 tick（如 "0.01"），由 /api/nado/state 的 products 提供 */
  tickSize: string;
}

export interface SpreadWatchHandle { close: () => void }

/** 没有卖盘时 sequencer 会把 ask 填成 MAX_I128；用这个量级来判断「单边/无盘口」。 */
const NO_ASK = 10n ** 30n;

/** `all_bbo` 里的价格是 x18 整数（如 "80595000000000000000000"），直接转 BigInt。 */
const intX18 = (v: string): bigint | null => (/^\d+$/.test(v) ? BigInt(v) : null);

/** 人类可读的小数转 x18 BigInt（支持 "0.001"、"1e-8" 这类写法），避免浮点数丢精度。 */
function decimalToX18(raw: string): bigint | null {
  const m = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(raw.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1n : 1n;
  const digits = `${m[2] ?? ""}${m[3] ?? ""}`;
  if (!digits) return null;
  const shift = 18 + Number(m[4] ?? 0) - (m[3] ?? "").length;
  const base = BigInt(digits);
  // shift < 0 说明精度超过 18 位，截断尾部（tick 精度远小于 18 位，截断不会影响结论）
  const scaled = shift >= 0 ? base * 10n ** BigInt(shift) : base / 10n ** BigInt(-shift);
  return sign * scaled;
}

/**
 * 订阅 all_bbo 并持续算出「哪些标的点差 ≥ minTicks」。
 * 只在结论（或确认后的结论）发生变化时回调一次，避免把 React 重渲染打满；
 * 读不到盘口（单边 / 空盘口 / 还没进快照）的标的不下新结论，沿用上一次结论（从未有过则不筛）。
 */
export function watchSpreads(opts: {
  url: string;
  products: SpreadProduct[];
  minTicks: number;
  /** 多少毫秒才算一次点差（默认 1000）。服务端固定约 300ms 一帧，帧照收、只在到点时计算。 */
  intervalMs?: number;
  /** 判定「不合格」要连续多少次才算数（默认 2）；判定合格不需要确认，立刻生效。 */
  confirmFrames?: number;
  onChanged: (ok: Record<string, boolean>) => void;
  onStatus?: (s: "open" | "closed" | "error") => void;
}): SpreadWatchHandle {
  const intervalMs = Math.max(300, opts.intervalMs ?? 1_000);
  const confirmFrames = Math.max(1, opts.confirmFrames ?? 2);

  // productId → 标的 / tick（x18），只保留 tick 可解析的标的
  const byProduct = new Map<number, SpreadProduct>();
  const tickX18 = new Map<number, bigint>();
  for (const p of opts.products) {
    const tick = decimalToX18(String(p.tickSize ?? ""));
    if (tick && tick > 0n) {
      byProduct.set(p.productId, p);
      tickX18.set(p.productId, tick);
    }
  }

  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let idc = 1;
  let signature = "";                    // 上一次已回调结论的指纹，用来判断「有没有变化」
  let latest: Record<string, { bid?: string; ask?: string } | undefined> | null = null; // 最近一帧
  let lastEvalAt = 0;                    // 上次真正计算的时间
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 每个标的的稳定结论 + 连续「不合格」次数（用于 confirmFrames）
  const stable = new Map<string, { ok: boolean; low: number }>();

  /** 用最近一帧算一遍，按确认规则合并后，只有结论变化才回调。 */
  const evaluate = (): void => {
    const frame = latest;
    if (!frame) return;
    const next: Record<string, boolean> = {};
    for (const [pidStr, entry] of Object.entries(frame)) {
      const prod = byProduct.get(Number(pidStr));
      if (!prod || !entry) continue;
      const bid = intX18(entry.bid ?? "");
      const ask = intX18(entry.ask ?? "");
      const tick = tickX18.get(prod.productId);
      const prev = stable.get(prod.marketId);
      // 单边 / 无盘口 / 价格倒挂：本轮不下新结论，沿用上一次（没有过就跳过 = 不筛）
      if (!tick || bid === null || bid <= 0n || ask === null || ask >= NO_ASK || ask < bid) {
        if (prev) next[prod.marketId] = prev.ok;
        continue;
      }
      const ticks = Number((ask - bid) / tick);
      if (!Number.isFinite(ticks)) {
        if (prev) next[prod.marketId] = prev.ok;
        continue;
      }
      if (ticks >= opts.minTicks) {
        // 合格：立刻生效，并清零不合格计数（点差变宽通常稍纵即逝，没必要等确认）
        stable.set(prod.marketId, { ok: true, low: 0 });
        next[prod.marketId] = true;
        continue;
      }
      const low = prev && !prev.ok ? prev.low + 1 : 1;
      if (low >= confirmFrames) {
        stable.set(prod.marketId, { ok: false, low });
        next[prod.marketId] = false;
      } else {
        // 还没连续够次数：先维持「合格」，别让列表闪一下
        stable.set(prod.marketId, { ok: prev?.ok ?? true, low });
        next[prod.marketId] = stable.get(prod.marketId)!.ok;
      }
    }
    const sig = Object.keys(next).sort().map((id) => `${id}:${next[id] ? 1 : 0}`).join("|");
    if (sig === signature) return; // 结论没变：不触发重渲染
    signature = sig;
    opts.onChanged(next);
  };

  /** 到点才计算：帧仍按 300ms 收，但最多每 intervalMs 算一次。 */
  const schedule = (): void => {
    const wait = intervalMs - (Date.now() - lastEvalAt);
    if (wait <= 0) {
      lastEvalAt = Date.now();
      evaluate();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      lastEvalAt = Date.now();
      evaluate();
    }, wait);
  };

  const connect = (): void => {
    if (closed) return;
    try { ws = new WebSocket(opts.url); } catch { scheduleReconnect(); return; }
    ws.onopen = () => {
      retry = 0;
      opts.onStatus?.("open");
      try { ws?.send(JSON.stringify({ id: idc++, method: "subscribe", stream: { type: "all_bbo" } })); } catch { /* ignore */ }
    };
    ws.onmessage = (ev) => {
      if (closed) return;
      // 页面不可见：连 JSON.parse 都省掉（回到页面后下一帧自然恢复）
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const m = JSON.parse(String(ev.data)) as { type?: string; bbos?: Record<string, { bid?: string; ask?: string }> };
        if (m.type === "all_bbo" && m.bbos) {
          latest = m.bbos;
          schedule();
        }
      } catch { /* 非 JSON / ping — 忽略 */ }
    };
    ws.onclose = () => { opts.onStatus?.("closed"); scheduleReconnect(); };
    ws.onerror = () => { opts.onStatus?.("error"); };
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry); // 1s → ~32s 退避
  };

  connect();
  return {
    close: () => {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
