import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** 自动化日志落盘：面板里的日志只存在浏览器内存（40 行、刷新即丢），这里追加到
 *  `apps/console/.data/automation.log`，方便事后按时间线排查「报错 / 成交」的先后关系。
 *  纯文本、不参与交易逻辑，写失败不影响下单。 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DIR, "automation.log");
/** 超过这个大小就轮转一次，避免长期跑把磁盘写满。 */
const MAX_BYTES = 5 * 1024 * 1024;

/** GET：读取最近的日志（默认末尾 500 行），用于事后排查。 */
export async function GET(req: Request): Promise<Response> {
  try {
    const limit = Math.min(5000, Math.max(1, Number(new URL(req.url).searchParams.get("lines") ?? "500")));
    const raw = await readFile(FILE, "utf8").catch(() => "");
    const lines = raw.split("\n").filter(Boolean);
    return Response.json({ ok: true, total: lines.length, lines: lines.slice(-limit) });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** POST：追加若干行（每行前面补 UTC 时间戳）。 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { lines?: unknown };
    const lines = Array.isArray(body?.lines) ? body.lines.filter((l): l is string => typeof l === "string") : [];
    if (!lines.length) return Response.json({ ok: true, appended: 0 });
    await mkdir(DIR, { recursive: true });
    // 轮转：文件过大时保留最近一段，避免无限增长
    const size = await stat(FILE).then((s) => s.size).catch(() => 0);
    if (size > MAX_BYTES) {
      const old = await readFile(FILE, "utf8").catch(() => "");
      await writeFile(FILE, old.slice(-Math.floor(MAX_BYTES / 2)), "utf8");
    }
    const stamp = new Date().toISOString();
    await appendFile(FILE, lines.map((l) => `${stamp} ${l}`).join("\n") + "\n", "utf8");
    return Response.json({ ok: true, appended: lines.length });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
