"use client";

// =============================================================================
// ASH 交易品种切换器。
//
// 品种清单来自 /api/nado/catalog（服务端合并 Nado archive 的 symbols + 24h 成交量），
// 已按 24h 名义成交额倒序。分类 Tab 只有加密货币 / 股票（大宗商品期货与外汇已下线），
// 另外把 maker 有倍数奖励（Nado boosted）的品种单独做成一个分类。
// 选中后点保存 = POST /api/ash/symbols，ASH 立即重订阅行情（不重启进程）。
// =============================================================================
import { useEffect, useMemo, useState } from "react";
import {
  Badge, Banner, Button, ButtonGroup, Empty, Input, Text,
} from "@cloudflare/kumo";
import { CoinsIcon, StarIcon, WarningCircleIcon } from "@phosphor-icons/react";
import {
  CATEGORY_LABELS, CATEGORY_ORDER, formatVolume,
} from "../lib/nadoCatalog";
import type { NadoCatalogItem, NadoCategory } from "../lib/nadoCatalog";

/** 分类 Tab：四个资产类别 + maker 倍数（跨类别的视图）。 */
type Tab = NadoCategory | "all" | "boosted";

const MAX_SYMBOLS = 12;

const TAB_LABELS: Record<Tab, string> = {
  all: "全部",
  boosted: "⭐ maker 倍数",
  ...CATEGORY_LABELS,
};

function statusBadge(item: NadoCatalogItem) {
  if (item.tradingStatus === "not_tradable") return <Badge variant="secondary">不可交易</Badge>;
  if (item.tradingStatus === "post_only") return <Badge variant="warning">仅挂单</Badge>;
  if (item.marketOpen === false) return <Badge variant="secondary">休市</Badge>;
  return null;
}

export function AshSymbolPicker({
  current,
  onSaved,
}: {
  current: string[];
  onSaved: (symbols: string[]) => void;
}) {
  const [items, setItems] = useState<NadoCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>(current);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [okAt, setOkAt] = useState<number | null>(null);

  // 目录只在打开面板时拉一次（服务端有 60 秒缓存）
  useEffect(() => {
    let stopped = false;
    setLoading(true);
    fetch("/api/nado/catalog", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { items?: NadoCatalogItem[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!stopped) { setItems(body.items ?? []); setLoadError(null); }
      })
      .catch((e: unknown) => { if (!stopped) setLoadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, []);

  // 当前运行品种变化（保存成功 / 页面刷新）时同步勾选状态。
  // 按内容比较：/ash 页每 3 秒轮询，引用每次都变，不能直接把用户的勾选冲掉。
  const currentKey = current.join(",");
  useEffect(() => { setSelected(currentKey ? currentKey.split(",") : []); }, [currentKey]);

  const counts = useMemo(() => {
    const out: Record<Tab, number> = {
      all: items.length, boosted: 0, crypto: 0, stock: 0, commodity: 0, forex: 0,
    };
    for (const it of items) {
      out[it.category] = (out[it.category] ?? 0) + 1;
      if (it.boosted) out.boosted = (out.boosted ?? 0) + 1;
    }
    return out;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    return items.filter((it) => {
      if (tab === "boosted" && !it.boosted) return false;
      if (tab !== "all" && tab !== "boosted" && it.category !== tab) return false;
      if (q && !it.symbol.includes(q)) return false;
      return true;
    });
  }, [items, tab, query]);

  const toggle = (symbol: string) => {
    setOkAt(null);
    setSaveError(null);
    setSelected((prev) => {
      if (prev.includes(symbol)) return prev.filter((s) => s !== symbol);
      if (prev.length >= MAX_SYMBOLS) return prev;
      return [...prev, symbol];
    });
  };

  const save = async () => {
    setSaveError(null);
    setOkAt(null);
    if (!selected.length) { setSaveError("至少要选一个交易品种"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/ash/symbols", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbols: selected }),
      });
      const body = (await res.json()) as { ok?: boolean; symbols?: string[]; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      onSaved(body.symbols ?? selected);
      setOkAt(Date.now());
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ButtonGroup aria-label="品种分类">
          {(["all", "boosted", ...CATEGORY_ORDER] as Tab[]).map((t) => (
            <Button
              key={t}
              size="xs"
              variant={tab === t ? "primary" : "secondary"}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]} {counts[t] ?? 0}
            </Button>
          ))}
        </ButtonGroup>
        <div className="min-w-48 flex-1">
          <Input
            size="sm"
            placeholder="搜索品种，例如 BTC / NVDA / SPCX"
            aria-label="搜索品种"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Text variant="secondary" size="xs">
          已选 {selected.length}/{MAX_SYMBOLS}：
        </Text>
        {selected.length === 0 ? (
          <Text variant="secondary" size="xs">还没选品种</Text>
        ) : selected.map((s) => (
          <button key={s} type="button" onClick={() => toggle(s)} title="点击移除">
            <Badge variant="primary" className="bg-kumo-brand text-kumo-inverse">{s} ✕</Badge>
          </button>
        ))}
      </div>

      {loadError && (
        <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} description={`读取 Nado 品种目录失败：${loadError}`} />
      )}

      <div className="max-h-80 overflow-y-auto rounded-lg border border-kumo-line">
        {loading ? (
          <div className="p-3"><Text variant="secondary" size="xs">读取 Nado 品种目录…</Text></div>
        ) : visible.length === 0 ? (
          <Empty size="sm" icon={<CoinsIcon size={28} className="text-kumo-inactive" />} title="没有匹配的品种" />
        ) : (
          visible.map((it) => {
            const picked = selected.includes(it.symbol);
            const blocked = it.tradingStatus === "not_tradable";
            const full = !picked && selected.length >= MAX_SYMBOLS;
            const disabled = blocked || full;
            return (
              <button
                key={it.symbol}
                type="button"
                role="option"
                aria-selected={picked}
                disabled={disabled}
                onClick={() => toggle(it.symbol)}
                className={`flex w-full items-center gap-2 border-b border-kumo-line px-3 py-2 text-left text-sm last:border-b-0 ${
                  picked ? "bg-kumo-brand text-kumo-inverse" : disabled ? "opacity-45" : "hover:bg-kumo-canvas"
                }`}
              >
                <span className={`min-w-24 font-mono ${picked ? "font-semibold" : ""}`}>{it.symbol}</span>
                <span className={`w-16 shrink-0 text-xs ${picked ? "opacity-80" : "text-kumo-subtle"}`}>
                  {CATEGORY_LABELS[it.category]}
                </span>
                <span className="w-24 shrink-0 text-xs tabular-nums">
                  {formatVolume(it.volume24h)}
                </span>
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  {it.boosted ? (
                    <Badge variant="success">
                      <StarIcon size={12} weight="fill" /> maker ×{it.makerMultiplier}
                    </Badge>
                  ) : null}
                  {statusBadge(it)}
                </span>
                <span className={`shrink-0 text-xs tabular-nums ${picked ? "opacity-80" : "text-kumo-subtle"}`}>
                  {it.price > 0 ? it.price.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
                </span>
              </button>
            );
          })
        )}
      </div>

      <Text variant="secondary" size="xs">
        按 24h 名义成交额排序（Nado 索引器）。⭐ maker 倍数 = 该品种挂单成交有额外奖励倍数，
        适合 maker 入场。不可交易 / 休市的品种不能选。
      </Text>

      {saveError && (
        <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} description={saveError} />
      )}

      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" disabled={saving || !selected.length} onClick={() => void save()}>
          {saving ? "切换中…" : "保存并立即生效"}
        </Button>
        {okAt ? <Text variant="secondary" size="xs">已切换（{new Date(okAt).toLocaleTimeString()}），行情订阅已更新</Text> : null}
      </div>
    </div>
  );
}
