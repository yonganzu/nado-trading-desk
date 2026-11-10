"use client";

import { useMemo, useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import type { WalletVM } from "@farm/ui";
import { manualPairs, useManualPairs } from "../lib/pairing";

const short = (v: string): string => `${v.slice(0, 6)}…${v.slice(-4)}`;

/** 右侧钱包栏顶部的手动配对板。
 *  - 头部只有一行：折叠开关 + 配对数 + 清空配对；
 *  - 内容按「配对 / 已有」两行对齐（左侧小标签，右侧控件）；
 *  - 配对：从已勾选的钱包里两侧各选一个做成一对一，运行自动化时按这份名单逐对开打；
 *  - 角色（挂单 / 吃单）不再在界面上展示，底层引擎仍按原有逻辑分组运行；
 *  - 配对名单存在本地（lib/pairing），刷新页面后仍在。 */
export function CohortPairBoard({ wallets, pickedIds, onChanged }: {
  wallets: WalletVM[];
  pickedIds: Set<string>;
  onChanged?: () => void;
}) {
  const picked = useMemo(() => wallets.filter((w) => pickedIds.has(w.id)), [wallets, pickedIds]);
  const pairs = useManualPairs();
  const byId = useMemo(() => new Map(wallets.map((w) => [w.id, w])), [wallets]);

  const [open, setOpen] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selA, setSelA] = useState("");
  const [selB, setSelB] = useState("");

  // 选中的钱包被取消勾选 / 消失后自动失效，避免「添加配对」用到看不见的钱包
  const aOpt = picked.some((w) => w.id === selA) ? selA : "";
  const bOpt = picked.some((w) => w.id === selB) ? selB : "";

  const addPair = () => {
    if (!aOpt || !bOpt) return;
    if (aOpt === bOpt) { setErr("两侧不能是同一个钱包"); return; }
    setErr(null);
    manualPairs.add(aOpt, bOpt);
    setSelA("");
    setSelB("");
    onChanged?.();
  };

  return (
    <section className="border-b border-kumo-line bg-kumo-base">
      {/* 头部：一行放齐折叠开关 + 配对数 + 清空 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1 text-xs font-medium text-kumo-default hover:text-kumo-brand"
        >
          {open ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}
          配对
        </button>
        <span className="flex items-center gap-1 text-xs text-kumo-subtle">
          配对 <strong className="tabular-nums text-kumo-default">{pairs.length}</strong>
        </span>
        {pairs.length > 0 && (
          <button
            type="button"
            onClick={() => { manualPairs.clear(); onChanged?.(); }}
            className="ml-auto text-xs text-kumo-subtle hover:text-kumo-default"
          >
            清空配对
          </button>
        )}
      </div>

      {open && (
        <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5 px-4 pb-2">
          {/* 配对：两侧各选一个钱包，添加后进「已有」 */}
          <span className="pt-1.5 text-xs text-kumo-subtle">配对</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={aOpt}
              onChange={(e) => setSelA(e.target.value)}
              className="h-7 rounded-md border border-kumo-line bg-kumo-base px-1.5 text-xs text-kumo-default"
            >
              <option value="">钱包 A…</option>
              {picked.map((w) => <option key={w.id} value={w.id}>{short(w.address.value)}</option>)}
            </select>
            <span className="text-xs text-kumo-subtle">↔</span>
            <select
              value={bOpt}
              onChange={(e) => setSelB(e.target.value)}
              className="h-7 rounded-md border border-kumo-line bg-kumo-base px-1.5 text-xs text-kumo-default"
            >
              <option value="">钱包 B…</option>
              {picked.map((w) => <option key={w.id} value={w.id}>{short(w.address.value)}</option>)}
            </select>
            <Button size="xs" variant="secondary" disabled={!aOpt || !bOpt} onClick={addPair}>添加</Button>
          </div>

          {picked.length === 0 && (
            <>
              <span />
              <Text variant="secondary" size="xs" as="span">先勾选钱包（卡片左上角勾选框），再从两侧各选一个配对。</Text>
            </>
          )}

          {pairs.length > 0 && (
            <>
              <span className="pt-1 text-xs text-kumo-subtle">已有</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {pairs.map((p) => {
                  const m = byId.get(p.makerId);
                  const t = byId.get(p.takerId);
                  return (
                    <div key={p.id} className="flex items-center gap-1 rounded-md border border-kumo-line px-1.5 py-0.5 text-xs">
                      <span className="font-mono text-kumo-default">{m ? short(m.address.value) : "已移除"}</span>
                      <span className="text-kumo-subtle">↔</span>
                      <span className="font-mono text-kumo-default">{t ? short(t.address.value) : "已移除"}</span>
                      <button
                        type="button"
                        onClick={() => { manualPairs.remove(p.id); onChanged?.(); }}
                        className="ml-0.5 text-kumo-subtle hover:text-red-600"
                        aria-label="移除这个配对"
                      >×</button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {err && <span className="col-start-2 text-xs text-red-600">{err}</span>}
        </div>
      )}
    </section>
  );
}
