// =============================================================================
// ASH 页面的展示格式化（纯函数，服务端/客户端都可安全引用）。
// =============================================================================

export type BadgeVariant = "success" | "warning" | "error" | "secondary" | "primary";

/** 时间：时:分:秒（用于事件流）。 */
export function ashTime(ms?: number): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 日期 + 时间：月-日 时:分:秒（用于计划/成交）。 */
export function ashDateTime(ms?: number): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("zh-CN", {
    hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/** 数字：保留至多 digits 位小数并加千分位；非法值显示 "-"。 */
export function ashNum(value: unknown, digits = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** 数量：小数位多一些（ASH 的 qty 常见 4~6 位）。 */
export function ashQty(value: unknown): string {
  return ashNum(value, 6);
}

/** 带符号的盈亏。 */
export function ashPnl(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const text = ashNum(Math.abs(n), 4);
  return n > 0 ? `+${text}` : n < 0 ? `-${text}` : "0";
}

/** 方向：1 做多 / -1 做空。 */
export function ashDir(dir: number): string {
  return dir > 0 ? "做多" : "做空";
}

/** 计划状态的徽标样式。 */
export function ashPlanState(state: string): { text: string; variant: BadgeVariant } {
  switch (String(state).toUpperCase()) {
    case "OPEN": return { text: "持仓中", variant: "success" };
    case "CLOSED": return { text: "已平仓", variant: "secondary" };
    case "PENDING": return { text: "待确认", variant: "warning" };
    default: return { text: state || "-", variant: "secondary" };
  }
}

/** 信号等级徽标样式（S/A 更高；EXTERNAL = 接管实盘已有仓位）。 */
export function ashGrade(grade: string): BadgeVariant {
  const g = String(grade).toUpperCase();
  if (g === "S") return "primary";
  if (g === "A") return "success";
  if (g === "EXTERNAL") return "warning";
  if (g === "B") return "secondary";
  return "secondary";
}

/** 桥转发事件的中文说明（journal 里的 NADO_* 事件）。 */
export function ashBridgeKind(kind: string): string {
  switch (kind) {
    case "NADO_SIGNAL_SENT": return "已转发 Nado";
    case "NADO_SIGNAL_DRYRUN": return "试运行（未转发）";
    case "NADO_CANCEL_SENT": return "撤单已转发";
    case "NADO_CANCEL_DRYRUN": return "撤单（试运行）";
    case "NADO_BRIDGE_START": return "桥启动";
    case "NADO_SIGNAL_FAIL": return "转发失败";
    case "NADO_EXIT_SKIP_LIVE": return "平仓跳过（实盘无仓）";
    case "NADO_ENTRY_SKIP_LIVE": return "开仓跳过（实盘反向仓）";
    case "NADO_ENTRY_SKIP_MAKER": return "开仓跳过（纯 maker 不追单）";
    case "NADO_POSITION_ADOPTED": return "接管实盘仓位";
    case "NADO_ADOPT_CONFLICT": return "接管跳过（方向冲突）";
    case "NADO_POSITION_WATCH": return "开始盯钱包";
    case "NADO_POSITION_BACKEND_START": return "后端仓位同步启动";
    case "LIVE_POSITION_SYNC": return "仓位同步";
    case "LIVE_POSITION_CLOSED": return "实盘已平仓 → 计划关闭";
    case "LIVE_FILL_CONFIRMED": return "实盘成交确认";
    default: return kind;
  }
}
