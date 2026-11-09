"use client";

// =============================================================================
// ASH 数据表：仓位盈亏记录。
// 数据由页面从 /api/ash/signals 拉取后传入（新的在前）。
// 盈亏口径 = Nado 成交回执（nado_fills）逐笔开平配对：
//   毛利 = (平仓价 − 开仓均价) × 数量 × 方向；净盈亏 = 毛利 − 手续费。
// =============================================================================
import { Badge, Empty, LayerCard, Table } from "@cloudflare/kumo";
import { ChartLineUpIcon } from "@phosphor-icons/react";
import type { AshPositionPnl } from "../lib/ashTypes";
import { ashDateTime, ashNum, ashPlanState, ashPnl, ashQty } from "../lib/ashFormat";

/** 表头 + 空态的通用外壳。 */
function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-kumo-subtle">{title} · {count}</span>
      {children}
    </div>
  );
}

/** 仓位盈亏记录：每笔仓位（从 0 持仓到再次回到 0）一条记录。 */
export function AshPositionPnlTable({ records }: { records: AshPositionPnl[] }) {
  // 持仓在前，其次按最近平仓 / 开仓倒序
  const rows = [...records].sort((a, b) => {
    const open = Number(b.state === "OPEN") - Number(a.state === "OPEN");
    return open !== 0
      ? open
      : Number(b.closed_at || b.opened_at) - Number(a.closed_at || a.opened_at);
  });
  return (
    <Section title="仓位盈亏记录" count={rows.length}>
      {rows.length === 0 ? (
        <Empty
          size="sm"
          icon={<ChartLineUpIcon size={32} className="text-kumo-inactive" />}
          title="还没有仓位盈亏记录"
          description="Nado 推送成交回执后，这里会按开平配对生成每笔仓位的盈亏。"
        />
      ) : (
        <LayerCard className="p-0">
          <div className="max-h-[24rem] overflow-y-auto">
            <Table className="tabular-nums">
              <Table.Header variant="compact" sticky>
                <Table.Row>
                  <Table.Head>开仓时间</Table.Head>
                  <Table.Head>平仓时间</Table.Head>
                  <Table.Head>交易对</Table.Head>
                  <Table.Head>方向</Table.Head>
                  <Table.Head>状态</Table.Head>
                  <Table.Head>数量</Table.Head>
                  <Table.Head>开仓均价</Table.Head>
                  <Table.Head>平仓价</Table.Head>
                  <Table.Head>手续费</Table.Head>
                  <Table.Head>毛利</Table.Head>
                  <Table.Head>净盈亏</Table.Head>
                  <Table.Head>成交笔数</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((r) => {
                  const st = ashPlanState(r.state);
                  const closed = r.state === "CLOSED";
                  return (
                    <Table.Row key={r.key}>
                      <Table.Cell className="whitespace-nowrap">{ashDateTime(r.opened_at)}</Table.Cell>
                      <Table.Cell className="whitespace-nowrap">{closed ? ashDateTime(r.closed_at) : "-"}</Table.Cell>
                      <Table.Cell>{r.symbol}</Table.Cell>
                      <Table.Cell className={r.side === "long" ? "text-kumo-success" : "text-kumo-danger"}>
                        {r.side === "long" ? "做多" : "做空"}
                      </Table.Cell>
                      <Table.Cell><Badge variant={st.variant}>{st.text}</Badge></Table.Cell>
                      <Table.Cell>{ashQty(r.qty)}</Table.Cell>
                      <Table.Cell>{ashNum(r.entry_price, 2)}</Table.Cell>
                      <Table.Cell>{closed ? ashNum(r.exit_price, 2) : "-"}</Table.Cell>
                      <Table.Cell>{ashNum(r.fee, 4)}</Table.Cell>
                      <Table.Cell className={closed ? (Number(r.gross_pnl) > 0 ? "text-kumo-success" : Number(r.gross_pnl) < 0 ? "text-kumo-danger" : undefined) : "text-kumo-subtle"}>
                        {closed ? ashPnl(r.gross_pnl) : "-"}
                      </Table.Cell>
                      <Table.Cell className={closed ? (Number(r.net_pnl) > 0 ? "text-kumo-success" : Number(r.net_pnl) < 0 ? "text-kumo-danger" : undefined) : "text-kumo-subtle"}>
                        {closed ? ashPnl(r.net_pnl) : "-"}
                      </Table.Cell>
                      <Table.Cell>{r.fills}</Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        </LayerCard>
      )}
    </Section>
  );
}
