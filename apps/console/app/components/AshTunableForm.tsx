"use client";

// =============================================================================
// ASH 策略调参表单（风险 / 执行 / 信号 三组）。
//
// 交互约定：
//   • 输入框里存的是文本，提交时才转成数字，避免输入 "0." 这类中间态被打回；
//   • 三档止盈单独渲染，实时显示合计（必须 100%），不足/超出直接禁用保存；
//   • 保存 = POST /api/ash/config，ASH 侧边校验边生效（不重启进程）。
// =============================================================================
import { useEffect, useMemo, useState } from "react";
import { Banner, Button, ButtonGroup, Input, Switch, Text } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { AshTunables } from "../lib/ashTypes";
import { TP_PATH, TUNABLE_GROUPS } from "../lib/ashTunableFields";

/** 按 "a.b.c" 读嵌套字段。 */
function readPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node == null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, obj);
}

/** 按 "a.b.c" 写嵌套字段（中间层不存在时补一个空对象）。 */
function writePath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop() as string;
  let node = obj;
  for (const key of keys) {
    if (node[key] == null || typeof node[key] !== "object") node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[last] = value;
}

interface Draft {
  numbers: Record<string, string>;
  bools: Record<string, boolean>;
  enums: Record<string, string>;
  tp: [string, string, string];
}

function draftFrom(t: AshTunables): Draft {
  const numbers: Record<string, string> = {};
  const bools: Record<string, boolean> = {};
  const enums: Record<string, string> = {};
  for (const group of TUNABLE_GROUPS) {
    for (const f of group.numbers) numbers[f.path] = String(readPath(t, f.path) ?? "");
    for (const f of group.bools) bools[f.path] = Boolean(readPath(t, f.path));
    for (const f of group.enums) enums[f.path] = String(readPath(t, f.path) ?? "");
  }
  const rawTp = readPath(t, TP_PATH);
  const tp = Array.isArray(rawTp) ? rawTp : [0.4, 0.3, 0.3];
  // 页面按百分比展示（40 / 30 / 30），提交时再除回 100
  const asPct = (v: unknown) => String(Math.round(Number(v) * 100 * 1000) / 1000);
  return { numbers, bools, enums, tp: [asPct(tp[0]), asPct(tp[1]), asPct(tp[2])] };
}

/** 草稿 → 提交给 ASH 的 patch；数字解析失败时返回错误文案。 */
function patchFrom(draft: Draft): { patch: Record<string, unknown> } | { error: string } {
  const patch: Record<string, unknown> = {};
  for (const group of TUNABLE_GROUPS) {
    for (const f of group.numbers) {
      const text = (draft.numbers[f.path] ?? "").trim();
      const n = Number(text);
      if (!text || !Number.isFinite(n)) return { error: `${f.label} 不是合法数字` };
      if (n < f.min || n > f.max) return { error: `${f.label} 必须在 ${f.min} ~ ${f.max} 之间` };
      writePath(patch, f.path, n);
    }
    for (const f of group.bools) writePath(patch, f.path, draft.bools[f.path] === true);
    for (const f of group.enums) writePath(patch, f.path, draft.enums[f.path]);
  }
  const tp = draft.tp.map((v) => Number(v) / 100);
  if (tp.some((v) => !(v > 0))) return { error: "三档止盈的每个比例都要大于 0" };
  if (Math.abs(tp.reduce((a, b) => a + b, 0) - 1) > 1e-6) return { error: "三档止盈合计必须等于 100%" };
  writePath(patch, TP_PATH, tp);
  return { patch };
}

export function AshTunableForm({
  tunables,
  onSaved,
}: {
  tunables: AshTunables;
  onSaved: (next: AshTunables) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(tunables));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okAt, setOkAt] = useState<number | null>(null);

  // 后端值真的变了（切页刷新 / 别处改过）才重置草稿；
  // 按内容比较，避免 /ash 页每 3 秒轮询把用户正在输入的内容冲掉。
  const tunablesKey = JSON.stringify(tunables);
  useEffect(() => { setDraft(draftFrom(tunables)); }, [tunablesKey]);

  const tpSum = useMemo(
    () => draft.tp.reduce((a, v) => a + (Number(v) || 0), 0),
    [draft.tp],
  );
  const tpValid = Math.abs(tpSum - 100) < 1e-6;

  const setNumber = (path: string, value: string) =>
    setDraft((d) => ({ ...d, numbers: { ...d.numbers, [path]: value } }));
  const setBool = (path: string, value: boolean) =>
    setDraft((d) => ({ ...d, bools: { ...d.bools, [path]: value } }));
  const setEnum = (path: string, value: string) =>
    setDraft((d) => ({ ...d, enums: { ...d.enums, [path]: value } }));
  const setTp = (index: number, value: string) =>
    setDraft((d) => {
      const tp = [...d.tp] as [string, string, string];
      tp[index] = value;
      return { ...d, tp };
    });

  const save = async () => {
    setError(null);
    setOkAt(null);
    const built = patchFrom(draft);
    if ("error" in built) { setError(built.error); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/ash/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(built.patch),
      });
      const body = (await res.json()) as { ok?: boolean; tunables?: AshTunables; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.tunables) onSaved(body.tunables);
      setOkAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {TUNABLE_GROUPS.map((group) => (
        <section key={group.key} className="flex flex-col gap-3 rounded-lg border border-kumo-line p-3">
          <div className="flex flex-col gap-0.5">
            <Text variant="heading" as="h3">{group.title}</Text>
            <Text variant="secondary" size="xs">{group.hint}</Text>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.numbers.map((f) => (
              <Input
                key={f.path}
                size="sm"
                type="number"
                inputMode="decimal"
                step={f.step}
                min={f.min}
                max={f.max}
                label={f.unit ? `${f.label}（${f.unit}）` : f.label}
                description={f.hint}
                value={draft.numbers[f.path] ?? ""}
                onChange={(e) => setNumber(f.path, e.target.value)}
              />
            ))}
          </div>

          {group.enums.length > 0 && (
            <div className="flex flex-wrap gap-4">
              {group.enums.map((f) => (
                <div key={f.path} className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">{f.label}</span>
                  <ButtonGroup aria-label={f.label}>
                    {f.options.map((o) => (
                      <Button
                        key={o.value}
                        size="xs"
                        variant={draft.enums[f.path] === o.value ? "primary" : "secondary"}
                        aria-pressed={draft.enums[f.path] === o.value}
                        onClick={() => setEnum(f.path, o.value)}
                      >
                        {o.label}
                      </Button>
                    ))}
                  </ButtonGroup>
                </div>
              ))}
            </div>
          )}

          {group.bools.length > 0 && (
            <div className="flex flex-col gap-2">
              {group.bools.map((f) => (
                <div key={f.path} className="flex flex-col gap-0.5">
                  <Switch
                    label={f.label}
                    checked={draft.bools[f.path] === true}
                    onCheckedChange={(checked) => setBool(f.path, checked === true)}
                  />
                  {f.hint ? <Text variant="secondary" size="xs">{f.hint}</Text> : null}
                </div>
              ))}
            </div>
          )}

          {/* 三档止盈：单独一行，实时显示合计 */}
          {group.key === "execution" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">三档止盈比例</span>
                <span className={`text-xs tabular-nums ${tpValid ? "text-kumo-subtle" : "text-kumo-danger"}`}>
                  合计 {tpSum.toFixed(1)}%
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {draft.tp.map((v, i) => (
                  <Input
                    key={i}
                    size="sm"
                    type="number"
                    inputMode="decimal"
                    step={1}
                    min={0}
                    max={100}
                    label={`TP${i + 1}`}
                    value={v}
                    onChange={(e) => setTp(i, e.target.value)}
                  />
                ))}
              </div>
              <Text variant="secondary" size="xs">
                三项合计必须 100%；比例按开仓数量拆分，最后一档吃掉剩余仓位。
              </Text>
            </div>
          )}
        </section>
      ))}

      {error && (
        <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} description={error} />
      )}

      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" disabled={saving || !tpValid} onClick={() => void save()}>
          {saving ? "保存中…" : "保存并立即生效"}
        </Button>
        {okAt ? <Text variant="secondary" size="xs">已生效（{new Date(okAt).toLocaleTimeString()}），无需重启</Text> : null}
      </div>
    </div>
  );
}
