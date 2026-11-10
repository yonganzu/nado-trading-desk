"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Empty, Input, LinkButton, Sidebar as KumoSidebar, Text, Tooltip } from "@cloudflare/kumo";
import { FunnelIcon, ReceiptIcon, UsersThreeIcon, WalletIcon } from "@phosphor-icons/react";
import { filterWallets, accountOptions, cohortsOf } from "@farm/ui";
import type { WalletVM, Fleet } from "@farm/ui";
import { Sidebar } from "./components/Sidebar";
import { WalletGrid } from "./components/WalletGrid";
import { WalletDrawer } from "./components/WalletDrawer";
import { CohortFilmstrip } from "./components/CohortFilmstrip";
import { CohortPairBoard } from "./components/CohortPairBoard";
import { AccountingView } from "./components/AccountingView";
import { useNetwork } from "./components/NetworkProvider";
import { fetchLiveState, reconcileWallet, reconcileBalances, mergeWallet, mergeLiveReads, liveWalletVMs, isLiveWallet } from "./lib/live";
import { readBudget, forceRefreshNative, TREASURY_WALLET_ID, beginPriorityReads, endPriorityReads, priorityReadsActive } from "./lib/liveContext";
import { readPrefJson, writePrefJson } from "./lib/prefs";
import { openOrderUpdateStream } from "./lib/orderUpdateStream";
import { checkWalletRegistration, loadStoredChecks, readStoredCheck } from "./lib/walletCheck";
import type { WalletCheckState } from "./lib/walletCheck";
import { openWalletOnNado } from "./lib/nadoOpen";
import type { NadoOpenState } from "./lib/nadoOpen";
import { applyStoredStates } from "./lib/nadoRegistryModel";
import type { LiveState } from "./lib/live";
import { openLiveStream } from "./lib/liveStream";
import type { LiveEvent } from "./lib/liveStream";
import { accountingLedger } from "./lib/accountingLedger";

export default function Page() {
  const { chainId, net } = useNetwork(); // selected network: drives labels + the reconnect-on-switch
  // The fleet is the REAL in-tab cohort only (no mock): the home page shows the unlocked vault's
  // accounts and their wallets, grouped by account in the sidebar filter.
  const [live, setLive] = useState<LiveState>({ enabled: false });
  // 左侧栏是否展开：收起后只留一条窄边和展开按钮，把横向空间让给主区域
  const [railOpen, setRailOpen] = useState(true);
  // 左侧栏宽度（px）：可以拖右边框调整，最大到画面宽度的 2/3，最小 220px
  const [railWidth, setRailWidth] = useState(320);
  const RAIL_MIN_WIDTH = 220;
  const railMaxWidth = () => (typeof window === "undefined" ? 1200 : Math.round(window.innerWidth * 2 / 3));
  const railDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onRailResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    railDragRef.current = { startX: e.clientX, startWidth: railWidth };
    const onMove = (ev: PointerEvent) => {
      const drag = railDragRef.current;
      if (!drag) return;
      const next = Math.min(Math.max(RAIL_MIN_WIDTH, drag.startWidth + (ev.clientX - drag.startX)), railMaxWidth());
      setRailWidth(next);
    };
    const onUp = () => {
      railDragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  // 右侧手动勾选的钱包（左侧 Trading strategy 用它做组内两两配对，一个 maker 一个 taker）
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const pickAnchor = useRef<string | null>(null); // Shift 连选的起点（上一个点选的钱包）
  // Repopulate the live fleet IDENTITIES (keyless config + in-tab cohort; no per-wallet reads).
  // Called on mount and on cohort change (unlock/lock/import); the budget-paced sweep + the
  // WS-targeted reconcile fill in each wallet's reads afterward.
  // 注意：身份刷新不能把已经读到的余额/挂单丢掉（改 maker/taker、余额自动换角色都会走到这里），
  // 所以合并旧读数而不是整份替换 —— 否则面板上的余额会突然集体变回「—」。
  const refreshLive = useCallback(() => {
    fetchLiveState()
      .then((s) => setLive((prev) => mergeLiveReads(s, prev)))
      .catch(() => {});
  }, []);
  useEffect(() => { refreshLive(); }, [refreshLive, chainId]); // re-fetch + reconnect on a network switch

  // 按需读取一组钱包的余额（交易面板选中钱包组时触发）：逐个「只读余额」并合并回 live 状态，
  // 余额因此回填到 WalletVM，组内每个钱包的余额就能直接显示。这里走 readWalletBalances（只做 1 次
  // summary 读，不读挂单），每钱包只花 1 个令牌，比完整 reconcile 快一倍；期间用优先级标记让
  // 后台轮询让位，避免同一批钱包被读两遍。读取受 RateLimiter 限速所以串行，新的请求会接管旧的。
  const balanceSeq = useRef(0);
  const refreshWalletBalances = useCallback(async (ids: string[]) => {
    const seq = ++balanceSeq.current;
    beginPriorityReads();
    // 连续多少个钱包读到「余额为 0」；到 3 个就停止继续探测（后面的钱包大概率也是空的，省读预算）
    const ZERO_STREAK_LIMIT = 3;
    let zeroStreak = 0;
    try {
      for (const id of ids) {
        if (seq !== balanceSeq.current) return; // 已被新的组选中覆盖
        if (!isLiveWallet({ id })) continue;
        try {
          const upd = await reconcileBalances(id);
          if (seq !== balanceSeq.current) return;
          setLive((s) => mergeWallet(s, upd));
          // 只有「确实读到余额且为 0」才算一个空钱包；读不到结果的情况不算 0，继续往下检测
          const quote = upd.balances?.find((b) => b.scope === "margin");
          const total = Number(quote?.total);
          const isZero = Boolean(quote) && Number.isFinite(total) && total === 0;
          zeroStreak = isZero ? zeroStreak + 1 : 0;
          if (zeroStreak >= ZERO_STREAK_LIMIT) return; // 连续 3 个空钱包，停止继续向下检测
        } catch { zeroStreak = 0; /* 没有结果 ≠ 余额为 0：重置连击，继续检测下一个 */ }
      }
    } finally {
      endPriorityReads();
    }
  }, []);

  // Accounting 账本索引：subaccount → 钱包元信息、product_id → marketId，
  // 让公共 WS 的 fill 帧能翻译成「哪个钱包、哪个市场」的可读记录。
  useEffect(() => {
    accountingLedger.setWalletIndex(
      (live.wallets ?? [])
        .filter((w) => Boolean(w.subaccount))
        .map((w) => ({
          subaccount: w.subaccount as string,
          meta: { walletId: w.walletId, accountName: w.accountName, cohorts: w.cohort ? [w.cohort] : undefined },
        })),
    );
    accountingLedger.setMarketIndex(
      (live.products ?? [])
        .filter((p) => Number.isFinite(p.productId) && Boolean(p.marketId))
        .map((p) => ({ productId: p.productId, market: p.marketId })),
    );
  }, [live.wallets, live.products]);

  // Browser-side WS: the public `fill` stream for EVERY cohort subaccount (no key) routes a
  // targeted per-wallet reconcile; a budget-paced round-robin sweep keeps the idle bulk fresh
  // within the per-IP read budget. (order_update is auth-gated — a working-set enhancement, W5.)
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [wsOpen, setWsOpen] = useState(false);
  const subKey = (live.wallets ?? []).map((w) => w.subaccount).filter(Boolean).join(",");
  useEffect(() => {
    if (!live.enabled || !live.wsSubscribeUrl || !subKey) return;
    // subaccount → walletId: a public fill/position_change names its subaccount, so it
    // reconciles ONLY that wallet. This replaces the old "any WS event re-reads the WHOLE
    // cohort" amplifier (2N reads per event) that collapsed the live ceiling below ~20 under
    // any trading activity — read cost is now O(active wallets), not O(cohort).
    // Key lowercased on BOTH sides so a casing difference in the sequencer's echoed subaccount
    // can't silently miss the fast path (subaccountToHex is lowercase; a bytes32 is never
    // EIP-55-checksummed, but normalize defensively). The budget-paced sweep below backstops any residual.
    let stopped = false; // one teardown gate shared by both async paths (targeted + sweep)
    const subToWallet = new Map<string, string>();
    for (const w of live.wallets ?? []) if (w.subaccount) subToWallet.set(w.subaccount.toLowerCase(), w.walletId);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const reconcile = (walletId: string): void => {
      const prev = timers.get(walletId);
      if (prev) clearTimeout(prev);
      // Coalesce a burst of fills on one wallet into a single targeted re-read.
      timers.set(walletId, setTimeout(() => {
        timers.delete(walletId);
        reconcileWallet(walletId).then((upd) => { if (!stopped) setLive((s) => mergeWallet(s, upd)); }).catch(() => {});
      }, 500));
    };
    const stream = openLiveStream({
      url: live.wsSubscribeUrl, subaccounts: subKey.split(","),
      onStatus: (s) => setWsOpen(s === "open"),
      onEvent: (e) => {
        if (e.type === "fill") accountingLedger.record(e.raw as Record<string, unknown>, e.ts);
        setLiveEvents((xs) => [e, ...xs].slice(0, 20));
        const walletId = e.subaccount ? subToWallet.get(e.subaccount.toLowerCase()) : undefined;
        if (walletId) reconcile(walletId); // targeted, not a full-cohort re-read
      },
    });
    // Budget-paced round-robin reconcile sweep — replaces the flat O(N)-every-20s poll, which
    // re-read the WHOLE cohort each tick and backlogged the limiter past ~20 wallets. It
    // reconciles ONE wallet at a time (2 metered reads each); each reconcile BLOCKS on the
    // client RateLimiter (~2/s), so the AGGREGATE read rate is bounded regardless of N and never
    // backlogs. Per-wallet freshness is ~cohort-size seconds (worst case, more under write/WS
    // contention) — graceful degradation instead of the whole cohort stalling. This is the
    // STEADY-state N-decoupler that lifts the ceiling toward ~1000; active wallets stay
    // sub-second-fresh via the WS-targeted reconcile above. (Cold-start no longer reads:
    // mount/unlock populates identities only, and the sweep fills reads lazily — first-screen
    // wallets first since it walks the cohort in order.) The sweep reserves budget headroom so
    // it can't starve interactive ops (a kill-switch cancel-all, a drawer read).
    const SWEEP_RESERVE = 3; // leave this many of the 6 burst tokens for interactive/write ops
    const cohort = live.wallets ?? [];
    let cursor = 0;
    const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    void (async () => {
      while (!stopped) {
        if (cohort.length === 0) { await nap(1000); continue; }
        if (priorityReadsActive()) { await nap(200); continue; } // 按需批量读余额期间让位，不抢同一个预算
        if (readBudget() <= SWEEP_RESERVE) { await nap(400); continue; } // yield headroom to interactive ops
        const w = cohort[cursor % cohort.length]!;
        cursor++;
        try {
          const upd = await reconcileWallet(w.walletId); // blocks on the RateLimiter inside readWalletLive
          if (!stopped) setLive((s) => mergeWallet(s, upd));
        } catch { /* transient; the next pass retries this wallet */ }
        await nap(50); // floor so a no-op limiter can't hot-loop; real pacing is the limiter
      }
    })();
    return () => { stopped = true; for (const t of timers.values()) clearTimeout(t); stream.close(); };
  }, [live.enabled, live.wsSubscribeUrl, subKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const liveWallets = useMemo(() => liveWalletVMs(live), [live]);
  // Accounting 顶部「剩余资金」：所有钱包已读到的 USDT0（margin）合计。
  // 还没读到余额的钱包不计入金额，只用 known / total 标明覆盖情况。
  const walletBalance = useMemo(() => {
    const list = live.wallets ?? [];
    let sum = 0;
    let known = 0;
    for (const w of list) {
      const n = Number(w.balances?.find((b) => b.scope === "margin")?.total ?? NaN);
      if (!Number.isFinite(n)) continue;
      sum += n;
      known++;
    }
    return { sum, known, total: list.length };
  }, [live.wallets]);
  const fleet = useMemo<Fleet>(() => ({
    accounts: live.accounts ?? [],
    wallets: liveWallets,
    cohorts: cohortsOf(liveWallets),
  }), [live.accounts, liveWallets]);

  const options = useMemo(() => accountOptions(fleet.accounts), [fleet]);

  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(() => new Set());
  // 账号勾选是否已从本地恢复：恢复前不回写，避免空集合把已保存的选择覆盖掉
  const [accountsPrefReady, setAccountsPrefReady] = useState(false);
  // 地址搜索：只按开头或结尾匹配（大小写不敏感），输入 0x 前缀也能直接用
  const [search, setSearch] = useState("");
  const [drawerWallet, setDrawerWallet] = useState<WalletVM | null>(null);
  const [accountingOpen, setAccountingOpen] = useState(false);
  // 「检查 Nado 注册状态」的每钱包结果；真正的存储在服务端登记表，这里只是展示缓存
  const [checks, setChecks] = useState<Record<string, WalletCheckState>>({});
  const checkWallet = useCallback(async (w: WalletVM) => {
    setChecks((s) => ({ ...s, [w.id]: { status: "running" } }));
    // 望远镜检查：注册状态与余额并行查，余额读回来直接刷到卡片（非 live 钱包没有读接口，跳过余额）。
    const balanceTask = isLiveWallet({ id: w.id })
      ? reconcileBalances(w.id).then((upd) => setLive((s) => mergeWallet(s, upd))).catch(() => {})
      : Promise.resolve();
    const next = await checkWalletRegistration(w.accountId, w.address.value);
    setChecks((s) => ({ ...s, [w.id]: next }));
    await balanceTask;
  }, []);
  // 「一键打开 Nado 官网并登录」的每钱包状态（打开的是本机 Playwright 窗口，成功后保留一段时间）
  const [nado, setNado] = useState<Record<string, NadoOpenState>>({});
  const openNado = useCallback(async (w: WalletVM) => {
    setNado((s) => ({ ...s, [w.id]: { status: "opening" } }));
    const next = await openWalletOnNado(w.accountId, w.address.value);
    setNado((s) => ({ ...s, [w.id]: next }));
    if (next.status !== "open") return;
    // 登录成功后 worker 会顺手写登记表，这里把结果同步到「已注册」徽标
    const stored = await readStoredCheck(w.address.value);
    if (stored) {
      const state = { [w.address.value.toLowerCase()]: stored };
      setChecks((s) => applyStoredStates(s, state, [{ id: w.id, address: w.address.value }]));
    }
  }, []);
  // 页面加载 / 刷新 / 从 Accounts 页（Nado 登录区块）返回首页后，从后端登记表回填结果（按地址与钱包一一对应）。
  // 依赖地址集合的字符串而不是数组引用：首页的实时刷新会不断生成新的 wallets 数组，
  // 用数组引用做依赖会让这个请求被反复取消，导致后端已有的注册结果迟迟落不到卡片上。
  const walletAddressKey = useMemo(
    () => fleet.wallets.map((w) => w.address.value.toLowerCase()).sort().join(","),
    [fleet.wallets],
  );
  useEffect(() => {
    if (!walletAddressKey) return;
    let cancelled = false;
    const list = fleet.wallets.map((w) => ({ id: w.id, address: w.address.value }));
    void loadStoredChecks().then((stored) => {
      if (cancelled) return;
      setChecks((cur) => applyStoredStates(cur, stored, list));
    });
    return () => { cancelled = true; };
  }, [walletAddressKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Viewed-wallet priority: reconcile the OPENED live wallet immediately so the drawer shows
  // fresh state without waiting for the round-robin sweep to walk around to it.
  const drawerId = drawerWallet?.id;
  useEffect(() => {
    if (!drawerId || !isLiveWallet({ id: drawerId })) return;
    let cancelled = false;
    reconcileWallet(drawerId).then((upd) => { if (!cancelled) setLive((s) => mergeWallet(s, upd)); }).catch(() => {});
    return () => { cancelled = true; };
  }, [drawerId]);

  // Render the drawer from the CURRENT version of the opened wallet (re-derived from the live
  // fleet), so a reconcile / sweep / WS update reaches the open drawer's tiles — not just the
  // grid card behind it. Without this, the drawer shows a frozen snapshot from when it opened.
  // The reconciled LIVE wallet (openOrders[]/positions[]/subaccount) for the open drawer — the
  // detail the WalletVM flattens to counts. Drives the drawer's positions + open-orders list.
  const drawerLive = useMemo(
    () => (drawerId ? (live.wallets ?? []).find((w) => w.walletId === drawerId) : undefined),
    [drawerId, live.wallets],
  );
  const drawerVM = useMemo(
    () => (drawerWallet ? fleet.wallets.find((w) => w.id === drawerWallet.id) ?? drawerWallet : null),
    [drawerWallet, fleet.wallets],
  );

  // W5 — real-time ORDER STATE for the VIEWED wallet: open an AUTHED order_update WS (signed
  // in-tab, server keyless, direct from the browser) for the open drawer wallet ONLY — a bounded
  // working set of 1 (order_update is per-wallet/per-connection, so it can't be run cohort-wide).
  // order_update emits placed/cancelled/filled, so it is a LOW-LATENCY reconcile TRIGGER for
  // order-state changes the public fill stream wouldn't surface (placed/cancelled): on any frame
  // we coalesce a targeted reconcile so the drawer reflects it. The budget-paced sweep stays the
  // backstop (incl. if auth is rejected). subKey is a dep so a lock/unlock/re-import re-runs this.
  useEffect(() => {
    if (!drawerId || !isLiveWallet({ id: drawerId }) || !live.wsSubscribeUrl || !live.chainId || !live.endpoint) return;
    const sub = (live.wallets ?? []).find((x) => x.walletId === drawerId)?.subaccount;
    if (!sub) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const stream = openOrderUpdateStream({
      url: live.wsSubscribeUrl, walletId: drawerId, subaccount: sub, endpoint: live.endpoint, chainId: live.chainId,
      onEvent: () => {
        if (t) clearTimeout(t);
        t = setTimeout(() => { reconcileWallet(drawerId).then((upd) => { if (!stopped) setLive((s) => mergeWallet(s, upd)); }).catch(() => {}); }, 300);
      },
    });
    return () => { stopped = true; if (t) clearTimeout(t); stream.close(); };
  }, [drawerId, subKey, live.wsSubscribeUrl, live.chainId, live.endpoint]); // eslint-disable-line react-hooks/exhaustive-deps

  // Default every real account to checked as it appears (so new accounts show up without the user
  // re-checking); only ADD, so a user's explicit un-check of an existing account is preserved.
  // 「出现过」的账号 id 记在本地：下次打开页面时，上次取消勾选的账号不会被再次自动勾上，
  // 而新导入的账号仍会自动勾选。
  const knownAccounts = useRef<Set<string>>(new Set(readPrefJson<string[]>("accounts.known") ?? []));
  const accountKey = (live.accounts ?? []).map((a) => a.id).join(",");
  useEffect(() => {
    const ids = (live.accounts ?? []).map((a) => a.id);
    if (!ids.length) return;
    const fresh = ids.filter((id) => !knownAccounts.current.has(id));
    if (!fresh.length) return;
    for (const id of fresh) knownAccounts.current.add(id);
    writePrefJson("accounts.known", [...knownAccounts.current]);
    setSelectedAccounts((s) => {
      const next = new Set(s);
      for (const id of fresh) next.add(id);
      return next;
    });
  }, [accountKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 恢复上次勾选的账号（放在 effect 里，避免 SSR 与首屏渲染不一致）
  useEffect(() => {
    const saved = readPrefJson<string[]>("accounts.selected");
    if (saved) setSelectedAccounts(new Set(saved));
    setAccountsPrefReady(true);
  }, []);

  // 记住用户勾选的账号，下次打开页面直接恢复上次的选择
  useEffect(() => {
    if (accountsPrefReady) writePrefJson("accounts.selected", [...selectedAccounts]);
  }, [selectedAccounts, accountsPrefReady]);

  const shown = useMemo(() => {
    const base = filterWallets(fleet.wallets, [...selectedAccounts], []);
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter((w) => {
      const addr = w.address.value.toLowerCase();
      return addr.startsWith(q) || addr.endsWith(q);
    });
  }, [fleet, selectedAccounts, search]);

  // 勾选/取消一个钱包；按住 Shift 时按「显示顺序」从锚点连续选中（Windows 资源管理器式）
  const togglePick = useCallback((w: WalletVM, shift: boolean) => {
    const to = shown.findIndex((x) => x.id === w.id);
    const from = pickAnchor.current ? shown.findIndex((x) => x.id === pickAnchor.current) : -1;
    if (!shift || from < 0 || to < 0) pickAnchor.current = w.id;
    setPicked((prev) => {
      const next = new Set(prev);
      if (shift && from >= 0 && to >= 0) {
        const on = !prev.has(w.id); // 以当前这张卡片的现状决定这一段是选中还是取消
        const [lo, hi] = from < to ? [from, to] : [to, from];
        for (let i = lo; i <= hi; i++) {
          const id = shown[i]!.id;
          if (on) next.add(id); else next.delete(id);
        }
      } else if (next.has(w.id)) {
        next.delete(w.id);
      } else {
        next.add(w.id);
      }
      return next;
    });
  }, [shown]);

  // 全选当前显示的钱包 / 清空 / 反选（反选只针对当前显示的，被筛选隐藏的已选钱包保持不变）
  const pickAllShown = () => setPicked(new Set(shown.map((w) => w.id)));
  const pickNone = () => { pickAnchor.current = null; setPicked(new Set()); };
  const pickInvert = () => setPicked((prev) => {
    const visible = new Set(shown.map((w) => w.id));
    const next = new Set<string>();
    for (const id of prev) if (!visible.has(id)) next.add(id);
    for (const id of visible) if (!prev.has(id)) next.add(id);
    return next;
  });
  // 参与配对的钱包 = 当前显示且被勾选的（筛选变化后隐藏的钱包不会偷偷参与）
  const pickedWallets = useMemo(() => shown.filter((w) => picked.has(w.id)), [shown, picked]);
  const pickedCount = pickedWallets.length;

  // Kumo Sidebar.Provider is the app shell: collapsible="none" keeps the left rail frozen (a fixed
  // <aside>, never a mobile sheet); only <main> scrolls. Width: Kumo honours `defaultWidth` only when
  // `resizable`, otherwise it pins --sidebar-width to its 16.25rem constant — so the rail is widened
  // (16.25rem → 20rem, 320px) through that variable on the Provider.
  return (
    <KumoSidebar.Provider
      collapsible="none"
      style={{ "--sidebar-width": railOpen ? `${railWidth}px` : "3.75rem" } as React.CSSProperties}
      className="h-dvh overflow-hidden bg-kumo-canvas text-kumo-default"
    >
      <Sidebar
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((v) => !v)}
        workspaceName={live.enabled ? net.networkName : "offline"}
        totalWallets={fleet.wallets.length}
        shownWallets={shown.length}
        shown={shown}
        pickedWallets={pickedWallets}
        accountOptions={options}
        selectedAccounts={selectedAccounts}
        onAccountsChange={setSelectedAccounts}
        liveMarkets={live.markets}
        liveEnabled={live.enabled}
        liveDefaultProduct={live.defaultProduct}
        liveCohortSize={live.wallets?.length || 3}
        onLiveCohortChange={refreshLive}
        liveWallets={liveWallets}
        onWalletChanged={refreshLive}
        onRefreshBalances={refreshWalletBalances}
        onFunded={(ids) => {
          // After a bulk fund, repaint each attempted wallet + the treasury (native gas, collateral,
          // readiness) via the same force-refresh + reconcile chain used by onRefueled.
          for (const id of new Set([...ids, TREASURY_WALLET_ID])) {
            void forceRefreshNative(id)
              .then(() => reconcileWallet(id))
              .then((upd) => setLive((s) => mergeWallet(s, upd)))
              .catch(() => {});
          }
        }}
      />
      {/* 拖拽手柄：拖动调整左侧面板宽度（最小 220px，最大画面的 2/3） */}
      {railOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整左侧面板宽度"
          title="拖动调整左侧面板宽度（最大 2/3 屏宽）"
          onPointerDown={onRailResizeStart}
          className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-kumo-brand/40"
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-kumo-line bg-kumo-base px-4 py-3">
          {/* The title + status pill never shrink; the "N shown" hint on the right is the part that yields
              (truncates) when the header runs out of room, so the heading never wraps. */}
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <Text variant="heading" as="h1">All wallets</Text>
            {live.enabled && (
              // The network-accent status pill: no Kumo Badge variant fills with the brand, so it's a Badge
              // whose fill is overridden (Kumo cn) with the re-pointed brand token. Badge drops `title`, so
              // the detail moves to a Kumo Tooltip. The status string stays ONE text run (e2e contract).
              <Tooltip side="bottom" content={live.error ?? (live.locked ? `Unlock the in-tab cohort to go live on ${net.networkName}` : `${liveWallets.length} independent EOA wallet(s) live on ${net.networkName}`)}>
                <Badge variant="primary" className="bg-kumo-brand text-kumo-inverse">
                  <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-kumo-inverse" />
                  {live.locked
                    ? `LIVE ${net.networkName} · locked`
                    : `LIVE ${net.networkName} · ${liveWallets.length} EOAs${wsOpen ? " · WS live" : ""}${liveEvents.length > 0 ? ` · ${liveEvents.length} events` : ""}`}
                </Badge>
              </Tooltip>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <Input
              size="sm"
              type="search"
              placeholder="搜索地址开头 / 结尾"
              aria-label="按地址开头或结尾搜索钱包"
              className="w-52 shrink-0"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <LinkButton href="/accounts" variant="secondary" icon={UsersThreeIcon} className="shrink-0">Accounts</LinkButton>
            <Button icon={ReceiptIcon} className="shrink-0" onClick={() => setAccountingOpen(true)}>Accounting</Button>
          </div>
        </header>
        {/* 勾选工具条：在右侧手动选中参与自成交配对的钱包（左侧面板只显示汇总并据此分组） */}
        <div className="flex flex-wrap items-center gap-2 border-b border-kumo-line bg-kumo-base px-4 py-1.5">
          <span className="text-xs text-kumo-subtle" title="Shift + 点击勾选框 = 从上次点选处连续选中">
            已选 <strong className="text-kumo-default">{pickedCount}</strong> / {shown.length}
          </span>
          <Button size="xs" variant="secondary" onClick={pickAllShown}>全选</Button>
          <Button size="xs" variant="secondary" onClick={pickInvert}>反选</Button>
          <Button size="xs" variant="secondary" onClick={pickNone}>取消</Button>
        </div>
        {/* 右侧钱包栏的手动配对板（角色不再展示，底层仍按 cohort 分组） */}
        <CohortPairBoard wallets={shown} pickedIds={picked} onChanged={refreshLive} />
        <CohortFilmstrip wallets={shown} selectedId={drawerWallet?.id} onSelect={setDrawerWallet} />
        <div className="min-h-0 flex-1">
          {fleet.wallets.length === 0 ? (
            <div className="flex h-full items-center justify-center p-4">
              <Empty
                icon={<WalletIcon size={48} className="text-kumo-inactive" />}
                title="No wallets yet"
                description="Create an account to derive or import wallets."
                contents={<LinkButton href="/accounts" variant="primary">Create an account</LinkButton>}
              />
            </div>
          ) : shown.length === 0 ? (
            <div className="flex h-full items-center justify-center p-4">
              <Empty size="sm" icon={<FunnelIcon size={32} className="text-kumo-inactive" />} title="No wallets match the filter" />
            </div>
          ) : (
            <WalletGrid wallets={shown} selectedId={drawerWallet?.id} onSelect={setDrawerWallet} pickedIds={picked} onTogglePick={togglePick} checks={checks} onCheck={checkWallet} nado={nado} onOpenNado={openNado} />
          )}
        </div>
      </main>
      <WalletDrawer
        wallet={drawerVM}
        onClose={() => setDrawerWallet(null)}
        isLive={drawerWallet ? isLiveWallet(drawerWallet) : false}
        liveEvents={drawerWallet && isLiveWallet(drawerWallet) ? liveEvents : undefined}
        liveMarkets={live.markets}
        openOrders={drawerLive?.openOrders}
        positions={drawerLive?.positions}
        balances={drawerLive?.balances}
        subaccount={drawerLive?.subaccount}
        onRefueled={(ids) => {
          // Force a fresh native read (bypass the SWR TTL) then reconcile so the recipient + treasury
          // gas badges + readiness repaint immediately instead of waiting out the next sweep pass.
          for (const id of ids) {
            void forceRefreshNative(id)
              .then(() => reconcileWallet(id))
              .then((upd) => setLive((s) => mergeWallet(s, upd)))
              .catch(() => {});
          }
        }}
      />
      <AccountingView
        open={accountingOpen}
        subaccounts={(live.wallets ?? [])
          .filter((w) => picked.has(w.walletId))
          .map((w) => w.subaccount)
          .filter((s): s is string => Boolean(s))}
        onClose={() => setAccountingOpen(false)}
        balanceUsdt0={walletBalance.sum}
        balanceKnown={walletBalance.known}
        balanceTotal={walletBalance.total}
      />
    </KumoSidebar.Provider>
  );
}
