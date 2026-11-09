// =============================================================================
// 外部交易信号的校验与归一化（纯逻辑，服务端与单元测试共用，不依赖 fs / 浏览器）。
//
// 外部策略（Python / Node / 任意语言）把信号 POST 到本机 /api/strategy/signal，
// 由已打开的终端标签页领取、在标签页内签名下单——私钥始终不离开浏览器。
// =============================================================================

export type SignalSide = "buy" | "sell";
/** limit = 限价挂单；market = 吃单；trigger = 条件单（价格触发后按 IOC 送撮合） */
export type SignalKind = "limit" | "market" | "trigger";
export type SignalStatus = "pending" | "claimed" | "done" | "error" | "expired";
/** place = 下单（默认）；cancel = 撤销「同市场 + 同方向 + 同价格」的挂单，
 *  若带 digest 则撤销该 digest 对应的条件单 */
export type SignalAction = "place" | "cancel";

/** 条件单触发价类型：last / mid / oracle 三组「上穿 / 下穿」。 */
export type TriggerPriceType =
  | "last_price_above" | "last_price_below"
  | "mid_price_above" | "mid_price_below"
  | "oracle_price_above" | "oracle_price_below";

/** 归一化后的信号：金额与价格统一成字符串，交由下单路径做 tick / step 对齐。 */
export interface NormalizedSignal {
  /** 下单钱包地址（小写）；留空表示由执行标签页自动选择（仅当保险库恰好一个钱包） */
  wallet: string;
  /** 市场 id，例如 BTC-USD */
  market: string;
  side: SignalSide;
  /** limit = 限价（必须带 price）；market = 吃单（不带 price 时按盘口对手价）；
   *  trigger = 条件单（带 price 作为触发后提交的限价） */
  kind: SignalKind;
  /** 基础币数量，人类小数（如 0.01） */
  size: string;
  price?: string;
  reduceOnly: boolean;
  /** 幂等键：同一个 clientId 重复提交只会产生一条信号 */
  clientId?: string;
  /** 动作类型；缺省视为 place（保持旧调用方行为不变） */
  action?: SignalAction;
  /** 仅对 limit 有效：true（默认）= 只做 maker 的 GTC；false = 普通 GTC，可挂可吃 */
  postOnly?: boolean;
  /** 仅对 trigger 有效：触发条件类型 */
  triggerType?: TriggerPriceType;
  /** 仅对 trigger 有效：触发价（人类小数） */
  triggerPrice?: string;
  /** 仅对 action=cancel 有效：条件单 digest（条件单不在常规挂单列表里，只能按 digest 撤） */
  digest?: string;
}

/** 执行后的账户快照（回写给策略做状态反馈）。 */
export interface StrategyExecution {
  /** 该市场的持仓（无仓位时为 flat） */
  position?: { side: "long" | "short" | "flat"; size: string; entryPrice: string };
  /** 下单后该钱包的挂单数量 */
  openOrders?: number;
}

/** 下单结果回执：除了订单状态，还回显「实际落到哪个品种」。
 *  信号里的 market 可能写成 symbol / productId 等多种形式，回显解析后的
 *  marketId + productId 才能确认没有被下到别的品种上。 */
export interface SignalOrderEcho {
  digest?: string;
  status?: string;
  /** 实际下单的 marketId（例如 nado:perp:SPCX-PERP） */
  market?: string;
  /** 实际下单的 productId */
  productId?: number;
}

/** 队列里的一条信号（服务端内存态）。 */
export interface StrategySignal extends NormalizedSignal {
  id: string;
  status: SignalStatus;
  createdAt: number;
  claimedAt?: number;
  finishedAt?: number;
  /** 被领取的次数；多次领取仍未回写结果会被判失败 */
  attempts: number;
  error?: string;
  order?: SignalOrderEcho;
  execution?: StrategyExecution;
  /** 领取凭证：回写结果时必须带上，避免旧领取方覆盖新结果 */
  claimToken?: string;
}

export type ParseResult = { ok: true; value: NormalizedSignal } | { ok: false; error: string };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const DIGEST_RE = /^0x[0-9a-fA-F]{64}$/; // 条件单 digest（bytes32）
const MAX_UNITS = 1e12; // 数量/价格上限，挡住明显的错误输入
const TRIGGER_TYPES = new Set<TriggerPriceType>([
  "last_price_above", "last_price_below",
  "mid_price_above", "mid_price_below",
  "oracle_price_above", "oracle_price_below",
]);

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const flag = (v: unknown): boolean => v === true || v === "true" || v === 1;

/** 正数校验：接受 number 或十进制字符串，返回规范化字符串；非法返回 null。 */
function positive(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const raw = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_UNITS) return null;
  return raw;
}

/** 校验并归一化一条外部信号；错误信息直接返回给调用方。 */
export function parseSignal(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "请求体必须是 JSON 对象" };
  }
  const body = raw as Record<string, unknown>;

  const wallet = text(body.wallet);
  // 允许留空：由执行标签页在保险库中自动选择唯一钱包；非空时必须是合法地址
  if (wallet && !ADDRESS_RE.test(wallet)) {
    return { ok: false, error: "wallet 必须是 0x 开头的 40 位十六进制地址（或留空自动选择）" };
  }

  const market = text(body.market);
  if (!market || market.length > 64) {
    return { ok: false, error: "market 必填，长度不超过 64（例如 BTC-USD）" };
  }

  const side = text(body.side).toLowerCase();
  if (side !== "buy" && side !== "sell") {
    return { ok: false, error: "side 只能是 buy 或 sell" };
  }

  const kindRaw = text(body.kind).toLowerCase() || "limit";
  if (kindRaw !== "limit" && kindRaw !== "market" && kindRaw !== "trigger") {
    return { ok: false, error: "kind 只能是 limit、market 或 trigger" };
  }
  const kind = kindRaw as SignalKind;

  const size = positive(body.size);
  if (!size) {
    return { ok: false, error: "size 必须是大于 0 的数字（基础币数量）" };
  }

  const price = positive(body.price);
  if (kind === "limit" && !price) {
    return { ok: false, error: "limit 信号必须提供大于 0 的 price" };
  }

  // 条件单：price 是触发后提交给撮合的限价，triggerPrice 才是触发价
  let triggerType: TriggerPriceType | undefined;
  let triggerPrice: string | undefined;
  if (kind === "trigger") {
    const tt = text(body.triggerType).toLowerCase() as TriggerPriceType;
    if (!TRIGGER_TYPES.has(tt)) {
      return { ok: false, error: "triggerType 只能是 last/mid/oracle 的 price_above / price_below" };
    }
    if (!price) return { ok: false, error: "trigger 信号必须提供 price（触发后提交的限价）" };
    const tp = positive(body.triggerPrice);
    if (!tp) return { ok: false, error: "trigger 信号必须提供大于 0 的 triggerPrice" };
    triggerType = tt;
    triggerPrice = tp;
  }

  const clientId = text(body.clientId);
  if (clientId && !CLIENT_ID_RE.test(clientId)) {
    return { ok: false, error: "clientId 只能包含字母、数字、. _ : -，且不超过 64 位" };
  }

  const actionRaw = text(body.action).toLowerCase() || "place";
  if (actionRaw !== "place" && actionRaw !== "cancel") {
    return { ok: false, error: "action 只能是 place 或 cancel" };
  }
  const action = actionRaw as SignalAction;

  // 撤条件单：常规挂单列表里没有条件单，必须按 digest 撤
  const digest = text(body.digest);
  if (digest && !DIGEST_RE.test(digest)) {
    return { ok: false, error: "digest 必须是 0x 开头的 64 位十六进制（条件单 digest）" };
  }
  if (digest && action !== "cancel") {
    return { ok: false, error: "digest 只能和 action=cancel 一起使用" };
  }

  // 只有显式传 false 才切换成"普通 GTC"；缺省走 limit 的 maker 语义，保持旧行为
  const postOnly = body.postOnly === false || body.postOnly === "false" ? false : undefined;

  return {
    ok: true,
    value: {
      wallet: wallet.toLowerCase(),
      market,
      side: side as SignalSide,
      kind,
      size,
      ...(price ? { price } : {}),
      reduceOnly: flag(body.reduceOnly),
      ...(clientId ? { clientId } : {}),
      ...(action === "cancel" ? { action } : {}),
      ...(postOnly === false ? { postOnly: false } : {}),
      ...(triggerType && triggerPrice ? { triggerType, triggerPrice } : {}),
      ...(action === "cancel" && digest ? { digest } : {}),
    },
  };
}
