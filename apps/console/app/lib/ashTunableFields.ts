// =============================================================================
// ASH 策略调参的字段清单（唯一来源：面板渲染 + 提交拼装都用它）。
//
// path 必须与 ASH src/config_api.mjs 的 TUNABLES 白名单完全一致，
// 否则后端会以「不支持调整的参数」拒绝。区间与白名单里的 min/max 保持一致，
// 提前在输入框上标出来，减少一次往返。
// =============================================================================

export interface TunableNumberField {
  /** 例如 risk.riskPerTradePct */
  path: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  /** 输入框步进 */
  step: number;
  hint?: string;
}

export interface TunableBoolField {
  path: string;
  label: string;
  hint?: string;
}

export interface TunableEnumField {
  path: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  hint?: string;
}

export interface TunableGroup {
  key: "risk" | "execution" | "signal";
  title: string;
  hint: string;
  numbers: TunableNumberField[];
  bools: TunableBoolField[];
  enums: TunableEnumField[];
}

export const TUNABLE_GROUPS: TunableGroup[] = [
  {
    key: "risk",
    title: "风险与仓位",
    hint: "决定每笔下多大、最多几笔、亏多少就停手。",
    numbers: [
      { path: "risk.riskPerTradePct", label: "单笔风险", unit: "% 权益", min: 0.01, max: 2, step: 0.01, hint: "止损触发时最多亏掉账户权益的比例" },
      { path: "risk.maxDailyLossPct", label: "日内最大亏损", unit: "% 权益", min: 0.1, max: 10, step: 0.1, hint: "当天累计亏到这个比例就停止开新仓" },
      { path: "risk.leverage", label: "杠杆", unit: "倍", min: 1, max: 5, step: 1 },
      { path: "risk.maxOpenPositions", label: "最大并行仓位数", unit: "个", min: 1, max: 10, step: 1 },
      { path: "risk.maxMarginPerPositionPct", label: "单仓保证金上限", unit: "% 权益", min: 1, max: 100, step: 1 },
      { path: "risk.maxTotalMarginPct", label: "总保证金上限", unit: "% 权益", min: 1, max: 100, step: 1, hint: "不能小于单仓上限" },
      { path: "risk.minStopDistancePct", label: "止损最近距离", unit: "% 价格", min: 0.01, max: 2, step: 0.01, hint: "太近的止损会被外推到这个距离，避开撮合噪音" },
      { path: "risk.maxStopDistancePct", label: "止损最远距离", unit: "% 价格", min: 0.05, max: 20, step: 0.05 },
      { path: "risk.cooldownMinutes", label: "同品种冷却", unit: "分钟", min: 0, max: 120, step: 1, hint: "平仓后多久内不再开同方向的仓" },
      { path: "risk.minNotionalUSDT", label: "最小下单名义额", unit: "USDT", min: 0, max: 10000, step: 1 },
    ],
    bools: [],
    enums: [],
  },
  {
    key: "execution",
    title: "执行与出场",
    hint: "怎么进、怎么出、什么时候把止损挪到保本。",
    numbers: [
      { path: "execution.maxSpreadBps", label: "允许最大点差", unit: "bps", min: 1, max: 100, step: 0.5, hint: "点差超过这个值就不下单，避免吃掉滑点" },
      { path: "execution.maxChaseBps", label: "追价上限", unit: "bps", min: 0, max: 200, step: 1 },
      { path: "execution.maxSignalAgeMs", label: "信号有效时长", unit: "毫秒", min: 1000, max: 60000, step: 500 },
      { path: "execution.backstopStopPct", label: "兜底止损距离", unit: "% 价格", min: 0, max: 2, step: 0.05, hint: "在交易所挂一张只减仓的 rest 止损单；0 = 不挂" },
      { path: "execution.breakevenBufferBps", label: "保本缓冲", unit: "bps", min: 0, max: 50, step: 0.5, hint: "浮盈后止损上移到含手续费+滑点的保本价，再往外留这么多" },
    ],
    bools: [
      { path: "execution.breakevenOnProfit", label: "浮盈后止损移到保本", hint: "覆盖开平仓手续费与滑点后不再亏钱" },
      { path: "execution.exitOnOppositeConfirmed", label: "反向信号确认后直接平仓", hint: "关掉则只等止盈/止损" },
    ],
    enums: [
      {
        path: "execution.entryMode",
        label: "入场方式",
        options: [{ value: "maker", label: "挂单 maker" }, { value: "taker", label: "吃单 taker" }],
      },
      {
        path: "execution.exitMode",
        label: "出场方式",
        options: [{ value: "maker", label: "挂单 maker" }, { value: "taker", label: "吃单 taker" }],
      },
    ],
  },
  {
    key: "signal",
    title: "信号与足迹",
    hint: "足迹信号的回看长度与历史基准要求。",
    numbers: [
      { path: "signal.lookbackBars", label: "回看K线数", unit: "根", min: 30, max: 500, step: 5 },
      { path: "signal.referenceDays", label: "历史基准天数", unit: "天", min: 1, max: 30, step: 1 },
      { path: "signal.minBaselineMinutes", label: "最少基准分钟", unit: "分钟", min: 10, max: 600, step: 10, hint: "不足就不生成信号（拒绝拿不充分的历史伪造评级）" },
    ],
    bools: [],
    enums: [],
  },
];

/** 三档止盈的比例字段（单独渲染，因为要校验合计 100%）。 */
export const TP_PATH = "execution.tpFractions";
