/** 控制台本地偏好（localStorage）：记住用户上次输入的参数 / 勾选的账号，重新打开页面时恢复。
 *  统一加前缀，避免和别的站点数据串味；隐私模式或配额满时静默降级（读不到就用默认值）。 */

const PREFIX = "nado-console:";

/** 读一个字符串偏好，没有或不合法时返回 null。 */
export function readPref(name: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(PREFIX + name);
  } catch {
    return null;
  }
}

/** 写一个字符串偏好（失败静默忽略，不影响主流程）。 */
export function writePref(name: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + name, value);
  } catch {
    /* 隐私模式 / 配额已满：忽略 */
  }
}

/** 读一个 JSON 偏好；解析失败按「没有保存过」处理。 */
export function readPrefJson<T>(name: string): T | null {
  const raw = readPref(name);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 写一个 JSON 偏好。 */
export function writePrefJson(name: string, value: unknown): void {
  try {
    writePref(name, JSON.stringify(value));
  } catch {
    /* 序列化失败：忽略 */
  }
}
