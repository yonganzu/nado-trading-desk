"use client";

// =============================================================================
// 「Nado 实际仓位」：展示 ASH 收到的真实仓位快照
// （是否实时、来源是后端直连还是本标签页推送、哪个钱包、各交易对的仓位）。
// 快照过期时仍然展示，但明确标注"已过期、ASH 不据此决策"。
// =============================================================================
import { Badge, Empty, LayerCard, Table, Text } from "@cloudflare/kumo";
import { WalletIcon } from "@phosphor-icons/react";
import type { AshPositionState } from "../lib/ashTypes";
import { ashNum, ashTime } from "../lib/ashFormat";

export function AshLivePositions({ positions }: { positions: AshPositionState | undefined }) {
  const rows = positions?.positions ?? [];
  const fresh = positions?.fresh === true;
  const wallet = positions?.wallet ? `${positions.wallet.slice(0, 6)}…${positions.wallet.slice(-4)}` : "未指定";
  const source = positions?.source === "backend" ? "后端" : "网页";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-kumo-subtle">Nado 实际仓位 · {rows.length}</span>
        {positions?.enabled === false ? (
          <Badge variant="secondary">未启用</Badge>
        ) : fresh ? (
          <Badge variant="success">
            {source}实时 · {ashTime(positions?.at)}
          </Badge>
        ) : (
          <Badge variant="warning">
            {positions?.at ? `${source}已过期 · ${ashTime(positions.at)}` : "尚未同步"}
          </Badge>
        )}
        <Text variant="secondary" size="xs">
          钱包 {wallet} · 挂单 {positions?.openOrders == null ? "—" : positions.openOrders}
        </Text>
      </div>

      {rows.length === 0 ? (
        <Empty
          size="sm"
          icon={<WalletIcon size={32} className="text-kumo-inactive" />}
          title={fresh ? "实盘当前无仓位" : "还没有收到仓位快照"}
          description={
            fresh
              ? "ASH 会按「实盘无仓」处理：不再转发平仓单；若计划仍在持仓，会被标记为外部平仓。"
              : positions?.source === "backend"
                ? "后端直连已接管：在控制台首页「策略」面板选一次执行钱包即可，之后关掉标签页也会持续同步。"
                : "保持控制台首页打开、保险库解锁，并在「策略」面板选择执行钱包，即可自动同步。"
          }
        />
      ) : (
        <LayerCard className="p-0">
          <Table className="tabular-nums">
            <Table.Header variant="compact">
              <Table.Row>
                <Table.Head>交易对</Table.Head>
                <Table.Head>方向</Table.Head>
                <Table.Head>数量</Table.Head>
                <Table.Head>开仓均价</Table.Head>
                <Table.Head>marketId</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((p) => (
                <Table.Row key={p.market}>
                  <Table.Cell>{p.symbol}</Table.Cell>
                  <Table.Cell className={p.side === "long" ? "text-kumo-success" : "text-kumo-danger"}>
                    {p.side === "long" ? "多" : p.side === "short" ? "空" : "平"}
                  </Table.Cell>
                  <Table.Cell>{ashNum(p.size, 6)}</Table.Cell>
                  <Table.Cell>{ashNum(p.entryPrice, 2)}</Table.Cell>
                  <Table.Cell className="max-w-56 truncate font-mono" title={p.market}>{p.market}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </div>
  );
}
