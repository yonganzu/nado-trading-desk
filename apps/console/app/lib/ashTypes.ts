// =============================================================================
// ASH 交易终端（本机 8788）只读数据的类型定义。
// 服务端代理（/api/ash/signals）与浏览器页面共用，避免两边字段漂移。
// =============================================================================

/** 一条 ASH 交易计划：足迹图信号 → 计划（入场 / 止损 / TP / 数量 / 状态）。 */
export interface AshPlan {
  key: string;
  symbol: string;
  /** 1 = 做多，-1 = 做空 */
  dir: 1 | -1;
  /** 信号等级 B / A / S；EXTERNAL = 接管 Nado 上已有的仓位 */
  grade: string;
  signalStatus: string;
  /** OPEN / CLOSED / ... */
  state: string;
  /** true = 这条计划是接管实盘已有仓位（不是 ASH 信号开的），桥不再重复开仓 */
  external?: boolean;
  entryRef?: number;
  entryFillPrice?: number;
  qty?: number;
  openQty?: number;
  remainingQty?: number;
  stop?: number;
  stopSource?: string;
  tp?: number[];
  components?: string[];
  sourceEvent?: string;
  decision?: string;
  realizedPnl?: number;
  feePaid?: number;
  /** Nado 通道口径的浮动盈亏（持仓期由 ASH 后端从 subaccount_info 刷新） */
  nadoPnl?: number;
  /** 该浮动盈亏的计算时间；0 / 缺失 = 还没有 Nado 数据 */
  nadoPnlAt?: number;
  /** Nado oracle 标记价与开仓均价（用来核对盈亏） */
  nadoMarkPrice?: number;
  nadoEntryPrice?: number;
  createdAt?: number;
  updatedAt?: number;
  expireAt?: number;
  exitReason?: string;
}

/** 一笔成交（开仓追单 / 止盈 / 止损）。 */
export interface AshExecution {
  id: number;
  plan_key: string;
  symbol: string;
  kind: string;
  side: string;
  qty: number;
  price: number;
  fee: number;
  realized_pnl: number;
  created_at: number;
}

/** 事件日志（含转发到 Nado 的 NADO_SIGNAL_SENT / NADO_SIGNAL_DRYRUN）。 */
export interface AshJournalEvent {
  id: number;
  kind: string;
  symbol: string;
  plan_key: string;
  payload?: Record<string, unknown>;
  ts: number;
}

/** 控制台同步给 ASH 的真实仓位（一项）。 */
export interface AshLivePosition {
  market: string;
  symbol: string;
  side: "long" | "short" | "flat";
  size: number;
  entryPrice: number;
  /** Nado oracle 标记价（只有后端直连通道会带） */
  markPrice?: number;
  /** Nado 口径浮动盈亏（只有后端直连通道会带） */
  unrealizedPnl?: number;
  /** 盈亏计算时间；0 / 缺失 = 不是后端 Nado 来源 */
  pnlAt?: number;
}

/**
 * 仓位盈亏记录（/api/position-pnl）：按 Nado 成交回执（nado_fills）做开平配对，
 * 每笔仓位（从 0 持仓到再次回到 0）一条记录。
 */
export interface AshPositionPnl {
  /** 配对键：产品 + 开仓时间，页面用作 React key */
  key: string;
  symbol: string;
  side: "long" | "short";
  /** 这笔仓位的最大持仓数量 */
  qty: number;
  /** 开仓均价（同向加仓按数量加权） */
  entry_price: number;
  /** 平仓价（最后一次平仓成交价）；持仓中为 0 */
  exit_price: number;
  /** 毛利 = (平仓价 − 开仓均价) × 平掉的数量 × 方向 */
  gross_pnl: number;
  /** 手续费累计（maker 返佣为负，等于加回盈亏） */
  fee: number;
  /** 净盈亏 = 毛利 − 手续费；持仓中只含已平掉部分 */
  net_pnl: number;
  opened_at: number;
  /** 0 = 还没平仓 */
  closed_at: number;
  /** 这笔仓位包含的 Nado 成交笔数 */
  fills: number;
  /** OPEN / CLOSED */
  state: string;
}

/** /api/status 里的仓位同步快照。 */
export interface AshPositionState {
  enabled: boolean;
  /** false = 快照已过期（后端读不到 / 控制台标签页关掉），不参与决策 */
  fresh: boolean;
  at: number;
  wallet: string;
  /** 后端实际在看的地址（config 指定或网页选过的） */
  watchWallet?: string;
  /** backend = ASH 后端直连 Nado；browser = 控制台标签页推送 */
  source?: "backend" | "browser";
  /** null = 当前来源读不到挂单数（后端直连只读仓位） */
  openOrders: number | null;
  staleMs: number;
  positions: AshLivePosition[];
}

/** 成交量 / 手续费 / 盈亏累计（/api/status 的 tradeStats，只统计 Nado 明确回执的成交）。 */
export interface AshTradeStats {
  /** Nado 成交回执笔数（一次撮合一条，开仓/平仓都算） */
  fills: number;
  /** 其中吃单成交笔数 */
  takerFills: number;
  /** 其中挂单成交笔数 */
  makerFills: number;
  /** 总成交量：名义额 qty × price（USDT） */
  volume: number;
  /** 总手续费：Nado 回执里的 fee 累计（maker 返佣为负） */
  fee: number;
  /** 手续费率（bps）= fee / volume */
  feeBps: number;
  /** 累计平仓盈亏：Nado 回执里的 realized_pnl 累计（开仓成交为 0，不含手续费） */
  pnl: number;
  /** 总亏损 = 盈亏 − 手续费（负数就是亏） */
  net: number;
  todayFills: number;
  todayVolume: number;
  todayFee: number;
  todayPnl: number;
  todayNet: number;
}

/** ASH 可调参数（/api/config 与 /api/status.tunables 同构，改完立即生效）。 */
export interface AshTunables {
  risk: {
    riskPerTradePct: number;
    maxDailyLossPct: number;
    leverage: number;
    maxOpenPositions: number;
    maxMarginPerPositionPct: number;
    maxTotalMarginPct: number;
    minStopDistancePct: number;
    maxStopDistancePct: number;
    cooldownMinutes: number;
    minNotionalUSDT: number;
  };
  execution: {
    /** maker = 挂单等成交，taker = 立即吃单 */
    entryMode: "maker" | "taker";
    exitMode: "maker" | "taker";
    maxSpreadBps: number;
    maxChaseBps: number;
    maxSignalAgeMs: number;
    /** 兜底止损距离（0 = 不挂兜底单） */
    backstopStopPct: number;
    breakevenOnProfit: boolean;
    breakevenBufferBps: number;
    exitOnOppositeConfirmed: boolean;
    /** 三档止盈的比例，合计必须等于 1 */
    tpFractions: number[];
  };
  signal: {
    lookbackBars: number;
    referenceDays: number;
    minBaselineMinutes: number;
  };
}

/** /api/status 里页面关心的字段。 */
export interface AshStatus {
  version?: string;
  mode?: string;
  feed?: string;
  interval?: string;
  symbols?: string[];
  started?: boolean;
  marketConnected?: boolean;
  trading?: {
    paused?: boolean;
    equityUSDT?: number;
    /** nado = 用执行钱包在 Nado 的真实权益；paper = 读不到余额时的纸面回退 */
    equitySource?: "nado" | "paper";
    /** 纸面口径权益，用于和真实余额对照 */
    paperEquityUSDT?: number;
    /** true = 最小下单测试模式（忽略风险预算，按交易所最小名义额下单） */
    forceMinQtyTest?: boolean;
    todayPnlUSDT?: number;
    maxDailyLossReached?: boolean;
    openCount?: number;
    lastReason?: string;
  };
  /** 合约规格（前端用它判断实盘余额够不够最小下单额） */
  specs?: Record<string, { tickSize?: number; qtyStep?: number; minQty?: number; minNotional?: number }>;
  /** 当前可调参数（策略调参面板的回显基线） */
  tunables?: AshTunables;
  /** 执行钱包在 Nado 的真实账户余额（后端 sync 的，不是纸面权益） */
  account?: {
    enabled: boolean;
    fresh: boolean;
    at: number;
    staleMs: number;
    wallet: string;
    subaccount: string;
    source: string;
    /** 账户净权益（USD，未加权） */
    equity: number;
    /** 现货 USDT0 结余 */
    usdt0: number;
    spotValue: number;
    assets: number;
    liabilities: number;
  };
  scans?: Record<string, unknown>;
  errors?: Record<string, string>;
  /** 成交量与磨损累计（每笔成交的名义额与手续费汇总） */
  tradeStats?: AshTradeStats;
  positions?: AshPositionState;
  bridge?: {
    enabled?: boolean;
    dryRun?: boolean;
    last?: { at: number; ok: boolean | null; reason: string };
    markets?: Record<string, string>;
    forwarded?: number;
    entries?: number;
  };
}

/** /api/ash/signals 的响应体：各部分独立失败，失败原因放在 errors 里。 */
export interface AshSnapshot {
  ok: boolean;
  base: string;
  fetchedAt: number;
  status?: AshStatus;
  plans?: AshPlan[];
  executions?: AshExecution[];
  journal?: AshJournalEvent[];
  /** 仓位盈亏账本（每笔开仓一条记录） */
  positionPnl?: AshPositionPnl[];
  errors?: Record<string, string>;
}
