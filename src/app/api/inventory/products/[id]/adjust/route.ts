import { NextResponse } from "next/server";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { adjustStock } from "@/lib/inventory-products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/inventory/products/[id]/adjust?store=merchantId — 盤點：設定新庫存量，記錄 adjust 異動。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const macau = getSupabaseAdminClient();
  if (!macau) return NextResponse.json({ ok: false, error: "macau-pos supabase 未設定" }, { status: 503 });

  const store = new URL(request.url).searchParams.get("store");
  if (!store) return NextResponse.json({ ok: false, error: "缺少 store" }, { status: 400 });

  const body = (await request.json().catch(() => null)) as { new_qty?: number; reason?: string } | null;
  if (!body) return NextResponse.json({ ok: false, error: "無效的 JSON" }, { status: 400 });

  const result = await adjustStock(macau, store, id, Number(body.new_qty), body.reason);
  if ("error" in result) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, product: result.data });
}