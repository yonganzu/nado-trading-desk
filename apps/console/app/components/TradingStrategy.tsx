"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Text, cn } from "@cloudflare/kumo";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import type { WalletVM } from "@farm/ui";
import type { Market } from "@farm/adapter-api";
import { setWalletCohort } from "../lib/custody";
import { useManualPairs } from "../lib/pairing";
import { runContinuous } from "../lib/automation";
import { MIN_LEVERAGE, MIN_SPREAD_TICKS } from "../lib/tradingRules";
import { getLiveConfig } from "../lib/liveConfig";
import { watchSpreads } from "../lib/marketSpreads";
import { marketTouchLive } from "../lib/liveContext";
import { shuffle } from "../lib/rand";
import { useNetwork } from "./NetworkProvider";
import { automationProgress } from "../lib/automationProgress";
import { readPref, writePref } from "../lib/prefs";
// 模式固定为「自成交平仓」，库存阈值输入已下线（引擎侧默认值仍在 inventoryWatch 里）
import { ConfirmDialog } from "./ConfirmDialog";

/** The trade symbol from a market id — the part after the ":" (e.g. "nado:perp:BTC-PERP" → "BTC-PERP"). */
const symbolOf = (id: string) => id.split(":").pop() ?? id;

/** 只交易支持 ≥20x 杠杆的标的（常量在 tradingRules，与 Market 列表的点差过滤共用同一份规则）。 */

/** 轮次输入是否合法：空串或 ≥0 的整数（0 代表不设上限，一直跑到 Pause）。 */
const isValidRounds = (v: string): boolean => {
  const t = v.trim();
  if (t === "") return true;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0;
};

/** The sidebar Trading-strategy controls: the min–max per-pair volume, the market picker, the "Cohort"
 *  pre-step (random 50/50 split of un-cohorted wallets into maker/taker), and the Run/Pause toggle that
 *  runs continuous self-cross rounds over the split cohort. Cohort first, then run. On mainnet a run goes
 *  through a per-run typed-RUN confirm; per-wallet/cohort caps bound the spend; live metrics + the
 *  CohortFilmstrip's draining queue track the run as it goes. */
export function TradingStrategy({ wallets, markets, onWalletChanged, onRefreshBalances, isLive = false }: {
  wallets: WalletVM[];
  markets: Market[];
  onWalletChanged?: () => void;
  onRefreshBalances?: (walletIds: string[]) => Promise<void> | void; // 选中组后按需读取组内钱包余额
  isLive?: boolean;
}) {
  // 单笔名义额区间：上次输入的数字记在本地，下次打开页面直接回填（例如 100–105）
  const [minVol, setMinVol] = useState("100");
  const [maxVol, setMaxVol] = useState("500");
  const [market, setMarket] = useState<string>("");
  // Market 单框搜索：输入框里直接打字，下面自动弹出匹配的交易对；选中后输入框显示符号
  const [marketText, setMarketText] = useState("");
  const [marketListOpen, setMarketListOpen] = useState(false);
  // run automation 的轮次：0 或空表示一直跑到 Pause
  const [rounds, setRounds] = useState("0");
  // 收尾方式固定为「平仓自成交」：面板不再提供模式切换（逐对平仓 / 净额对冲的实现留在引擎里）。
  // 本地偏好（区间数字 / 展开状态）是否已恢复：恢复前不回写，避免默认值盖掉已保存的值
  const [prefsReady, setPrefsReady] = useState(false);
  const [busy, setBusy] = useState(false);     // the Cohort split is in flight
  const [running, setRunning] = useState(false); // a round is in flight
  const [log, setLog] = useState<string[]>([]);
  const [metrics, setMetrics] = useState({ pairs: 0, perSec: 0, p99: 0 });
  const [confirmOpen, setConfirmOpen] = useState(false); // the mainnet type-RUN confirm
  const { chainId, net } = useNetwork();
  const abortRef = useRef<AbortController | null>(null); // the in-flight continuous loop, so Pause can stop it
  const latRef = useRef<number[]>([]);     // recent per-pair latencies (ms), for p99
  const timesRef = useRef<number[]>([]);   // traded-pair timestamps in the last window, for pairs/sec
  const startedAtRef = useRef(0);          // run start, so pairs/sec divides by elapsed (not a fixed 10s)

  // 点差检查结果（marketId → 是否够打自成交）。null = 还没拉回来，此时不筛，避免打开页面先把列表清空。
  const [spreadOk, setSpreadOk] = useState<Record<string, boolean> | null>(null);

  // Keep a valid market selected as the live market list arrives. Default to BTC-PERP by its EXACT symbol
  // (the part after the ":", same as the option label) — `endsWith("BTC-PERP")` would also catch
  // KBTC-PERP / WBTC-PERP and silently land on whichever appears first.
  const tradeMarkets = useMemo(() => {
    // 只保留支持 20x 及以上杠杆的标的：3x 这类保证金要求太高，一开单就会被 sequencer 2006 拒掉。
    // 离线 mock 的 markets 没有杠杆信息时不过滤，避免把列表清空。
    if (!markets.some((m) => typeof m.maxLeverage === "number")) return markets;
    const lev = markets.filter((m) => (m.maxLeverage ?? 0) >= MIN_LEVERAGE);
    // 打开面板时排除「点差不足」的标的：点差 < 3 tick 时 maker 挂进去没余量，2–3s 的提交延迟里
    // 很容易被吃的跨价（sequencer 2008）。读不到点差的标的（spreadOk 里没有）保留，宁可多列也不误删。
    if (!spreadOk) return lev;
    return lev.filter((m) => spreadOk[m.id] !== false);
  }, [markets, spreadOk]);

  // 被点差过滤掉的数量：只用于给用户一句提示（不影响可选列表本身）
  const spreadExcluded = useMemo(() => {
    if (!spreadOk) return 0;
    return markets.filter((m) => spreadOk[m.id] === false && (m.maxLeverage ?? 0) >= MIN_LEVERAGE).length;
  }, [markets, spreadOk]);

  // 点差检测：订阅 sequencer 的 all_bbo 全市场快照（约 300ms 一帧，完全不消耗 REST 配额），
  // 据此算出每个标的买一卖一相隔几个 tick。不逐标的查盘口：REST 限速按出口 IP 共享，
  // 一轮十几只标的就会触发长时间 429。结论只在变化时才会回调（见 lib/marketSpreads）。
  useEffect(() => {
    if (!isLive) return;
    let cancelled = false;
    let handle: { close: () => void } | null = null;
    getLiveConfig()
      .then((cfg) => {
        if (cancelled || !cfg.enabled || !cfg.wsSubscribeUrl) return;
        // 只盯永续合约：现货不参与自成交；tickSize 用于把价格差换算成 tick 档位
        const products = (cfg.products ?? [])
          .filter((p) => p.kind === "perp" && Number.isFinite(p.productId))
          .map((p) => ({ marketId: p.marketId, productId: p.productId, tickSize: String(p.tickSize) }));
        handle = watchSpreads({
          url: cfg.wsSubscribeUrl,
          products,
          minTicks: MIN_SPREAD_TICKS,
          onChanged: (ok) => { if (!cancelled) setSpreadOk(ok); },
        });
      })
      .catch(() => { if (!cancelled) setSpreadOk({}); }); // 读不到配置：不筛（空表等价于全保留）
    return () => { cancelled = true; handle?.close(); };
  }, [isLive, chainId]);

  useEffect(() => {
    if (tradeMarkets.length && !tradeMarkets.some((m) => m.id === market)) {
      const pick = tradeMarkets.find((m) => symbolOf(m.id) === "BTC-PERP") ?? tradeMarkets[0]!;
      setMarket(pick.id);
      setMarketText(symbolOf(pick.id));
    }
  }, [tradeMarkets]); // eslint-disable-line react-hooks/exhaustive-deps

  // 交易对搜索：按符号（BTC-PERP）或市场 id（nado:perp:BTC-PERP）做不区分大小写的包含匹配；
  // 输入框里正好显示当前交易对的符号时视作「没在搜索」，直接列出全部
  const filteredMarkets = useMemo(() => {
    const q = marketText.trim().toLowerCase();
    if (!q || q === symbolOf(market).toLowerCase()) return tradeMarkets;
    return tradeMarkets.filter((m) => symbolOf(m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  }, [tradeMarkets, marketText, market]);

  // 首次挂载后从本地恢复上次的输入（放在 effect 里，避免 SSR 与首屏渲染不一致）
  useEffect(() => {
    const min = readPref("vol.min");
    if (min !== null) setMinVol(min);
    const max = readPref("vol.max");
    if (max !== null) setMaxVol(max);
    const r = readPref("rounds");
    if (r !== null) setRounds(r);
    // 上次选中的标的也一起恢复（marketText 同步回填，否则首屏搜索框是空的）。
    // 若这个标的已被点差过滤掉，下面的自动选标的逻辑会退回到 BTC-PERP。
    const mk = readPref("market");
    if (mk) { setMarket(mk); setMarketText(symbolOf(mk)); }
    setPrefsReady(true);
  }, []);

  // 把「区间数字 / 轮次 / 标的」落到本地，下次打开页面自动恢复
  useEffect(() => { if (prefsReady) writePref("vol.min", minVol); }, [minVol, prefsReady]);
  useEffect(() => { if (prefsReady) writePref("vol.max", maxVol); }, [maxVol, prefsReady]);
  useEffect(() => { if (prefsReady) writePref("rounds", rounds); }, [rounds, prefsReady]);
  // market 为空表示还没选（首屏），不写，避免把已保存的值盖成空串
  useEffect(() => { if (prefsReady && market) writePref("market", market); }, [market, prefsReady]);

  // Stop an in-flight run if the panel unmounts (e.g. a future navigation), so no orphaned loop keeps
  // placing and the shared progress store doesn't stay stuck "running".
  useEffect(() => () => abortRef.current?.abort(), []);

  // 每条日志带上本地时间戳（HH:mm:ss.SSS），方便把「报错时间」和「成交时间」对上；
  // 同时异步落盘到服务端（.data/automation.log），刷新页面后仍可事后排查。
  // 面板里的日志框只留摘要（第几轮 + 本轮盈亏 + 停止原因），逐对的明细仍然全量写进文件日志。
  const PANEL_ONLY = /^▶ round \d+|^■ |^⚖ |^⇄ /;
  const append = (m: string) => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    const line = `${hh}:${mm}:${ss}.${ms} ${m}`;
    if (PANEL_ONLY.test(m)) setLog((l) => [line, ...l].slice(0, 40));
    void fetch("/api/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: [line] }),
    }).catch(() => { /* 日志落盘失败不影响交易 */ });
  };

  // Fold one traded pair into the live metrics: a rolling 10s window for pairs/sec and the last 200
  // latencies for p99. Cheap enough to run per pair (pairs are network-paced, not a tight loop).
  const recordPair = (ms: number) => {
    const now = Date.now();
    const lat = latRef.current; lat.push(ms); if (lat.length > 200) lat.shift();
    const times = timesRef.current; times.push(now);
    const cutoff = now - 10_000; while (times.length && times[0]! < cutoff) times.shift();
    const sorted = [...lat].sort((a, b) => a - b);
    const p99 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)]! : 0;
    // Divide by the elapsed window (capped at 10s) so the rate isn't understated while the window fills.
    const windowSec = Math.min(10, Math.max((now - startedAtRef.current) / 1000, 0.001));
    setMetrics((prev) => ({ pairs: prev.pairs + 1, perSec: times.length / windowSec, p99 }));
  };

  // 参与配对的钱包 = 右侧钱包卡片上手动勾选的那些（Sidebar 只把勾选的传进来）。
  // 两两配对只用「已经由 Cohort 按钮分好角色」的钱包：未分组的钱包不再自动轮流补齐，
  // 必须先勾选钱包、点 Cohort 分成 maker / taker，才会进入配对。
  const pool = wallets;
  const pickRoles = () => ({
    pool,
    makers: pool.filter((w) => w.cohort === "maker"),
    takers: pool.filter((w) => w.cohort === "taker"),
  });
  const { makers: groupMakers, takers: groupTakers } = pickRoles();
  const makerCount = groupMakers.length;
  const takerCount = groupTakers.length;

  // 勾选变化后自动读取这组钱包的余额：id 拼成稳定键（wallet 数组引用每次 live 刷新都会变，
  // 不能用它做依赖，否则会自己触发自己反复读取）；连续勾选用 300ms 防抖合并成一次。
  const [fetchingBalances, setFetchingBalances] = useState(false);
  const fetchSeq = useRef(0);
  const groupKey = pool.map((w) => w.id).join(",");
  useEffect(() => {
    if (!isLive || !onRefreshBalances || !groupKey) return;
    const ids = groupKey.split(",");
    const seq = ++fetchSeq.current;
    const timer = setTimeout(() => {
      setFetchingBalances(true);
      Promise.resolve(onRefreshBalances(ids))
        .catch(() => {})
        .finally(() => { if (seq === fetchSeq.current) setFetchingBalances(false); });
    }, 300);
    return () => clearTimeout(timer);
  }, [groupKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 当前品种的盘口点差：自成交要求「最优买卖之间有 ≥2 tick」，点差太窄会整轮跳过。
  // 切换品种或换钱包时自动读一次盘口，提前告诉用户这个品种能不能自成交。
  const [spread, setSpread] = useState<{ ticks: number; empty: boolean; bid: number; ask: number; failed?: boolean } | null>(null);
  const probeWalletId = pool[0]?.id;
  useEffect(() => {
    if (!isLive || !market || !probeWalletId) { setSpread(null); return; }
    let cancelled = false;
    marketTouchLive(probeWalletId, market)
      .then((t) => {
        if (cancelled || !t) return;
        const empty = !(t.bid > 0) || !(t.ask > 0);
        setSpread({ empty, bid: t.bid, ask: t.ask, ticks: empty || t.tick <= 0 ? 0 : Math.round((t.ask - t.bid) / t.tick), failed: !!t.failed });
      })
      .catch(() => { if (!cancelled) setSpread(null); });
    return () => { cancelled = true; };
  }, [market, probeWalletId, isLive]);

  // The Cohort pre-step: BALANCE the selected group so maker / taker counts match (odd count → differ by 1).
  // 与旧逻辑的区别：不再只切「未分组」的钱包，而是把两边数量拉平 —— 已有角色尽量保留，只把超出的一半
  // 挪到另一边（不够时从未分组里补），所以反复点击可以修正 6M/2T 这类偏斜；已经完全平衡时什么都不写。
  // Writes are sequential — each setWalletCohort read-modify-writes the shared vault tag store, so parallel
  // would race. If a write fails mid-loop we report how many actually landed and still repaint.
  const runCohortSplit = async () => {
    const total = wallets.length;
    if (total < 2) {
      append(total ? "Only 1 wallet selected — need ≥2 to form a maker/taker pair." : "Select wallets first, then re-run Cohort.");
      return;
    }
    const half = Math.floor(total / 2);
    // 奇数时多出来的那一个随机给一边，避免每次都偏向 maker
    const targetM = half + (total % 2 && Math.random() < 0.5 ? 1 : 0);
    const targetT = total - targetM;

    const curM = shuffle(wallets.filter((w) => w.cohort === "maker"));
    const curT = shuffle(wallets.filter((w) => w.cohort === "taker"));
    const keepM = curM.slice(0, targetM);   // 保留原角色的部分（不产生写操作）
    const keepT = curT.slice(0, targetT);
    // 需要重新分配角色的：两边超出的部分 + 尚未分组的
    const spare = shuffle([
      ...curM.slice(targetM),
      ...curT.slice(targetT),
      ...wallets.filter((w) => !w.cohort),
    ]);
    const plan: Array<{ w: (typeof wallets)[number]; cohort: "maker" | "taker" }> = [];
    let needM = targetM - keepM.length;
    let needT = targetT - keepT.length;
    for (const w of spare) {
      if (needM > 0) { plan.push({ w, cohort: "maker" }); needM--; }
      else if (needT > 0) { plan.push({ w, cohort: "taker" }); needT--; }
      else break;
    }
    if (plan.length === 0) {
      // 完全平衡（或只差 1 个、且多出来的已经在某一侧）时不做任何写操作，按真实数量回报
      append(`✓ already balanced：${curM.length} maker / ${curT.length} taker，无需调整。`);
      return;
    }
    setBusy(true);
    let done = 0;
    let toMaker = 0;
    try {
      for (const step of plan) {
        await setWalletCohort(step.w.id, step.cohort);
        done++;
        if (step.cohort === "maker") toMaker++;
      }
      append(`✓ balanced ${plan.length} wallet(s) → ${keepM.length + toMaker} maker / ${keepT.length + (done - toMaker)} taker`);
    } catch (e) {
      append(`✗ balance stopped at ${done}/${plan.length} (kept ${keepM.length}M / ${keepT.length}T) — re-run to finish: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      onWalletChanged?.();
    }
  };

  // 右侧配对板里手动指定的 [maker, taker]（存的是 walletId，这里换回 WalletVM）。
  // 某一侧的钱包被删掉/换网络后会对不上，直接丢掉这一对，不影响其它配对。
  const manualPairs = useManualPairs();
  const pinned = useMemo(() => {
    const byId = new Map(wallets.map((w) => [w.id, w]));
    return manualPairs
      .map((p) => [byId.get(p.makerId), byId.get(p.takerId)] as const)
      .filter((p): p is readonly [WalletVM, WalletVM] => Boolean(p[0] && p[1]));
  }, [manualPairs, wallets]);

  // The Run/Pause toggle. A click while a run is in flight pauses it; otherwise we validate and then,
  // on testnet, start immediately — on mainnet, open the typed-RUN confirm first.
  // Validate the run inputs. Used before opening the mainnet dialog AND again at start, so an edit to the
  // volume fields while the dialog is open can't slip past the range / per-order-cap checks.
  const validateRun = (): string | null => {
    const min = Number(minVol);
    const max = Number(maxVol);
    if (!(min > 0) || !(max >= min)) return `✗ volume range invalid — need 0 < min ≤ max (got ${minVol}–${maxVol}).`;
    // 单笔名义额上限是全局风控设置（与选哪个品种无关），default 主网 150 / 测试网更大；
    // 想放大就改 NEXT_PUBLIC_NADO_MAX_ORDER_NOTIONAL_USDT0 后重启
    if (max > net.caps.orderNotionalUsdt0) return `✗ max volume ${max} exceeds the per-order cap ${net.caps.orderNotionalUsdt0} USDT0（全局上限，可用 NEXT_PUBLIC_NADO_MAX_ORDER_NOTIONAL_USDT0 调高后重启）。`;
    if (!market) return "✗ pick a market first.";
    if (!isValidRounds(rounds)) return `✗ rounds invalid — 需要 ≥0 的整数（0 = 不停），当前是 ${rounds}。`;
    if (makerCount === 0 || takerCount === 0) {
      return pinned.length > 0
        ? `✗ 已配对的 ${pinned.length} 对里有钱包不在当前勾选/分组里——重新在右侧配对板确认一下。`
        : "✗ 先分组：在右侧配对板给钱包指定「挂单 / 吃单」（或点 Cohort 随机分组），至少各一个。";
    }
    return null;
  };

  const toggleAutomation = () => {
    // Pause/guard on the ref (set synchronously), NOT `running` (a frame late) — so a fast double-click
    // can't start a second loop, and a click while a loop runs always pauses it.
    if (abortRef.current) { abortRef.current.abort(); return; }
    const err = validateRun();
    if (err) { append(err); return; }
    if (net.isTestnet) void startRun(false);
    else setConfirmOpen(true); // mainnet → type RUN first
  };

  // The actual run: fresh metrics + a fresh filmstrip queue, then continuous rounds until Pause aborts the
  // loop. mainnetConfirmed is true only when it arrives from the typed-RUN confirm; the engine flattens
  // every pair, so a pause leaves the cohort flat, and each round re-rolls the side.
  const startRun = async (mainnetConfirmed: boolean) => {
    if (abortRef.current) return;     // a run is already in flight (guards a double-fired confirm click)
    const err = validateRun();
    if (err) { append(err); return; } // re-validate: the inputs may have changed while the dialog was open
    const min = Number(minVol);
    const max = Number(maxVol);
    const { makers, takers } = pinned.length > 0
      ? { makers: pinned.map(([m]) => m), takers: pinned.map(([, t]) => t) } // 手动配对：只跑这批钱包
      : pickRoles();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    latRef.current = []; timesRef.current = []; startedAtRef.current = Date.now();
    setMetrics({ pairs: 0, perSec: 0, p99: 0 });
    const pairLabel = pinned.length > 0 ? `${pinned.length} 对（手动配对）` : `${Math.min(makers.length, takers.length)} pair(s)/round`;
    append(`▶ start — ${pairLabel} @ ${symbolOf(market)}${mainnetConfirmed ? " · MAINNET" : ""}`);
    try {
      await runContinuous(makers, takers, { market, minNotional: min, maxNotional: max, mainnetConfirmed, maxRounds: Number(rounds) || 0, manualPairs: pinned, mode: "selfCross" }, {
        log: append,
        signal: ctrl.signal,
        onRoundStart: () => automationProgress.roundStart(),
        onPairStart: (pair) => automationProgress.pairStart(pair),
        onPairEnd: (pair, outcome, ms) => { automationProgress.pairEnd(pair); if (outcome === "traded") recordPair(ms); },
        // 开跑前的余额检查若换了角色，立刻刷新钱包列表，maker/taker 标签即时更新
        onRolesChanged: () => onWalletChanged?.(),
      });
    } catch (e) {
      append(`✗ automation error: ${(e as Error).message}`);
    } finally {
      setRunning(false);
      abortRef.current = null;
      automationProgress.stop();
      onWalletChanged?.();
    }
  };

  if (!isLive) return <Text variant="secondary" size="xs">Unlock a live cohort to run a trading strategy.</Text>;

  return (
    <div className="flex flex-col gap-3">
      {/* 栏目说明：面板标题已是「自成交平仓」，这里说明它的含义（原来的模式按钮已删掉，
          逐对平仓 / 净额对冲的实现仍保留在 automation.ts 里，随时可以放回来）。 */}
      <Text variant="secondary" size="xs">
        自成交平仓：平仓两条腿也互相对敲（上一轮的吃单方挂单、挂单方去吃），不跨点差、自成交量翻倍；挂单被抢或没吃到时自动回退市价平仓。
      </Text>

      {/* Point 1 — the per-pair volume range (each pair draws a random USDT0 notional in [min, max]). */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Volume / pair (USDT0)</span>
        <div className="flex items-center gap-2">
          <Input size="sm" aria-label="Min volume per pair" className="min-w-0 flex-1" value={minVol} onChange={(e) => setMinVol(e.target.value)} />
          <span className="shrink-0 text-kumo-subtle">–</span>
          <Input size="sm" aria-label="Max volume per pair" className="min-w-0 flex-1" value={maxVol} onChange={(e) => setMaxVol(e.target.value)} />
        </div>
      </div>

      {/* Market：一个输入框搞定。点进去直接打字，下面自动弹出匹配的交易对；选中后框里显示符号。 */}
      <div className="relative flex flex-col gap-1.5">
        <span className="text-sm font-medium">Market</span>
        <Input
          size="sm"
          type="text"
          placeholder="输入交易对，如 BTC / TSLA"
          aria-label="搜索并选择交易对"
          aria-expanded={marketListOpen}
          role="combobox"
          value={marketText}
          onFocus={(e) => { setMarketListOpen(true); e.currentTarget.select(); }}
          onChange={(e) => { setMarketText(e.target.value); setMarketListOpen(true); }}
          onBlur={() => {
            setMarketListOpen(false);
            // 没选中就失焦时，把框恢复成当前交易对的符号，避免留下一段无效文字
            setMarketText(market ? symbolOf(market) : "");
          }}
          onKeyDown={(e) => { if (e.key === "Escape") setMarketListOpen(false); }}
        />
        {spreadOk === null && (
          <span className="text-xs text-kumo-subtle">正在检测各标的点差…</span>
        )}
        {spreadExcluded > 0 && (
          <span className="text-xs text-kumo-subtle">已自动排除 {spreadExcluded} 个点差不足 {MIN_SPREAD_TICKS} tick 的标的</span>
        )}
        {marketListOpen && (
          <div className="absolute top-full left-0 z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-kumo-line bg-kumo-base shadow-lg">
            {filteredMarkets.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-kumo-subtle">
                {tradeMarkets.length === 0
                  ? spreadExcluded > 0 ? `当前没有点差 ≥${MIN_SPREAD_TICKS} tick 的标的，稍后再试` : `没有支持 ${MIN_LEVERAGE}x 及以上杠杆的标的`
                  : "没有匹配的交易对"}
              </div>
            ) : (
              filteredMarkets.map((mk) => {
                const on = mk.id === market;
                return (
                  <button
                    key={mk.id}
                    type="button"
                    aria-pressed={on}
                    // mousedown 阻止默认行为，避免 input 先失焦导致列表在点击生效前被收起
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setMarket(mk.id);
                      setMarketText(symbolOf(mk.id));
                      setMarketListOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs",
                      on ? "bg-kumo-brand/15 font-medium text-kumo-default" : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default",
                    )}
                  >
                    <span className="truncate">{symbolOf(mk.id)}</span>
                    <span className="shrink-0 text-kumo-inactive">
                      {typeof mk.maxLeverage === "number" ? `x${mk.maxLeverage}` : null}
                      {on ? <span className="ml-2">selected</span> : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
      {/* 盘口点差预览：自成交需要 ≥2 tick 的中间价，点差 1 tick 时会整轮跳过 */}
      {spread && (
        <Text variant="secondary" size="xs">
          {spread.failed
            ? `${symbolOf(market)}：读盘口失败（可能是限速），稍后重试`
            : spread.empty
            ? `${symbolOf(market)}：盘口为空或单边，无法自成交`
            : `${symbolOf(market)}：当前点差 ${spread.ticks} tick（bid ${spread.bid} / ask ${spread.ask}）· ${spread.ticks >= 2 ? "可以自成交" : "太窄，请换品种"}`}
        </Text>
      )}

      {/* 参与配对的钱包来自右侧钱包卡片的勾选（Shift 可连选）；分组与手动配对在右侧顶部的配对板 */}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">已选 {pool.length} 个钱包 · {makerCount} maker / {takerCount} taker</span>
        {pinned.length > 0 ? (
          <Text variant="secondary" size="xs">按右侧配对板的 {pinned.length} 对逐一开打。</Text>
        ) : pool.length === 0 ? (
          <Text variant="secondary" size="xs">在右侧钱包卡片左上角打勾选择参与配对的钱包（Shift + 点选可连续选中），再到右侧「挂单 / 吃单」配对板指定角色。</Text>
        ) : (
          <Text variant="secondary" size="xs">配对只在勾选的钱包里进行；先在右侧配对板指定挂单 / 吃单（或点 Cohort 自动分组），再 Run。</Text>
        )}
        {fetchingBalances && <Text variant="secondary" size="xs">读取已选钱包余额中…</Text>}
      </div>

      {/* Step 1 — the Cohort pre-step. Explicitly the prerequisite to Run automation. */}
      <div className="flex flex-col gap-1">
        <Button size="sm" variant="secondary" loading={busy} onClick={runCohortSplit}>
          Cohort · {makerCount}M / {takerCount}T
        </Button>
        <Text variant="secondary" size="xs">Step 1 — 把已选钱包平衡成 maker / taker 数量相等（奇数时差 1）；已有分组尽量保留，可反复点。</Text>
        {/* 手动指定角色 / 配对已迁到右侧钱包栏顶部的「挂单 / 吃单」配对板 */}
      </div>

      {/* Point 4 — the Run/Pause toggle: continuous self-cross rounds over the split cohort. Idle shows a
          play icon in the brand fill; running shows a pause icon in the neutral fill. Disabled until a
          cohort exists; on mainnet it opens a typed-RUN confirm before starting. Stays clickable WHILE
          running so it can pause. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Button className="min-w-0 flex-1" size="sm" variant={running ? "secondary" : "primary"} icon={running ? PauseIcon : PlayIcon} disabled={!running && (makerCount === 0 || takerCount === 0)} onClick={toggleAutomation}>
            {running ? "Pause automation" : "Run automation"}
          </Button>
          {/* 轮次输入：放在 Run 右边同一行；0 或留空 = 一直跑到 Pause */}
          <Input
            size="sm"
            type="number"
            min={0}
            step={1}
            placeholder="0=∞"
            title="轮次：0 或留空 = 一直跑到 Pause"
            aria-label="自动化轮次"
            className="w-20 shrink-0"
            value={rounds}
            onChange={(e) => setRounds(e.target.value)}
          />
        </div>
        <Text variant="secondary" size="xs">Rounds（右侧）：0 或留空 = 一直跑到 Pause。</Text>
        {!net.isTestnet && <Text variant="secondary" size="xs">Mainnet — type RUN to confirm each run · caps {Number.isFinite(net.caps.walletUsdt0) ? net.caps.walletUsdt0 : "∞"}/wallet, {Number.isFinite(net.caps.cohortUsdt0) ? net.caps.cohortUsdt0 : "∞"}/cohort USDT0.</Text>}
      </div>

      {/* Log pane — per-wallet eligibility + per-pair results land here once the engine runs.
          resize-y 让用户自己拖高矮（拖右下角），默认 7rem，最高 60vh。 */}
      <div className="h-28 min-h-16 max-h-[60vh] w-full resize-y overflow-auto rounded-md bg-kumo-tint px-2 py-1.5 font-mono text-xs">
        {log.length === 0
          ? <span className="text-kumo-subtle">Automation log…</span>
          : log.map((l, i) => <div key={i} className={l.includes("✗") ? "text-kumo-danger" : l.includes("✓") ? "text-kumo-success" : "text-kumo-subtle"}>{l}</div>)}
      </div>

      {/* Live metrics for the current run. "Pairs/s" is submission throughput — a traded pair = maker
          rest + taker IOC both accepted; WS-confirmed fills/sec is a live-testnet reading. "p99 ms" is the
          per-pair cycle (place → flatten) over the last 200 pairs. */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div><div className="text-kumo-subtle">Pairs</div><div className="tabular-nums" data-testid="metric-pairs">{metrics.pairs}</div></div>
        <div><div className="text-kumo-subtle">Pairs/s</div><div className="tabular-nums">{metrics.perSec ? metrics.perSec.toFixed(1) : "—"}</div></div>
        <div><div className="text-kumo-subtle">p99 ms</div><div className="tabular-nums">{metrics.p99 ? Math.round(metrics.p99) : "—"}</div></div>
      </div>

      {/* Mainnet per-run confirm — a click on Run off testnet opens this; typing RUN starts the run with
          mainnetConfirmed. Kept mounted, driven by `open` (Kumo dialog rule). */}
      <ConfirmDialog
        open={confirmOpen}
        title="Run automation on MAINNET?"
        danger={<>Live orders on Ink mainnet move <strong className="font-medium text-kumo-default">real USDT0</strong>. Caps: {Number.isFinite(net.caps.orderNotionalUsdt0) ? net.caps.orderNotionalUsdt0 : "∞"}/order · {Number.isFinite(net.caps.walletUsdt0) ? net.caps.walletUsdt0 : "∞"}/wallet · {Number.isFinite(net.caps.cohortUsdt0) ? net.caps.cohortUsdt0 : "∞"}/cohort.</>}
        body={<>Each pair self-crosses at the spread mid and flattens; the run continues until you pause.</>}
        confirmWord="RUN"
        onConfirm={() => { setConfirmOpen(false); void startRun(true); }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
