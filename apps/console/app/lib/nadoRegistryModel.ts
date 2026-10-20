// =============================================================================
// 注册结果登记表的纯逻辑（无文件系统、无 server-only 依赖，便于单元测试）。
// 服务端用它落盘，浏览器端用它把记录转成卡片状态。
// =============================================================================

/** 登记表中的一条记录：以钱包地址为唯一键。 */
export interface NadoRegistryEntry {
  /** 钱包地址（小写，唯一键）。 */
  address: string;
  /** 所属账户 slug 与账户内序号，便于按账户对齐。 */
  accountSlug?: string;
  walletIndex?: number;
  /** 最新一次有结论的注册结果；undefined 表示只失败过、还没有结论。 */
  registered?: boolean;
  /** 首次注册时设置的用户名（如果知道）。 */
  username?: string;
  /** 最近一次有结论（检查成功 / 注册成功）的时间。 */
  checkedAt?: number;
  /** 最近一次尝试的时间（包括失败）。 */
  lastAttemptAt: number;
  /** 最近一次失败原因；成功后清空。 */
  lastError?: string;
  source: "check" | "login";
}

/** 卡片上的展示状态。 */
export type WalletCheckState =
  | { status: "running" }
  | { status: "registered"; checkedAt?: number; username?: string }
  | { status: "unregistered"; checkedAt?: number }
  | { status: "failed"; error: string };

export interface CheckInput {
  address: string;
  accountSlug?: string;
  walletIndex?: number;
  registered: boolean;
}

export interface LoginInput {
  address: string;
  accountSlug?: string;
  walletIndex?: number;
  username?: string;
}

export interface FailureInput {
  address: string;
  accountSlug?: string;
  walletIndex?: number;
  error: string;
  mode: "check" | "login";
}

/** 检查完成：写入结论；未注册时清掉可能残留的旧用户名。 */
export function applyCheck(prev: NadoRegistryEntry | undefined, input: CheckInput, now = Date.now()): NadoRegistryEntry {
  return {
    ...prev,
    address: input.address.toLowerCase(),
    accountSlug: input.accountSlug ?? prev?.accountSlug,
    walletIndex: input.walletIndex ?? prev?.walletIndex,
    registered: input.registered,
    username: input.registered ? prev?.username : undefined,
    checkedAt: now,
    lastAttemptAt: now,
    lastError: undefined,
    source: "check",
  };
}

/** 完整注册成功：一定是已注册；没拿到新用户名时保留旧值。 */
export function applyLogin(prev: NadoRegistryEntry | undefined, input: LoginInput, now = Date.now()): NadoRegistryEntry {
  return {
    ...prev,
    address: input.address.toLowerCase(),
    accountSlug: input.accountSlug ?? prev?.accountSlug,
    walletIndex: input.walletIndex ?? prev?.walletIndex,
    registered: true,
    username: input.username ?? prev?.username,
    checkedAt: now,
    lastAttemptAt: now,
    lastError: undefined,
    source: "login",
  };
}

/** 失败：保留已有结论与用户名，只记录错误和尝试时间。 */
export function applyFailure(prev: NadoRegistryEntry | undefined, input: FailureInput, now = Date.now()): NadoRegistryEntry {
  return {
    ...prev,
    address: input.address.toLowerCase(),
    accountSlug: input.accountSlug ?? prev?.accountSlug,
    walletIndex: input.walletIndex ?? prev?.walletIndex,
    lastAttemptAt: now,
    lastError: input.error,
    source: prev?.source ?? input.mode,
  };
}

/** 把登记表记录转成卡片状态；没有结论也没有错误时返回 undefined。 */
export function checkStateFromEntry(entry: NadoRegistryEntry | null | undefined): WalletCheckState | undefined {
  if (!entry) return undefined;
  if (typeof entry.registered === "boolean") {
    return entry.registered
      ? { status: "registered", checkedAt: entry.checkedAt, username: entry.username }
      : { status: "unregistered", checkedAt: entry.checkedAt };
  }
  if (entry.lastError) return { status: "failed", error: entry.lastError };
  return undefined;
}

/** 卡片状态里「结论」的时间；检查中的状态和失败状态没有结论时间，按 0 处理。 */
function stateTime(state: WalletCheckState): number {
  return state.status === "registered" || state.status === "unregistered" ? state.checkedAt ?? 0 : 0;
}

/** 后端登记表里的新状态是否应当覆盖卡片当前状态。
 *  规则：正在检查中的钱包不动；已注册优先于未注册/失败；同类结论按时间取新；失败不覆盖已有结论。 */
function shouldReplaceStored(cur: WalletCheckState | undefined, stored: WalletCheckState): boolean {
  if (!cur) return true;
  if (cur.status === "running") return false;
  if (stored.status === "failed") return cur.status === "failed";
  if (stored.status === "registered") {
    return cur.status !== "registered" || stateTime(stored) >= stateTime(cur);
  }
  // stored 为未注册：不能把「已注册」降级，其余情况按时间取新
  if (cur.status === "registered") return false;
  return stateTime(stored) >= stateTime(cur);
}

/** 把后端登记表（按地址索引）回填到卡片的展示状态（按钱包 id 索引）。
 *  首页钱包列表会在实时刷新时反复重建，这里只负责「地址 → 钱包」的一一对应，返回原对象表示没有变化。 */
export function applyStoredStates(
  current: Record<string, WalletCheckState>,
  stored: Record<string, WalletCheckState>,
  wallets: ReadonlyArray<{ id: string; address: string }>,
): Record<string, WalletCheckState> {
  let changed = false;
  const next = { ...current };
  for (const w of wallets) {
    const state = stored[w.address.toLowerCase()];
    if (!state) continue;
    if (!shouldReplaceStored(next[w.id], state)) continue;
    next[w.id] = state;
    changed = true;
  }
  return changed ? next : current;
}

/** worker 汇报的单钱包结果（与 WalletLoginResult 的字段对齐，避免循环依赖）。 */
export interface WalletOutcome {
  index: number;
  address: string;
  status: "pending" | "running" | "ok" | "failed";
  error?: string;
  username?: string;
  registered?: boolean;
}

export type RegistryUpdate =
  | ({ kind: "check" } & CheckInput)
  | ({ kind: "login" } & LoginInput)
  | ({ kind: "failure" } & FailureInput);

/** 决定一条 worker 结果应该怎样写入登记表；不该写时返回 null。
 *  检查模式只有在结果里带 registered 时才写，避免把“登录成功”误当成“已注册”。 */
export function registryUpdateFor(
  mode: "login" | "check",
  result: WalletOutcome,
  accountSlug?: string,
): RegistryUpdate | null {
  const base = { address: result.address, accountSlug, walletIndex: result.index };
  if (result.status === "ok") {
    if (mode === "check") {
      return typeof result.registered === "boolean"
        ? { kind: "check", ...base, registered: result.registered }
        : null;
    }
    return { kind: "login", ...base, username: result.username };
  }
  if (result.status === "failed") {
    return { kind: "failure", ...base, error: result.error ?? "自动化执行失败", mode };
  }
  return null;
}
