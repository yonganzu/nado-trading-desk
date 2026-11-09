"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button, Text, cn } from "@cloudflare/kumo";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import type { WalletVM } from "@farm/ui";
import { setWalletCohort } from "../lib/custody";
import { manualPairs, useManualPairs } from "../lib/pairing";

const short = (v: string): string => `${v.slice(0, 6)}…${v.slice(-4)}`;

/** 「挂 / 吃」角色选择里的一个小段：选中时用该角色的标识色填充，未选中时保持安静。 */
function RoleSeg({ active, tone, disabled, onClick, children }: {
  active: boolean;
  tone: "maker" | "taker";
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "px-1.5 py-0.5 text-[11px] font-medium leading-none transition-colors disabled:opacity-50",
        active
          ? tone === "maker" ? "bg-amber-500 text-white" : "bg-sky-500 text-white"
          : "text-kumo-subtle hover:bg-kumo-canvas hover:text-kumo-default",
      )}
    >
      {children}
    </button>
  );
}

/** 右侧钱包栏顶部的「挂单 / 吃单」分组 + 手动配对板。
 *  - 头部只有一行：折叠开关 + 两个角色计数（圆点代替色块）+ 清空配对；
 *  - 内容按「角色 / 配对 / 已有」三行对齐（左侧小标签，右侧控件），避免原来四排控件散落；
 *  - 分组：给已勾选的钱包点「挂 / 吃」定角色；配对：从两组各选一个做成一对一，运行自动化时按这份名单逐对开打；
 *  - 配对名单存在本地（lib/pairing），刷新页面后仍在。 */
export function CohortPairBoard({ wallets, pickedIds, onChanged }: {
  wallets: WalletVM[];
  pickedIds: Set<string>;
  onChanged?: () => void;
}) {
  const picked = useMemo(() => wallets.filter((w) => pickedIds.has(w.id)), [wallets, pickedIds]);
  const makers = picked.filter((w) => w.cohort === "maker");
  const takers = picked.filter((w) => w.cohort === "taker");
  const pairs = useManualPairs();
  const byId = useMemo(() => new Map(wallets.map((w) => [w.id, w])), [wallets]);

  const [open, setOpen] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null); // 正在写入角色的钱包（写入串行，避免并发读改写）
  const [err, setErr] = useState<string | null>(null);
  const [selMaker, setSelMaker] = useState("");
  const [selTaker, setSelTaker] = useState("");

  // 选中的钱包被取消勾选 / 消失后自动失效，避免「添加配对」用到看不见的钱包
  const makerOpt = makers.some((w) => w.id === selMaker) ? selMaker : "";
  const takerOpt = takers.some((w) => w.id === selTaker) ? selTaker : "";

  const setRole = async (w: WalletVM, role: "maker" | "taker") => {
    if (w.cohort === role || busyId) return; // 已经是这个角色就不重复写
    setBusyId(w.id);
    setErr(null);
    try {
      await setWalletCohort(w.id, role);
      onChanged?.();
    } catch (e) {
      setErr(`设置角色失败：${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  const addPair = () => {
    if (!makerOpt || !takerOpt) return;
    if (makerOpt === takerOpt) { setErr("挂单和吃单不能是同一个钱包"); return; }
    setErr(null);
    manualPairs.add(makerOpt, takerOpt);
    setSelMaker("");
    setSelTaker("");
  };

  return (
    <section className="border-b border-kumo-line bg-kumo-base">
      {/* 头部：一行放齐，计数用「圆点 + 数字」而不是三个独立色框 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1 text-xs font-medium text-kumo-default hover:text-kumo-brand"
        >
          {open ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}
          挂单 / 吃单
        </button>
        <span className="flex items-center gap-1 text-xs text-kumo-subtle" title="先勾选钱包，再用「挂 / 吃」定角色">
          <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
          挂单 <strong className="tabular-nums text-kumo-default">{makers.length}</strong>
        </span>
        <span className="flex items-center gap-1 text-xs text-kumo-subtle">
          <span aria-hidden className="size-1.5 rounded-full bg-sky-500" />
          吃单 <strong className="tabular-nums text-kumo-default">{takers.length}</strong>
        </span>
        <span className="flex items-center gap-1 text-xs text-kumo-subtle">
          配对 <strong className="tabular-nums text-kumo-default">{pairs.length}</strong>
        </span>
        {pairs.length > 0 && (
          <button
            type="button"
            onClick={() => manualPairs.clear()}
            className="ml-auto text-xs text-kumo-subtle hover:text-kumo-default"
          >
            清空配对
          </button>
        )}
      </div>

      {open && (
        <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5 px-4 pb-2">
          {/* 角色：每张已勾选的钱包一个小胶囊，右侧两段「挂 / 吃」 */}
          <span className="pt-1 text-xs text-kumo-subtle">角色</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {picked.length === 0 ? (
              <Text variant="secondary" size="xs" as="span">先勾选钱包（卡片左上角勾选框），再给它指定挂单或吃单。</Text>
            ) : (
              picked.map((w) => (
                <div
                  key={w.id}
                  className={cn(
                    "flex items-center gap-1 rounded-md border py-0.5 pl-1.5 pr-0.5 text-xs",
                    w.cohort === "maker" ? "border-amber-500/40 bg-amber-400/5"
                      : w.cohort === "taker" ? "border-sky-500/40 bg-sky-400/5"
                      : "border-kumo-line",
                  )}
                >
                  <span className="font-mono text-kumo-default">{short(w.address.value)}</span>
                  <div className="flex items-center overflow-hidden rounded border border-kumo-line">
                    <RoleSeg tone="maker" active={w.cohort === "maker"} disabled={!!busyId} onClick={() => setRole(w, "maker")}>挂</RoleSeg>
                    <RoleSeg tone="taker" active={w.cohort === "taker"} disabled={!!busyId} onClick={() => setRole(w, "taker")}>吃</RoleSeg>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 配对：挂单 / 吃单各选一个，添加后进「已有」 */}
          <span className="pt-1.5 text-xs text-kumo-subtle">配对</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={makerOpt}
              onChange={(e) => setSelMaker(e.target.value)}
              className="h-7 rounded-md border border-kumo-line bg-kumo-base px-1.5 text-xs text-kumo-default"
            >
              <option value="">挂单钱包…</option>
              {makers.map((w) => <option key={w.id} value={w.id}>{short(w.address.value)}</option>)}
            </select>
            <span className="text-xs text-kumo-subtle">↔</span>
            <select
              value={takerOpt}
              onChange={(e) => setSelTaker(e.target.value)}
              className="h-7 rounded-md border border-kumo-line bg-kumo-base px-1.5 text-xs text-kumo-default"
            >
              <option value="">吃单钱包…</option>
              {takers.map((w) => <option key={w.id} value={w.id}>{short(w.address.value)}</option>)}
            </select>
            <Button size="xs" variant="secondary" disabled={!makerOpt || !takerOpt} onClick={addPair}>添加</Button>
          </div>

          {pairs.length > 0 && (
            <>
              <span className="pt-1 text-xs text-kumo-subtle">已有</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {pairs.map((p) => {
                  const m = byId.get(p.makerId);
                  const t = byId.get(p.takerId);
                  return (
                    <div key={p.id} className="flex items-center gap-1 rounded-md border border-kumo-line px-1.5 py-0.5 text-xs">
                      <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
                      <span className="font-mono text-kumo-default">{m ? short(m.address.value) : "已移除"}</span>
                      <span className="text-kumo-subtle">↔</span>
                      <span aria-hidden className="size-1.5 rounded-full bg-sky-500" />
                      <span className="font-mono text-kumo-default">{t ? short(t.address.value) : "已移除"}</span>
                      <button
                        type="button"
                        onClick={() => manualPairs.remove(p.id)}
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
