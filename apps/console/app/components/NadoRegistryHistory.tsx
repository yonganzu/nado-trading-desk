"use client";

// =============================================================================
// 「注册记录」列表：展示后端登记表 (.nado-registry.json) 里当前账户下每个钱包的
// 注册结果。离开页面、刷新浏览器、甚至重启服务后仍然存在。
// =============================================================================
import { Badge, Text } from "@cloudflare/kumo";
import type { NadoRegistryEntry } from "../lib/nadoRegistryModel";

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

function timeText(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function statusBadge(entry: NadoRegistryEntry) {
  if (entry.registered) return <Badge variant="success">已注册</Badge>;
  if (entry.lastError) return <span title={entry.lastError}><Badge variant="error">失败</Badge></span>;
  return <Badge variant="warning">未注册</Badge>;
}

export function NadoRegistryHistory({ entries }: { entries: NadoRegistryEntry[] }) {
  if (entries.length === 0) {
    return (
      <Text variant="secondary" size="xs">
        还没有注册记录。完成一次登录注册或状态检查后，结果会按钱包地址保存在本机。
      </Text>
    );
  }

  const registered = entries.filter((e) => e.registered).length;
  const failed = entries.filter((e) => !e.registered && !!e.lastError).length;
  const unregistered = entries.length - registered - failed;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success">已注册 {registered}</Badge>
        <Badge variant="warning">未注册 {unregistered}</Badge>
        {failed > 0 && <Badge variant="error">失败 {failed}</Badge>}
        <Text variant="secondary" size="xs" as="span">
          共 {entries.length} 个钱包 · 记录保存在本机 .nado-registry.json
        </Text>
      </div>
      <div className="max-h-72 overflow-y-auto rounded border border-kumo-line">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-kumo-base text-kumo-subtle">
            <tr>
              <th className="px-2 py-1 font-medium">#</th>
              <th className="px-2 py-1 font-medium">地址</th>
              <th className="px-2 py-1 font-medium">状态</th>
              <th className="px-2 py-1 font-medium">用户名</th>
              <th className="px-2 py-1 font-medium">来源</th>
              <th className="px-2 py-1 font-medium">时间</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.address} className="border-t border-kumo-line">
                <td className="px-2 py-1 text-kumo-subtle">{entry.walletIndex ?? "—"}</td>
                <td className="px-2 py-1 font-mono">{shortAddress(entry.address)}</td>
                <td className="px-2 py-1">{statusBadge(entry)}</td>
                <td className="px-2 py-1">{entry.username ?? "—"}</td>
                <td className="px-2 py-1 text-kumo-subtle">{entry.source === "login" ? "登录注册" : "状态检查"}</td>
                <td className="px-2 py-1 text-kumo-subtle">{timeText(entry.checkedAt ?? entry.lastAttemptAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
