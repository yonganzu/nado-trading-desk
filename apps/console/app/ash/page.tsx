"use client";

// =============================================================================
// ASH 信号页（/ash）：ASH 交易终端的只读视图 + 策略执行看板。
// 数据来自 /api/ash/signals（服务端代读 ASH 的 Bearer Token），每 3 秒自动刷新。
// 首页的「策略」弹窗已合并到这里：执行钱包选择、钱包组、信号执行结果都在本页。
// 注意：策略信号由本标签页签名执行（useStrategyBridge），所以执行时本页必须开着。
// =============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner, Breadcrumbs, Button, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, WarningCircleIcon, WalletIcon } from "@phosphor-icons/react";
import { AshSummary } from "../components/AshSummary";
import { AshTradeStats } from "../components/AshTradeStats";
import { AshLivePositions } from "../components/AshLivePositions";
import { AshPositionPnlTable } from "../components/AshSignalTables";
import { AshStrategyPanel } from "../components/AshStrategyPanel";
import { StrategyBoard } from "../components/StrategyBoard";
import type { ExecWalletOption } from "../components/StrategyBoard";
import type { AshSnapshot } from "../lib/ashTypes";
import { ashTime } from "../lib/ashFormat";
import { fetchLiveState, liveWalletVMs } from "../lib/live";
import type { LiveState } from "../lib/live";
import { useExecScope, resolveExecAddresses } from "../lib/strategyExecWallet";
import { useStrategyBridge } from "../lib/strategyBridge";
import { usePositionSync } from "../lib/positionSync";

const REFRESH_MS = 3_000;
const LIVE_REFRESH_MS = 15_000;

export default function AshPage() {
  const [snapshot, setSnapshot] = useState<AshSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  // 保险库里的钱包（和首页同一份 in-tab cohort）：用来选执行钱包、显示钱包组
  const [live, setLive] = useState<LiveState>({ enabled: false });

  useEffect(() => {
    let stopped = false;
    const pull = () => { fetchLiveState().then((s) => { if (!stopped) setLive(s); }).catch(() => {}); };
    pull();
    const timer = setInterval(pull, LIVE_REFRESH_MS); // 解锁 / 新建钱包后自动出现，不用刷页
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  const liveWallets = useMemo(() => liveWalletVMs(live), [live]);
  const execWalletOptions = useMemo<ExecWalletOption[]>(
    () => liveWallets.map((w) => ({
      id: w.id,
      address: w.address.value,
      label: `${w.accountName || "account"} #${w.index}`,
      account: w.accountName || "account",
    })),
    [liveWallets],
  );

  // 执行范围：左选分组、右选钱包，两侧都能选「全部」（全部 = 跟单，每个钱包各开一份）
  const [execScope, setExecScope] = useExecScope();
  const execAddresses = useMemo(
    () => resolveExecAddresses(execScope, execWalletOptions),
    [execScope, execWalletOptions],
  );
  // 由本标签页领取并签名执行策略信号（首页不再消费，避免两个标签页抢同一条）。
  // 没选钱包时不轮询：否则会把信号领走再报失败，白白消耗队列。
  const bridge = useStrategyBridge(
    live.enabled && !live.locked && execAddresses.length > 0,
    execAddresses,
  );
  // 仍然把真实仓位推给 ASH（后端直连是主通道，这里是浏览器的补充）；
  // 仓位同步只需要一个代表性地址，跟单模式下取第一个
  usePositionSync(live.enabled && !live.locked, execAddresses[0] ?? "", live.wallets);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ash/signals", { cache: "no-store" });
      if (!res.ok) throw new Error(`读取接口返回 ${res.status}`);
      const body = (await res.json()) as AshSnapshot;
      setSnapshot(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 自动刷新：开关变化或手动刷新都会立刻拉一次
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await load();
      if (!stopped && auto) timer = setTimeout(tick, REFRESH_MS);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [auto, load]);

  const paused = snapshot?.status?.trading?.paused === true;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-4 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <Breadcrumbs size="sm">
          <Breadcrumbs.Link href="/" icon={<WalletIcon size={16} />}>Wallets</Breadcrumbs.Link>
          <Breadcrumbs.Separator />
          <Breadcrumbs.Current>ASH 信号</Breadcrumbs.Current>
        </Breadcrumbs>
        <div className="flex items-center gap-2">
          <Text variant="secondary" size="xs">
            {snapshot ? `更新于 ${ashTime(snapshot.fetchedAt)}` : "读取中…"}
          </Text>
          <Button size="sm" icon={ArrowsClockwiseIcon} onClick={() => void load()}>刷新</Button>
          <Button
            size="sm"
            variant={auto ? "primary" : "secondary"}
            aria-pressed={auto}
            onClick={() => setAuto((v) => !v)}
          >
            自动刷新 {auto ? "开" : "关"}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6">
          <div className="flex flex-col gap-1">
            <Text variant="heading" size="lg" as="h1">ASH 信号</Text>
            <Text variant="secondary">
              ASH 交易终端（{snapshot?.base ?? "http://127.0.0.1:8788"}）：下方只展示当前未平仓位，
              以及按 Nado 成交回执逐笔配对算出的仓位盈亏记录（毛利、手续费、净盈亏）。
              「策略执行」指定由哪个钱包（或钱包组里的哪个地址）承接单子。
            </Text>
          </div>

          {error && (
            <Banner
              variant="error"
              size="sm"
              icon={<WarningCircleIcon weight="fill" />}
              description={`读取 ASH 失败：${error}（确认 ASH 已在 127.0.0.1:8788 运行）`}
            />
          )}

          <AshSummary snapshot={snapshot} />

          <div className="flex flex-col gap-2">
            <Text variant="secondary" size="xs">成交量与磨损（Nado 实际成交回执）</Text>
            <AshTradeStats stats={snapshot?.status?.tradeStats} />
          </div>

          <StrategyBoard
            wallets={execWalletOptions}
            scope={execScope}
            onScopeChange={setExecScope}
            locked={live.locked === true}
            bridgeError={bridge.error}
          />

          <AshStrategyPanel
            tunables={snapshot?.status?.tunables}
            symbols={snapshot?.status?.symbols}
            openCount={snapshot?.status?.trading?.openCount}
            onSaved={() => void load()}
          />

          <AshLivePositions positions={snapshot?.status?.positions} />
          <AshPositionPnlTable records={snapshot?.positionPnl ?? []} />

          {paused && (
            <Text variant="secondary" size="xs">
              提示：ASH 暂停时不会产生新信号；恢复运行请调用 POST /api/admin/resume（需要管理 Token）。
            </Text>
          )}
        </div>
      </div>
    </div>
  );
}
