import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DbError = { code?: string; message?: string } | null;

function isMissingTable(err: DbError): boolean {
  if (!err) return false;
  if (err.code === "42P01") return true;
  return /relation .* does not exist/i.test(err.message ?? "");
}

type ProductInput = {
  store_id: string;
  name: string;
  unit: string;
  unit_cost: number;
  current_qty: number;
  reorder_level: number;
  product_key: string | null;
  sku: string | null;
};

/** 庫存主檔 CRUD（店別 scope = storeId）。inv_products 由 POS「庫存」Tab 擁有。 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId");
  if (!storeId) return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });

  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const { data, error } = await client
    .from("inv_products")
    .select("*")
    .eq("store_id", storeId)
    .order("name");
  if (error) {
    if (isMissingTable(error)) return NextResponse.json({ ok: true, schemaReady: false, products: [] });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, schemaReady: true, products: data ?? [] });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const storeId = String(body.storeId ?? "");
  if (!storeId) return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });

  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "品名必填" }, { status: 400 });

  const input: ProductInput = {
    store_id: storeId,
    name,
    unit: String(body.unit ?? "") || "unit",
    unit_cost: Number(body.unit_cost ?? 0),
    current_qty: Number(body.current_qty ?? 0),
    reorder_level: Number(body.reorder_level ?? 0),
    product_key: body.product_key ? String(body.product_key) : null,
    sku: body.sku ? String(body.sku) : null,
  };

  const { data, error } = await client.from("inv_products").insert(input).select("*").single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, product: data });
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(body.id ?? "");
  const storeId = String(body.storeId ?? "");
  if (!id || !storeId) return NextResponse.json({ ok: false, error: "缺少 id/storeId" }, { status: 400 });

  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = String(body.name);
  if (body.unit !== undefined) patch.unit = String(body.unit);
  if (body.unit_cost !== undefined) patch.unit_cost = Number(body.unit_cost);
  if (body.current_qty !== undefined) patch.current_qty = Number(body.current_qty);
  if (body.reorder_level !== undefined) patch.reorder_level = Number(body.reorder_level);
  if (body.product_key !== undefined) patch.product_key = body.product_key ? String(body.product_key) : null;
  if (body.sku !== undefined) patch.sku = body.sku ? String(body.sku) : null;

  const { data, error } = await client
    .from("inv_products")
    .update(patch)
    .eq("id", id)
    .eq("store_id", storeId)
    .select("*")
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, product: data });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const storeId = searchParams.get("storeId");
  if (!id || !storeId) return NextResponse.json({ ok: false, error: "缺少 id/storeId" }, { status: 400 });

  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const { error } = await client.from("inv_products").delete().eq("id", id).eq("store_id", storeId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
