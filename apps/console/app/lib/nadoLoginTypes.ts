// =============================================================================
// 「官网登录 / 注册」任务的共享类型（客户端与 Node 服务端都可安全引用，不含私钥）。
// =============================================================================
export type WalletLoginStatus = "pending" | "running" | "ok" | "failed";

export interface WalletLoginResult {
  index: number;
  address: string;
  status: WalletLoginStatus;
  error?: string;
  ms?: number;
  /** 首次登录时在官网上设置的用户名（老钱包为空）。 */
  username?: string;
  /** 检查模式的结果：是否已完成注册（无首次登录引导弹窗）。 */
  registered?: boolean;
}

export interface NadoLoginJobView {
  id: string;
  status: "running" | "done" | "failed";
  total: number;
  finished: number;
  startedAt: number;
  results: WalletLoginResult[];
  log: string[];
}
