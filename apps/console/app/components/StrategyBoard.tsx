"use client";

// =============================================================================
// 「策略执行」看板（内嵌版）：合并到 /ash 页面，不再走首页弹窗。
//   1. 左侧切换分组视图（全部分组 / 某个账户），右侧勾选钱包——可跨分组多选、也可一键全选
//   2. 勾选多个钱包是跟单模式：ASH 的一笔信号会在每个钱包各开一份
//   3. 列出策略信号的排队与执行结果
// 数据来自本机队列（GET /api/strategy/signal），每 3 秒刷新一次。
//
// 注意：真正签名下单的是 useStrategyBridge（在 /ash 页面里启动），所以执行时 /ash
// 这个标签页必须开着、保险库必须解锁。首页不再消费信号。
// =============================================================================
import { useEffect, useMemo, useState } from "react";
import { Badge, Empty, LayerCard, Table, Text } from "@cloudflare/kumo";
import { CheckSquareIcon, LightningIcon, SquareIcon } from "@phosphor-icons/react";
import type { StrategySignal } from "../lib/strategySignalModel";
import { resolveExecAddresses } from "../lib/strategyExecWallet";
import type { ExecScope } from "../lib/strategyExecWallet";

const REFRESH_MS = 3_000;

/** 可选的执行钱包（来自已解锁保险库的钱包列表）。 */
export interface ExecWalletOption {
  id: string;
  label: string;
  address: string;
  /** 所属账户名，用于「分组」列 */
  account?: string;
}

const STATUS: Record<string, { text: string; variant: "success" | "warning" | "error" | "secondary" }> = {
  pending: { text: "排队中", variant: "warning" },
  claimed: { text: "执行中", variant: "secondary" },
  done: { text: "已执行", variant: "success" },
  error: { text: "失败", variant: "error" },
  expired: { text: "已过期", variant: "secondary" },
};

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function timeOf(ms?: number): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 详情列：优先显示错误原因，其次显示执行快照（持仓 / 挂单）。 */
function detail(s: StrategySignal): string {
  if (s.error) return s.error;
  const parts: string[] = [];
  // 回显实际下单的品种：信号里的 market 可能是 symbol 写法，这里给出解析后的 productId
  if (typeof s.order?.productId === "number") parts.push(`品种 #${s.order.productId}`);
  if (s.order?.status) parts.push(String(s.order.status));
  if (s.execution?.position) {
    const p = s.execution.position;
    parts.push(`持仓 ${p.side} ${p.size}`);
  }
  if (typeof s.execution?.openOrders === "number") parts.push(`挂单 ${s.execution.openOrders}`);
  return parts.join(" · ") || "-";
}

export function StrategyBoard({
  wallets, scope, onScopeChange, locked, bridgeError,
}: {
  /** 保险库里可选的钱包（未解锁时为空） */
  wallets: ExecWalletOption[];
  /** 当前选择：group 空 = 全部分组，address 空 = 组内全部 */
  scope: ExecScope;
  onScopeChange: (scope: ExecScope) => void;
  /** 保险库是否锁定（锁定时钱包列表为空，无法签名） */
  locked: boolean;
  /** 本标签页消费信号时的最近错误（有值时提示用户） */
  bridgeError?: string | null;
}) {
  const [signals, setSignals] = useState<StrategySignal[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await fetch("/api/strategy/signal?limit=50", { cache: "no-store" });
        if (!res.ok) throw new Error(`接口返回 ${res.status}`);
        const body = (await res.json()) as { signals?: StrategySignal[] };
        if (!stopped) {
          setSignals([...(body.signals ?? [])].reverse());
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
      if (!stopped) timer = setTimeout(tick, REFRESH_MS);
    };
    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);

  // 分组：按账户名聚合（顺序沿用钱包列表，稳定不跳）
  const groups = useMemo(() => {
    const map = new Map<string, ExecWalletOption[]>();
    for (const w of wallets) {
      const key = w.account || "未分组";
      const list = map.get(key);
      if (list) list.push(w);
      else map.set(key, [w]);
    }
    return [...map.entries()];
  }, [wallets]);

  const leftItems = useMemo(
    () => [
      { key: "", label: "全部分组", count: wallets.length },
      ...groups.map(([name, list]) => ({ key: name, label: name, count: list.length })),
    ],
    [groups, wallets.length],
  );

  // 右列只显示当前分组里的钱包（左侧选「全部分组」时显示全部）
  const visibleWallets = useMemo(
    () => (scope.group ? groups.find(([name]) => name === scope.group)?.[1] ?? [] : wallets),
    [scope.group, groups, wallets],
  );

  const selectedAddresses = useMemo(() => resolveExecAddresses(scope, wallets), [scope, wallets]);
  const selectedSet = useMemo(() => new Set(selectedAddresses), [selectedAddresses]);
  const pending = signals.filter((s) => s.status === "pending" || s.status === "claimed").length;

  // 左列只是切换视图，不动已勾选的钱包（这样能先在全部分组里跨组勾选）
  const pickGroup = (group: string): void => onScopeChange({ ...scope, group });

  const toggle = (address: string): void => {
    const addr = address.toLowerCase();
    const next = selectedSet.has(addr)
      ? scope.addresses.filter((a) => a !== addr)
      : [...scope.addresses, addr];
    onScopeChange({ ...scope, addresses: next });
  };

  // 全选 / 取消全选：只作用于右列当前看到的那批钱包，跨组已选的其它钱包保留
  const toggleVisible = (): void => {
    const visible = visibleWallets.map((w) => w.address.toLowerCase());
    const all = visible.length > 0 && visible.every((a) => selectedSet.has(a));
    const next = all
      ? scope.addresses.filter((a) => !visible.includes(a))
      : [...new Set([...scope.addresses, ...visible])];
    onScopeChange({ ...scope, addresses: next });
  };

  const selectedIn = (list: ExecWalletOption[]): number =>
    list.filter((w) => selectedSet.has(w.address.toLowerCase())).length;

  const allVisibleSelected =
    visibleWallets.length > 0 && selectedIn(visibleWallets) === visibleWallets.length;

  const summary = (() => {
    if (locked) return "保险库已锁定：解锁后才能列出钱包并签名下单。";
    if (!wallets.length) return "保险库里还没有钱包。";
    if (!selectedAddresses.length) return "还没有勾选执行钱包。没勾选前信号会留在队列里，不会被领走。";
    if (selectedAddresses.length === 1) {
      const hit = wallets.find((w) => w.address.toLowerCase() === selectedAddresses[0]);
      return `执行钱包：${hit?.label ?? "选定地址"} · ${selectedAddresses[0]}`;
    }
    return `跟单模式：已勾选 ${selectedAddresses.length} 个钱包，ASH 每笔信号在每个钱包各开一份（总仓位按钱包数放大）。`;
  })();

  return (
    <LayerCard>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <Text variant="heading" as="h2">策略执行</Text>
            <Text variant="secondary" size="xs">
              {pending} 条待执行 · 共 {signals.length} 条记录 · POST /api/strategy/signal
            </Text>
          </div>
          <Badge
            variant={selectedAddresses.length === 0 ? "secondary" : selectedAddresses.length === 1 ? "success" : "warning"}
          >
            {selectedAddresses.length === 0
              ? "未指定执行钱包"
              : selectedAddresses.length === 1
                ? `单钱包 ${short(selectedAddresses[0]!)}`
                : `跟单 ${selectedAddresses.length} 个钱包`}
          </Badge>
        </div>

        {/* 左：切换分组视图；右：勾选钱包（可跨分组多选，也可一键全选当前视图） */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-1">
            <Text variant="secondary" size="xs">分组（账户）</Text>
            <div className="max-h-52 overflow-y-auto rounded-lg border border-kumo-line" role="listbox" aria-label="执行钱包分组">
              {leftItems.map((it) => {
                const active = it.key === scope.group;
                const picked = it.key
                  ? selectedIn(groups.find(([name]) => name === it.key)?.[1] ?? [])
                  : selectedAddresses.length;
                return (
                  <button
                    key={it.key || "all"}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => pickGroup(it.key)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                      active ? "bg-kumo-brand text-kumo-inverse" : "hover:bg-kumo-canvas"
                    }`}
                  >
                    <span className="truncate">{it.label}</span>
                    <span className={`shrink-0 text-xs ${active ? "opacity-80" : "text-kumo-subtle"}`}>
                      {picked > 0 ? `已选 ${picked}/${it.count}` : it.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <Text variant="secondary" size="xs">钱包（{scope.group || "全部分组"}）</Text>
            <div className="max-h-52 overflow-y-auto rounded-lg border border-kumo-line" role="listbox" aria-label="执行钱包" aria-multiselectable="true">
              <button
                type="button"
                role="option"
                aria-selected={allVisibleSelected}
                onClick={toggleVisible}
                className={`flex w-full items-center gap-2 border-b border-kumo-line px-3 py-2 text-left text-sm ${
                  allVisibleSelected ? "bg-kumo-brand text-kumo-inverse" : "hover:bg-kumo-canvas"
                }`}
              >
                {allVisibleSelected
                  ? <CheckSquareIcon size={16} className="shrink-0" />
                  : <SquareIcon size={16} className="shrink-0 text-kumo-subtle" />}
                <span className="min-w-0 flex-1 truncate">{allVisibleSelected ? "取消全选" : "全选"}</span>
                <span className={`shrink-0 text-xs ${allVisibleSelected ? "opacity-80" : "text-kumo-subtle"}`}>
                  {visibleWallets.length}
                </span>
              </button>
              {visibleWallets.map((w) => {
                const active = selectedSet.has(w.address.toLowerCase());
                return (
                  <button
                    key={w.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => toggle(w.address)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                      active ? "bg-kumo-brand text-kumo-inverse" : "hover:bg-kumo-canvas"
                    }`}
                  >
                    {active
                      ? <CheckSquareIcon size={16} className="shrink-0" />
                      : <SquareIcon size={16} className="shrink-0 text-kumo-subtle" />}
                    <span className="min-w-0 flex-1 truncate">
                      {w.label} <span className="font-mono opacity-70">{short(w.address)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className={`rounded-lg border px-3 py-2 text-xs ${selectedAddresses.length ? "border-kumo-line" : "border-kumo-line text-kumo-subtle"}`}>
          {summary}
        </div>

        {(error || bridgeError) && (
          <Text variant="secondary" size="xs">
            读取失败：{error ?? bridgeError}
          </Text>
        )}

        {signals.length === 0 ? (
          <Empty
            size="sm"
            icon={<LightningIcon size={32} className="text-kumo-inactive" />}
            title="还没有策略信号"
            description="ASH 产生信号后，会由本标签页签名并转发到 Nado。"
          />
        ) : (
          <div className="max-h-[24rem] overflow-y-auto rounded-lg border border-kumo-line">
            <Table className="tabular-nums">
              <Table.Header variant="compact" sticky>
                <Table.Row>
                  <Table.Head>时间</Table.Head>
                  <Table.Head>钱包</Table.Head>
                  <Table.Head>市场</Table.Head>
                  <Table.Head>方向 / 数量</Table.Head>
                  <Table.Head>价格</Table.Head>
                  <Table.Head>状态</Table.Head>
                  <Table.Head>详情</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {signals.map((s) => {
                  const st = STATUS[s.status] ?? { text: s.status, variant: "secondary" as const };
                  const walletText = s.wallet
                    ? short(s.wallet)
                    : selectedAddresses.length === 1
                      ? `选定 ${short(selectedAddresses[0]!)}`
                      : selectedAddresses.length
                        ? `跟单 ${selectedAddresses.length} 个`
                        : "未指定";
                  return (
                    <Table.Row key={s.id}>
                      <Table.Cell className="whitespace-nowrap">{timeOf(s.createdAt)}</Table.Cell>
                      <Table.Cell className="font-mono">{walletText}</Table.Cell>
                      <Table.Cell>{s.market}</Table.Cell>
                      <Table.Cell>{s.action === "cancel" ? "撤单 · " : ""}{s.side === "buy" ? "买" : "卖"} {s.size}{s.reduceOnly ? "（只减仓）" : ""}</Table.Cell>
                      <Table.Cell>{s.price ?? "市价"}</Table.Cell>
                      <Table.Cell><Badge variant={st.variant}>{st.text}</Badge></Table.Cell>
                      <Table.Cell className="max-w-56 truncate" title={detail(s)}>{detail(s)}</Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        )}

        <Text variant="secondary" size="xs">
          执行需要本标签页（/ash）保持打开、保险库已解锁；勾选保存在本浏览器。
          勾选多个钱包时，一笔信号会在每个钱包各开一份，总仓位按钱包数放大。连续失败 3 次会暂停 60 秒。
        </Text>
      </div>
    </LayerCard>
  );
}
