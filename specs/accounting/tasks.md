# Accounting 接入真实成交 — 任务清单（Tasks）

> 依赖：[spec.md](./spec.md)。按顺序执行；每完成一项把状态改为 `[x]`。

## T1 扩展共享汇总层
- [x] `packages/ui/src/accounting.ts`
  - `AccountingRecord` 增加可选字段 `id / price / size / realizedPnl / taker`
  - `Rollup` 增加 `buyFees / sellFees / pnl / wear`
  - `emptyAgg` / `add` / `rollup`：`wear = fees − pnl`
  - `toCsv` 表头与新列同步：`wallet,orders,volume,buys,sells,buyFees,sellFees,fees,pnl,wear`
- 验收：`tsc` 通过；`bulk.ts` 未改动仍能编译

## T2 服务端落库 API
- [x] 新建 `apps/console/app/api/accounting/route.ts`
  - `runtime = "nodejs"`；存储 `apps/console/.data/accounting.json`
  - `GET` 返回全量、`POST` 按 `id` 去重追加（上限 20000）、`DELETE` 清空
  - 读写 try/catch，失败返回 `{ ok:false, error }`
- 验收：`curl GET/POST/DELETE` 正常；文件损坏时回退空数组

## T3 新建成交账本
- [x] 新建 `apps/console/app/lib/accountingLedger.ts`
  - `setWalletIndex` / `setMarketIndex` / `record` / `reset` / `subscribe` / `version` / `ready`
  - 启动 `GET /api/accounting` 回放记录，重建去重集合与 FIFO 队列
  - fill 帧解析 + 去重键 + X18 归一化（`|v| >= 1e12` 除以 1e18）
  - 按 `walletId|market` 的 FIFO 已实现盈亏
  - 300ms 防抖 `POST /api/accounting` 批量落库；失败保留重试
  - 内存上限 5000 条
- 验收：`accountingLedger.test.ts` 覆盖平多/平空/开仓、去重、缺字段跳过、单位归一化

## T4 WS 事件补字段
- [x] `apps/console/app/lib/liveStream.ts`
  - `LiveEvent` 增加 `productId / price / size / fee / isTaker / isBid`
  - `onmessage` 解析赋值；协议与重连不变

## T5 页面接线
- [x] `apps/console/app/page.tsx`
  - 配置变化时写入 wallet / market 索引
  - `onEvent` 中 `type === "fill"` → `accountingLedger.record(e.raw, e.ts)`
  - `AccountingView` 去掉 `records` 入参
- 验收：既有勾选 / Shift 连选 / Cohort / 余额读取逻辑未改

## T6 弹窗界面
- [x] `apps/console/app/components/AccountingView.tsx`
  - 改为订阅账本（`version` 驱动重算）
  - KPI：Orders / Volume / Buy・Sell；Buy fees / Sell fees / Fees (ex-PnL) / Realized PnL；Wear
  - 汇总表新增 Buy fees / Sell fees / PnL / Wear 列
  - 空态文案 + Reset ledger 按钮
- 验收：`records.length === 0` 时展示空态且导出按钮禁用

## T7 测试与静态检查
- [x] 更新 `packages/ui/src/accounting.test.ts`
- [x] 新增 `apps/console/app/lib/accountingLedger.test.ts`
- [x] `node node_modules/typescript/bin/tsc --noEmit -p apps/console/tsconfig.json`
- [x] `node node_modules/vitest/vitest.mjs run --reporter=dot`

## T8 浏览器验证
- [x] 在 `127.0.0.1:18270` 跑一轮自成交
- [x] 打开 Accounting：Orders / Volume / Buy・Sell fees / PnL / Wear 非 0
- [x] 导出 CSV 含新列；刷新后数据仍在（服务端）；Reset 清空后刷新仍为空

## T9 变更记录
- [x] 写入 `../CHANGELOG.md`（倒序、含需求/排查/改动/涉及文件/验证）
