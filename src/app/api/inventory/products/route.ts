import { NextResponse } from "next/server";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { createProduct, listProducts, type InvProductInput } from "@/lib/inventory-products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/inventory/products?store=merchantId — 列出本店所有庫存品。 */
export async function GET(request: Request) {
  const macau = getSupabaseAdminClient();
  if (!macau) return NextResponse.json({ ok: false, error: "macau-pos supabase 未設定" }, { status: 503 });

  const store = new URL(request.url).searchParams.get("store");
  if (!store) return NextResponse.json({ ok: false, error: "缺少 store" }, { status: 400 });

  const result = await listProducts(macau, store);
  if ("error" in result) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, products: result.data });
}

/** POST /api/inventory/products — 新增庫存品。 */
export async function POST(request: Request) {
  const macau = getSupabaseAdminClient();
  if (!macau) return NextResponse.json({ ok: false, error: "macau-pos supabase 未設定" }, { status: 503 });

  const body = (await request.json().catch(() => null)) as (InvProductInput & { store?: string }) | null;
  const store = body?.store;
  if (!store) return NextResponse.json({ ok: false, error: "缺少 store" }, { status: 400 });

  const result = await createProduct(macau, store, {
    name: body?.name ?? "",
    category: body?.category ?? undefined,
    unit: body?.unit ?? undefined,
    reorder_level: body?.reorder_level ?? 0,
    note: body?.note ?? undefined,
  });
  if ("error" in result) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, product: result.data });
}