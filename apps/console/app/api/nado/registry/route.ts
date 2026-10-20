// =============================================================================
// /api/nado/registry — 注册结果登记表（只读）。
// GET            ：按地址倒序列出所有钱包的注册 / 检查结果
// GET ?address=  ：取单个钱包的结果（与钱包一一对应）
// 数据只含地址、用户名与状态；私钥从不写入。只允许本机访问。
// =============================================================================
import { NextResponse } from "next/server";
import { getRegistryEntry, listRegistry } from "../../../lib/nadoRegistry";
import { isLocalRequest } from "../../../lib/localRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "only localhost may read the registry" }, { status: 403 });
  const address = (new URL(req.url).searchParams.get("address") ?? "").trim();
  if (address) {
    if (!ADDRESS_RE.test(address)) return NextResponse.json({ error: "invalid address" }, { status: 400 });
    return NextResponse.json({ entry: await getRegistryEntry(address) });
  }
  return NextResponse.json({ entries: await listRegistry() });
}
