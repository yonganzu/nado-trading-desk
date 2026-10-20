// =============================================================================
// 本机请求判断（服务端）：钱包私钥只允许在本机浏览器与本地自动化进程之间传递。
// Next dev 可能补上 x-forwarded-for，因此只要 Host 与转发来源都是回环地址就放行。
// =============================================================================
const LOOPBACK = ["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"];

export function isLocalRequest(req: Request): boolean {
  const hostHeader = (req.headers.get("host") ?? "").toLowerCase();
  const hostname = (hostHeader.split(":")[0] || new URL(req.url).hostname).replace(/^\[|\]$/g, "");
  const forwarded = ((req.headers.get("x-forwarded-for") ?? "").split(",")[0] ?? "").trim().replace(/^\[|\]$/g, "");
  return LOOPBACK.includes(hostname) && (!forwarded || LOOPBACK.includes(forwarded));
}
