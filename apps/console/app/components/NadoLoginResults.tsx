"use client";

import { Badge, Button, Text } from "@cloudflare/kumo";
import { EyeIcon } from "@phosphor-icons/react";
import type { NadoLoginJobView, WalletLoginResult, WalletLoginStatus } from "../lib/nadoLoginTypes";

/** 状态徽标：排队 / 登录中 / 成功 / 失败。 */
function StatusBadge({ status }: { status: WalletLoginStatus }) {
  if (status === "ok") return <Badge variant="primary">ok</Badge>;
  if (status === "failed") return <Badge variant="secondary" className="text-kumo-danger">failed</Badge>;
  if (status === "running") return <Badge variant="secondary" className="text-kumo-subtle">running…</Badge>;
  return <Badge variant="secondary">pending</Badge>;
}

/** 登录任务的结果表：一行一个钱包（序号 / 地址 / 状态 / 耗时 / 错误）。
 *  传入 `onInspect` 时每行出现「登录并查看」按钮：用该钱包重新打开一个已登录的浏览器窗口。 */
export function NadoLoginResults({ job, onInspect, inspectingIndex }: {
  job: NadoLoginJobView;
  onInspect?: (row: WalletLoginResult) => void;
  inspectingIndex?: number | null;
}) {
  const ok = job.results.filter((r) => r.status === "ok").length;
  const failed = job.results.filter((r) => r.status === "failed").length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Text variant="secondary">
          {job.finished}/{job.total} 完成 · {ok} 成功 · {failed} 失败
        </Text>
        <Text variant="secondary" size="xs" as="span">
          {job.status === "running"
            ? "任务进行中…"
            : job.status === "done"
              ? "全部成功"
              : job.status === "cancelled"
                ? "已手动停止"
                : "任务结束（存在失败）"}
        </Text>
      </div>
      <ul className="flex flex-col divide-y divide-kumo-line rounded-md border border-kumo-line">
        {job.results.map((r) => (
          <li key={`${r.index}-${r.address}`} data-testid="nado-login-row" className="flex flex-col gap-1 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Text variant="mono-secondary" as="span">#{r.index}</Text>
                <Text variant="mono-secondary" as="span">{r.address}</Text>
                {r.username && <Text variant="secondary" size="xs" as="span">{r.username}</Text>}
              </span>
              <span className="flex items-center gap-2">
                {typeof r.ms === "number" && <Text variant="secondary" size="xs" as="span">{(r.ms / 1000).toFixed(1)}s</Text>}
                <StatusBadge status={r.status} />
                {onInspect && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={EyeIcon}
                    loading={inspectingIndex === r.index}
                    disabled={(inspectingIndex ?? null) !== null && inspectingIndex !== r.index}
                    onClick={() => onInspect(r)}
                  >
                    登录并查看
                  </Button>
                )}
              </span>
            </div>
            {r.error && <Text variant="error" size="xs">{r.error}</Text>}
          </li>
        ))}
      </ul>
    </div>
  );
}
