// =============================================================================
// 服务端成交账本落库（本地单机）：把浏览器 WS fill 账本持久化到 .data/accounting.json，
// 这样刷新页面 / 换浏览器后 Accounting 数据仍在。只做文件读写，不参与交易链路。
//   GET    -> { records: AccountingRecord[] }（按 ts 升序）
//   POST   -> { records: [...] } 批量追加，按 id 去重，上限 20000 条
//   DELETE -> 清空
// =============================================================================
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import type { AccountingRecord } from "@farm/ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RECORDS = 20_000;

function dataDir(): string {
  return path.join(process.cwd(), ".data");
}
function dataFile(): string {
  return path.join(dataDir(), "accounting.json");
}

/** 读取全部记录；文件不存在或损坏时回退为空数组。 */
async function readRecords(): Promise<AccountingRecord[]> {
  try {
    const raw = await fs.readFile(dataFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as AccountingRecord[];
    const inner = (parsed as { records?: unknown } | null)?.records;
    return Array.isArray(inner) ? (inner as AccountingRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeRecords(records: AccountingRecord[]): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(dataFile(), JSON.stringify({ records }), "utf8");
}

/** 记录的稳定去重键：优先用客户端算好的 id，缺失时用内容指纹兜底。 */
function dedupeKey(r: AccountingRecord): string {
  if (r.id) return r.id;
  return `${r.walletId}|${r.market}|${r.side}|${r.ts}|${r.price ?? ""}|${r.size ?? ""}|${r.fee}`;
}

export async function GET(): Promise<NextResponse> {
  try {
    const records = await readRecords();
    records.sort((a, b) => a.ts - b.ts);
    return NextResponse.json({ ok: true, records });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json()) as { records?: unknown };
    const incoming = Array.isArray(body?.records) ? (body.records as AccountingRecord[]) : [];
    const existing = await readRecords();
    const merged = new Map<string, AccountingRecord>();
    for (const r of existing) merged.set(dedupeKey(r), r);
    for (const r of incoming) {
      if (!r || typeof r !== "object") continue;
      merged.set(dedupeKey(r), r);
    }
    // 按 ts 升序保存，超出上限时保留最新的记录
    const all = [...merged.values()].sort((a, b) => a.ts - b.ts);
    const kept = all.length > MAX_RECORDS ? all.slice(all.length - MAX_RECORDS) : all;
    await writeRecords(kept);
    return NextResponse.json({ ok: true, total: kept.length });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE(): Promise<NextResponse> {
  try {
    await writeRecords([]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
