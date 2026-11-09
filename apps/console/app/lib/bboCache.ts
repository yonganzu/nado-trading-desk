// =============================================================================
// 内存 BBO 快照（供自动化取价用）。
//
// 自动化的每一对都要先取一次「买一/卖一」来算自成交价。原来这一步走 REST 读 depth-1 订单簿，
// 而 REST 的 per-IP 读预算只有 ~2 次/秒、还要和页面后台轮询抢 —— 实测出现过「round 开始 →
// maker 提交」等 7s 的情况（两腿本身只有 0.3s）。
//
// 这里复用 sequencer 的 `all_bbo` 流（一次订阅覆盖全部产品，约 300ms 一帧，不占 REST 配额），
// 把最近一帧的价格缓存在内存里。取价方先看缓存（毫秒级、零配额），过期或缺失再回退 REST。
//
// 与 marketSpreads.watchSpreads 的区别：那边是页面上「点差筛选」用的，页面不可见时会跳过解析；
// 而自动化可能在后台标签页里跑，所以这里**不做可见性判断**，只要订阅着就照常更新。
// =============================================================================

export interface BboQuote {
  /** 买一价，x18 定点字符串（all_bbo 的原始表示）。 */
  bid: string;
  /** 卖一价，x18 定点字符串。 */
  ask: string;
  /** 收到这一帧的本机时间，用来判断新鲜度。 */
  at: number;
}

/** 当前连接订阅的 ws 地址：同一个地址重复 start 不会重复建连。 */
let currentUrl: string | null = null;
let ws: WebSocket | null = null;
let retry = 0;
let idc = 1;
let closed = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** productId → 最近一帧的买一/卖一。 */
const snapshot = new Map<number, BboQuote>();

/** 开始维护快照（幂等）。url 变化时会先关掉旧的连接。 */
export function startBboCache(url: string): void {
  if (currentUrl === url && ws && !closed) return;
  stopBboCache();
  currentUrl = url;
  closed = false;
  retry = 0;
  connect();
}

/** 停止维护快照并清空缓存。 */
export function stopBboCache(): void {
  closed = true;
  currentUrl = null;
  snapshot.clear();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { ws?.close(); } catch { /* ignore */ }
  ws = null;
}

/**
 * 取某个产品的买一/卖一。超过 maxAgeMs 没更新（断线 / 该产品没行情）视为不可用，返回 undefined，
 * 由调用方回退到 REST。
 */
export function getBboQuote(productId: number, maxAgeMs = 2_000): BboQuote | undefined {
  const q = snapshot.get(productId);
  if (!q) return undefined;
  if (Date.now() - q.at > maxAgeMs) return undefined;
  return q;
}

function connect(): void {
  if (closed || !currentUrl) return;
  try {
    ws = new WebSocket(currentUrl);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    retry = 0;
    try { ws?.send(JSON.stringify({ id: idc++, method: "subscribe", stream: { type: "all_bbo" } })); } catch { /* ignore */ }
  };
  ws.onmessage = (ev) => {
    if (closed) return;
    try {
      const m = JSON.parse(String(ev.data)) as { type?: string; bbos?: Record<string, { bid?: string; ask?: string }> };
      if (m.type !== "all_bbo" || !m.bbos) return;
      const now = Date.now();
      for (const [pid, e] of Object.entries(m.bbos)) {
        if (!e) continue;
        snapshot.set(Number(pid), { bid: e.bid ?? "0", ask: e.ask ?? "0", at: now });
      }
    } catch { /* 非 JSON / 心跳帧 — 忽略 */ }
  };
  ws.onclose = () => { scheduleReconnect(); };
  // onerror 之后一定会有 onclose，交给 onclose 统一重连
  ws.onerror = () => { /* ignore */ };
}

function scheduleReconnect(): void {
  if (closed) return;
  retry = Math.min(retry + 1, 6);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 500 * 2 ** retry); // 1s → ~32s 退避
}
