// =============================================================================
// Sequencer（撮合引擎）端点解析。官方对「延迟敏感」用户的建议是用 direct 网关：
// 它与 sequencer 同机房（东京），少一层边缘转发。
//
// 实测（本机 → 东京，各 5 次取中位数）：
//   REST /query        官方 94ms → direct 88ms
//   REST /edge/query   官方 93ms → direct 80ms（网关内存缓存，不回撮合引擎）
//   WS   建连          官方 269ms → direct 224ms
//
// 两个坑（实测确认，别照文档字面拼）：
//   1. direct 网关**没有** /gateway/v1 或 /v2 前缀：`/v2/query` 返回 404，正确路径是 `/query`。
//   2. WS 用 `/subscribe`（与官方同一套帧协议，all_bbo / order_update / fill 均已验证）。
//      文档里的 `/ws/v2` 能连上但协议不同（旧帧一律回 "did not match"，且需要鉴权），暂不用。
//
// 测试网没有 direct 部署，仍走官方域名；设 NADO_DIRECT_GATEWAY=0 可整体回退到官方端点。
// =============================================================================
import "server-only";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS } from "@nadohq/client";

/** direct 网关的 REST 基址（后面直接拼 /query、/execute、/edge/query）。 */
export const DIRECT_GATEWAY_URL = "https://direct-gateway.prod.nado-backend.xyz";
/** direct 网关的 WS 订阅地址（直接连，连上后发送 subscribe 帧）。 */
export const DIRECT_GATEWAY_WS = "wss://direct-gateway.prod.nado-backend.xyz/subscribe";

/** 是否启用 direct 网关。只有主网有 direct 部署，测试网一律走官方域名。 */
export function directGatewayEnabled(env: string): boolean {
  return process.env.NADO_DIRECT_GATEWAY !== "0" && env === "inkMainnet";
}

/** 该 chainId 对应的 REST 基址（主网默认 direct，测试网/回退用官方）。 */
export function engineBaseUrl(chainId: number): string {
  const env = CHAIN_ID_TO_CHAIN_ENV[chainId];
  if (!env) throw new Error(`no Nado chain-env for chainId ${chainId}`);
  return directGatewayEnabled(env) ? DIRECT_GATEWAY_URL : ENGINE_CLIENT_ENDPOINTS[env];
}
