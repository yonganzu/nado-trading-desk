# Accounting 接入真实成交 — 规格说明（Spec）

* 版本：2026-11-04（v2，已按用户选择修订）

* 状态：待批准

* 需求原话：「首页右上角的 accounting 功能貌似没有启动啊。你所有完成订单的交易量、手续费、盈亏以及排除盈亏的磨损，这些都要计算上，要把 accounting 界面利用起来，Orders, volume, buy /sell fees」

***

## 1. 现状与根因

1. [AccountingView.tsx](apps/console/app/components/AccountingView.tsx) 只读 `bulk.activity`；自成交引擎（Trading strategy）跑出来的成交完全不进账本 → 弹窗长期为 0。
2. [accounting.ts](packages/ui/src/accounting.ts) 的 `AccountingRecord` 只有 `notional / fee / status`，`Rollup` 只有 `orders/volume/buys/sells/fees`：没有 buy/sell 手续费拆分、没有盈亏、没有磨损。
3. [bulk.ts](apps/console/app/lib/bulk.ts) 的 `recordActivity` 在**下单时**就写一条记录，费率硬编码 `notional * 0.0003`，与实际成交无关。
4. [live-gateway.ts](packages/adapter-nado/src/live-gateway.ts) 的 `getFills()` 是空实现（REST 不提供成交）。
5. [page.tsx](apps/console/app/page.tsx#L94-L102) 已为全部 cohort subaccount 订阅公共 `fill` + `position_change`（单连接、免签名），`LiveEvent.raw` 保留完整帧 —— 这是唯一可靠的成交数据源。
6. 已安装的 `@nadohq/engine-client@0.58.0` 定义了 fill 帧字段（`src/types/serverSubscriptionEventTypes.ts` L80-95）：
   `type, product_id, timestamp, subaccount, order_digest, filled_qty, remaining_qty, original_qty, price, is_taker, is_bid, fee, submission_idx, appendix`。
   **没有 realized\_pnl** → 盈亏必须在本地计算。

## 2. 目标

* 账本只统计**已成交**的订单（fill），不统计已报未成的挂单。

* Accounting 弹窗展示并可按 wallet / cohort 汇总：

  * Orders（成交笔数）

  * Volume（名义额 Σ price × size）

  * 买入 / 卖出笔数

  * Buy fees / Sell fees（**分开**的手续费）

  * Realized PnL（已实现盈亏）

  * Fees（排除盈亏的成本，即纯手续费）

  * Wear（总磨损 = Fees − PnL）

* 数据源统一为公共 WS `fill` 流 → 本地账本 → 服务端落库 → 弹窗；bulk 与自成交引擎共用同一账本。

## 3. 计算口径（用户已确认）

| 指标              | 定义                                                       |
| --------------- | -------------------------------------------------------- |
| Orders          | 账本中 fill 记录条数（每个成交回执 1 条，按去重键去重）                         |
| Volume          | `Σ (price × size)`，人类小数 USDT0                            |
| Buy / Sell fees | `Σ fee`（`side === "buy"` / `"sell"`），fee 带符号（maker 返佣为负） |
| Fees            | `Σ fee`（= Buy fees + Sell fees），即**排除盈亏的纯成本**            |
| Realized PnL    | 逐笔 FIFO 平仓盈亏之和；开仓成交计 0；正=盈利，负=亏损                         |
| Wear（总磨损）       | `Fees − Realized PnL`（盈亏带符号：亏损时 pnl<0 → 磨损增大；盈利时抵扣磨损）    |

FIFO 规则（按 `walletId + market` 维护未平仓队列）：

* 买单：先平掉空头队列，`pnl += (空头开仓价 − 本次成交价) × 平掉数量`；剩余数量作为多头开仓入队。

* 卖单：先平掉多头队列，`pnl += (本次成交价 − 多头开仓价) × 平掉数量`；剩余数量作为空头开仓入队。

## 4. 实现设计

### 4.1 `packages/ui/src/accounting.ts`（扩展类型与汇总）

```ts
export interface AccountingRecord {
  id?: string;               // 去重键：subaccount|order_digest|timestamp|filled_qty
  walletId: string;
  accountName?: string;
  cohorts?: readonly string[];
  market: string;
  side: "buy" | "sell";
  price?: number;            // 成交价（人类小数）
  size?: number;             // 成交数量
  notional: number;          // price × size
  fee: number;               // Nado 回执手续费，带符号
  realizedPnl?: number;      // 本条平仓产生的已实现盈亏，开仓为 0
  taker?: boolean;           // 是否吃单
  status: string;
  ts: number;
}

export interface Rollup {
  key: string;
  orders: number;
  volume: number;
  buys: number;
  sells: number;
  buyFees: number;
  sellFees: number;
  fees: number;
  pnl: number;
  wear: number;       // fees − pnl
}
```

* 新字段全部可选：`bulk.ts` 现有 `activity.push({...})` 不改也能通过 `tsc`（用户规则：不动已完成功能）。

* `emptyAgg()` / `add()` 补齐 `buyFees/sellFees/pnl/wear`；`add` 内按 `side` 累加 buy/sell 手续费，`realizedPnl ?? 0` 累加 PnL，最后 `wear = fees − pnl`。

* CSV 头改为：`wallet,orders,volume,buys,sells,buyFees,sellFees,fees,pnl,wear`。

### 4.2 新建 `apps/console/app/lib/accountingLedger.ts`（单例账本）

```ts
export interface WalletMeta { walletId: string; accountName?: string; cohorts?: readonly string[] }

class AccountingLedger {
  readonly records: AccountingRecord[];
  setWalletIndex(entries: ReadonlyArray<{ subaccount: string; meta: WalletMeta }>): void;
  setMarketIndex(entries: ReadonlyArray<{ productId: number; market: string }>): void;
  record(frame: Record<string, unknown>, ts?: number): AccountingRecord | null; // 解析 fill 原始帧
  reset(): Promise<void>;
  subscribe(listener: () => void): () => void;
  version(): number; // 每次变更 +1，供 React 触发重渲染
  ready(): boolean;  // 首次从服务端加载完成
}
export const accountingLedger = new AccountingLedger();
```

* 启动时 `GET /api/accounting` 拉回服务端已落库的 `records`，用它们重建去重集合与 FIFO 队列（记录里已有 `side/price/size`，可安全重放），然后通知监听者。

* `record(frame)` 解析：`product_id → market`（`setMarketIndex` 优先，缺省 `product:#<id>`）；`subaccount → WalletMeta`（缺省用 subaccount 前 10 位作 walletId）；`is_bid === true` → `"buy"` 否则 `"sell"`；`filled_qty → size`、`price → price`、`fee → fee`、`is_taker → taker`。

* 单位归一化 `num(v)`：`Number(v)`；非有限值 → 0；`abs >= 1e12` 时按 X18 除以 `1e18`（兼容服务端 x18 与人类小数两种形态）。

* 去重键 `id = subaccount|order_digest|timestamp|filled_qty`；命中已存在（含服务端已回放的）则直接返回 `null`。

* FIFO 队列 `lots: Map<"walletId|market", { price, size, side }[]>`，按 §3 规则算 `realizedPnl`。

* 内存上限 5000 条（服务端保留全量，页面只渲染最近 5000）。

* 落库：新记录累积到待写队列，300ms 防抖后 `POST /api/accounting { records: [...] }`；失败则保留在队列里下次重试（不丢数据）。

* `reset()` 清空内存并发 `DELETE /api/accounting`，完成后通知监听者。

* `subscribe` 在 `record()` / 加载完成 / `reset()` 后通知监听者。

### 4.3 新建 `apps/console/app/api/accounting/route.ts`（服务端落库）

* `export const runtime = "nodejs"`。

* 存储文件：`path.join(process.cwd(), ".data", "accounting.json")`（Next dev 的 cwd 为 `apps/console`），自动创建目录；文件损坏时回退为空数组。

* `GET` → `{ records: AccountingRecord[] }`（全量，按 `ts` 升序）。

* `POST` → body `{ records: AccountingRecord[] }`；按 `id` 去重后追加；超过 20000 条时丢弃最旧；返回 `{ ok: true, total }`。

* `DELETE` → 清空文件，返回 `{ ok: true }`。

* 所有读写都 try/catch，失败返回 `{ ok: false, error }`，不影响页面交易。

### 4.4 `apps/console/app/lib/liveStream.ts`（补解析字段）

`LiveEvent` 增加可选字段并在 `ws.onmessage` 中赋值：`productId?: number; price?: string; size?: string; fee?: string; isTaker?: boolean; isBid?: boolean`。不改订阅协议与重连逻辑。

### 4.5 `apps/console/app/page.tsx`（接线）

* 新增 `useEffect`（依赖 `live.wallets / live.markets / live.products`）：调用 `accountingLedger.setWalletIndex(...)` 与 `accountingLedger.setMarketIndex(...)`。

* `openLiveStream.onEvent` 内：`if (e.type === "fill") accountingLedger.record(e.raw, e.ts);`（保留原有 `setLiveEvents` 与定向 reconcile）。

* `<AccountingView open={accountingOpen} onClose={...} />`：移除 `records={bulk.activity}` 入参。

* 不动勾选、Shift 连选、Cohort、余额读取等既有逻辑。

### 4.6 `apps/console/app/components/AccountingView.tsx`（界面）

* 组件签名改为 `{ open, onClose }`；内部 `useEffect` 订阅 `accountingLedger`（`version` 变化时重算 `rollup`）。

* KPI 三行（`Grid variant="4up"`）：

  1. Orders / Volume / Buy・Sell（笔数）
  2. Buy fees / Sell fees / Fees (ex-PnL) / Realized PnL
  3. Wear（总磨损 = Fees − PnL）

* `RollupTable` 列：`Cohort|Wallet, Orders, Volume, Buys, Sells, Buy fees, Sell fees, PnL, Wear`。

* 空态文案改为：「Run a trading strategy or bulk action — fills stream in live via WS.」

* 新增「Reset ledger」按钮（`accountingLedger.reset()`），与两个导出按钮同一行。

* CSV/JSON 导出沿用 `toCsv/toJson`（自动带新列）。

### 4.7 `apps/console/app/lib/bulk.ts`

不改。`recordActivity` 继续保留（历史行为），但 Accounting 不再读它。

## 5. 边界与兼容

* 只统计已成交的 fill；未成交挂单不计入 Orders / Volume / Fees。

* 同一笔成交可能因 WS 重连重复推送，靠去重键（客户端 + 服务端双层）消除。

* 若 fill 帧缺少 `price` 或 `filled_qty`，跳过该条（不写账本）。

* 服务端 `.data/accounting.json` 为本地单机落库；多标签页并发写由 `id` 去重兜底。

* 多空混合仓位的盈亏按 FIFO 近似，用于磨损评估足够。

## 6. 验证

1. `& "C:\Program Files\nodejs\node.exe" node_modules\typescript\bin\tsc --noEmit -p apps/console/tsconfig.json` 通过。
2. `& "C:\Program Files\nodejs\node.exe" node_modules\vitest\vitest.mjs run --reporter=dot` 全绿（含新增用例）。
3. 新增/更新测试：

   * `packages/ui/src/accounting.test.ts`：buy/sell 手续费拆分、PnL、wear、CSV 新表头。

   * `apps/console/app/lib/accountingLedger.test.ts`：FIFO 平仓盈亏（多→平、空→平）、去重键、单位归一化、缺字段跳过（用 stub 掉 fetch）。
4. 浏览器（`127.0.0.1:18270`）：跑一轮自成交 → 打开右上角 Accounting → Orders / Volume / Buy・Sell fees / PnL / Wear 均非 0；导出 CSV 含新列；**刷新页面后数据仍在**（来自服务端）；Reset 可清空并在刷新后仍为空。
5. 写入 `../CHANGELOG.md`（倒序，含需求/排查/改动/涉及文件/验证）。

## 7. 已确认决策

1. 磨损口径：`Wear = 手续费 − 已实现盈亏`；手续费单独展示为「排除盈亏的纯成本」。
2. 统计范围：只统计已成交（fill）。
3. 落库方式：服务端文件（`.data/accounting.json`），跨刷新/跨浏览器保留。
4. PnL 算法：本地 FIFO。

