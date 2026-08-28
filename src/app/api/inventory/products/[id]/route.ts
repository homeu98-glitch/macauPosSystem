import { NextResponse } from "next/server";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { deleteProduct, updateProduct, type InvProductInput } from "@/lib/inventory-products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/inventory/products/[id]?store=merchantId — 修改庫存品 meta。 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const macau = getSupabaseAdminClient();
  if (!macau) return NextResponse.json({ ok: false, error: "macau-pos supabase 未設定" }, { status: 503 });

  const store = new URL(request.url).searchParams.get("store");
  if (!store) return NextResponse.json({ ok: false, error: "缺少 store" }, { status: 400 });

  const body = (await request.json().catch(() => null)) as InvProductInput | null;
  if (!body) return NextResponse.json({ ok: false, error: "無效的 JSON" }, { status: 400 });

  const result = await updateProduct(macau, store, id, body);
  if ("error" in result) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, product: result.data });
}

/** DELETE /api/inventory/products/[id]?store=merchantId — 刪除庫存品（cascade 刪 movements）。 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const macau = getSupabaseAdminClient();
  if (!macau) return NextResponse.json({ ok: false, error: "macau-pos supabase 未設定" }, { status: 503 });

  const store = new URL(request.url).searchParams.get("store");
  if (!store) return NextResponse.json({ ok: false, error: "缺少 store" }, { status: 400 });

  const result = await deleteProduct(macau, store, id);
  if ("error" in result) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}