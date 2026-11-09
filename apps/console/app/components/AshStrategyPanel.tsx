"use client";

// =============================================================================
// ASH 策略与品种面板：一个按钮在「策略参数」和「交易品种」之间切换。
//
//   • 策略参数 —— 改 risk / execution / signal 三组白名单参数，保存后立即生效；
//   • 交易品种 —— 按 24h 成交额排序的 Nado 永续目录，maker 倍数单独一类，
//                  保存后 ASH 重订阅行情（不重启进程）。
// 两者都是写操作，所以都走后端代理（Token 不出服务端），成功后回调 onSaved
// 让 /ash 页立刻拉一次 /api/status 回显新状态。
// =============================================================================
import { useEffect, useMemo, useState } from "react";
import { Badge, Banner, Button, ButtonGroup, LayerCard, Text } from "@cloudflare/kumo";
import { InfoIcon } from "@phosphor-icons/react";
import type { AshTunables } from "../lib/ashTypes";
import { AshTunableForm } from "./AshTunableForm";
import { AshSymbolPicker } from "./AshSymbolPicker";

type Tab = "params" | "symbols";

export function AshStrategyPanel({
  tunables,
  symbols,
  openCount,
  onSaved,
}: {
  tunables?: AshTunables;
  symbols?: string[];
  openCount?: number;
  onSaved?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("params");
  // 保存后本地回显后端最新值（不必等下一轮轮询）
  const [local, setLocal] = useState<AshTunables | undefined>(tunables);
  const [current, setCurrent] = useState<string[]>(symbols ?? []);

  // /ash 页每 3 秒轮询一次，status 里的 tunables / symbols 每次都是新对象。
  // 只按「内容」比较再回填，否则会把用户正在输入的表单和勾选冲掉。
  const tunablesKey = useMemo(() => JSON.stringify(tunables ?? null), [tunables]);
  const symbolsKey = useMemo(() => (symbols ?? []).join(","), [symbols]);

  useEffect(() => {
    if (tunables) setLocal(tunables);
  }, [tunablesKey]);
  useEffect(() => {
    setCurrent(symbolsKey ? symbolsKey.split(",") : []);
  }, [symbolsKey]);

  return (
    <LayerCard>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <Text variant="heading" as="h2">策略与品种</Text>
            <Text variant="secondary" size="xs">
              改完点保存立刻生效（ASH 不重启，配置同时写回 config.json）
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">运行中 {current.length} 个品种</Badge>
            {Number(openCount) > 0 ? <Badge variant="warning">持仓 {openCount} 笔</Badge> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ButtonGroup aria-label="策略与品种切换">
            <Button
              size="sm"
              variant={tab === "params" ? "primary" : "secondary"}
              aria-pressed={tab === "params"}
              onClick={() => setTab("params")}
            >
              策略参数
            </Button>
            <Button
              size="sm"
              variant={tab === "symbols" ? "primary" : "secondary"}
              aria-pressed={tab === "symbols"}
              onClick={() => setTab("symbols")}
            >
              交易品种
            </Button>
          </ButtonGroup>
          <Text variant="secondary" size="xs">
            {current.length ? current.join(" · ") : "还没有配置品种"}
          </Text>
        </div>

        {Number(openCount) > 0 && tab === "symbols" ? (
          <Banner
            variant="alert"
            size="sm"
            icon={<InfoIcon weight="fill" />}
            description="当前还有未平仓位 / 挂单，切换品种会被 ASH 拒绝；先平仓再切换。"
          />
        ) : null}

        {tab === "params" ? (
          local ? (
            <AshTunableForm
              tunables={local}
              onSaved={(next) => { setLocal(next); onSaved?.(); }}
            />
          ) : (
            <Text variant="secondary" size="xs">读取中…（ASH 未连接时这里不会显示参数）</Text>
          )
        ) : (
          <AshSymbolPicker
            current={current}
            onSaved={(next) => { setCurrent(next); onSaved?.(); }}
          />
        )}
      </div>
    </LayerCard>
  );
}
