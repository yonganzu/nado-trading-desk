// =============================================================================
// 客户端时钟对齐。撮合引擎按「服务器收到请求的时刻」校验 nonce 里的 recv_time，以及订单
// 的 expiration / 流式鉴权签名时间；本机时钟与 sequencer 偏差约 1s（实测），偏差再大就会
// 踩到 2011 LATE_RECV_EXECUTION 或订单提前过期。
// 注意：recv_time 不等于「此刻」——协议要求它落在服务器时间之后约 90s（SDK 默认 now+90s），
// 本模块只负责给出校正后的「此刻」，那 90s 余量由调用方（liveContext 的 ORDER_RECV_LEAD_MS）加。
//
// 服务端 /api/nado/clock 用 3 次 ping 取中位数算出 offset（server_time − client_time − rtt/2），
// 这里只负责缓存这个 offset，并在下单前按需刷新。失败时静默保持 0（等于不校正），
// 绝不能因为时钟接口挂了而阻塞下单。
// =============================================================================

/** 服务器时间 − 本机时间（毫秒）。正值 = 本机偏慢，需要往前补。 */
let offsetMs = 0;
/** 上一次成功取到 offset 的时刻（本机时间）。 */
let syncedAt = 0;
/** 进行中的同步请求，避免并发重复打接口。 */
let inflight: Promise<void> | null = null;

/** 默认 5 分钟内复用上次结果（Sequencer 时钟漂移很慢，没必要每单都测）。 */
const DEFAULT_MAX_AGE_MS = 5 * 60_000;

/** 校正后的「服务器此刻」毫秒时间戳。拿不到 offset 时退化为本机时间。 */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** 当前生效的偏移量（毫秒），供诊断展示用。 */
export function currentClockOffsetMs(): number {
  return offsetMs;
}

/**
 * 确保 offset 是新鲜的；超过 maxAgeMs 则重新测一次。
 * 网络/接口失败一律吞掉（保持上一次的 offset，首次失败则保持 0），不抛出。
 */
export async function ensureClockOffset(maxAgeMs: number = DEFAULT_MAX_AGE_MS): Promise<void> {
  if (syncedAt !== 0 && Date.now() - syncedAt < maxAgeMs) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/nado/clock", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { offsetMs?: number };
      if (typeof j.offsetMs === "number" && Number.isFinite(j.offsetMs)) {
        offsetMs = j.offsetMs;
        syncedAt = Date.now();
      }
    } catch {
      // 测不到就用当前值（首次为 0）：宁可不校正，也不能拖住下单
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
