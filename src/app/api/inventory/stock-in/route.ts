import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DbError = { code?: string; message?: string } | null;

/**
 * 判斷是否為「schema 尚未就緒」：
 * - 42P01 表不存在（M2 SQL 未執行）
 * - 欄位不存在（receipts 尚缺 receipt_type/store_id，同樣是 M2 未執行）
 * 兩者都降級提示用戶執行 M2，而不是報 500。
 */
function isSchemaNotReady(err: DbError): boolean {
  if (!err) return false;
  if (err.code === "42P01") return true;
  const m = err.message ?? "";
  if (/relation .* does not exist/i.test(m)) return true;
  if (/column .* does not exist/i.test(m)) return true;
  if (/could not find the .* column/i.test(m)) return true;
  return false;
}

type StockInItem = {
  name: string;
  unitPrice: number;
  quantity: number;
  unit?: string;
  productKey?: string;
};

function normalizeKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 入貨登記（POS 側，對應 M2.5 選項 A）。
 * 寫入：
 *   receipts(receipt_type='stock_in', store_id, receipt_date, total_amount)
 *   receipt_items（每一項入貨品，product_key 對映 inv_products）
 *   inv_products（不存在則新增；存在則 current_qty += 數量、unit_cost 重算加權平均）
 *   inv_stock_movements(movement_type='in', reference_type='receipt')
 * 全部以 store_id = merchantId 歸屬，店別隔離。
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const storeId = String(body.storeId ?? "");
  if (!storeId) return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });

  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const rawItems = Array.isArray(body.items) ? (body.items as unknown[]) : [];
  if (rawItems.length === 0) return NextResponse.json({ ok: false, error: "入貨明細不可為空" }, { status: 400 });

  const items: StockInItem[] = [];
  for (const it of rawItems) {
    const o = it as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    const unitPrice = Number(o.unitPrice);
    const quantity = Number(o.quantity);
    if (!name) return NextResponse.json({ ok: false, error: "每項入貨品必須有品名" }, { status: 400 });
    if (!(unitPrice > 0)) return NextResponse.json({ ok: false, error: `「${name}」單價必須大於 0` }, { status: 400 });
    if (!(quantity > 0)) return NextResponse.json({ ok: false, error: `「${name}」數量必須大於 0` }, { status: 400 });
    items.push({
      name,
      unitPrice,
      quantity,
      unit: o.unit ? String(o.unit) : undefined,
      productKey: o.productKey ? String(o.productKey) : undefined,
    });
  }

  const date = body.date ? String(body.date) : new Date().toISOString().slice(0, 10);
  const supplier = body.supplier ? String(body.supplier).trim() : null;
  const note = body.note ? String(body.note).trim() : null;

  const total = Math.round(items.reduce((s, it) => s + it.unitPrice * it.quantity, 0) * 100) / 100;

  // 1) receipts（stock_in）
  const { data: receipt, error: rErr } = await client
    .from("receipts")
    .insert({
      receipt_type: "stock_in",
      store_id: storeId,
      receipt_date: date,
      total_amount: total,
      category: supplier || "入貨",
      raw_ocr_data: note ? { note } : null,
    })
    .select("id")
    .single();
  if (rErr) {
    if (isSchemaNotReady(rErr))
      return NextResponse.json({ ok: false, schemaReady: false, error: "receipts 表/欄位尚未建立，請執行 M2 遷移 SQL" });
    return NextResponse.json({ ok: false, error: rErr.message }, { status: 500 });
  }
  const receiptId = receipt.id;

  const receiptItemsInsert: Array<Record<string, unknown>> = [];
  const movementsInsert: Array<Record<string, unknown>> = [];

  for (const it of items) {
    const key = (it.productKey && it.productKey.trim()) || normalizeKey(it.name);
    const unit = it.unit || "unit";

    // 2) inv_products upsert（加權平均單價）
    const { data: existing } = await client
      .from("inv_products")
      .select("id, unit_cost, current_qty, unit")
      .eq("store_id", storeId)
      .eq("product_key", key)
      .maybeSingle();

    let productId: string;
    if (existing) {
      const oldQty = Number(existing.current_qty || 0);
      const oldCost = Number(existing.unit_cost || 0);
      const newQty = oldQty + it.quantity;
      const newCost =
        newQty > 0
          ? Math.round(((oldQty * oldCost + it.quantity * it.unitPrice) / newQty) * 100) / 100
          : it.unitPrice;
      const { data: upd, error: uErr } = await client
        .from("inv_products")
        .update({ current_qty: newQty, unit_cost: newCost, unit: existing.unit || unit, name: it.name })
        .eq("id", existing.id)
        .select("id")
        .single();
      if (uErr) return NextResponse.json({ ok: false, error: uErr.message }, { status: 500 });
      productId = upd.id;
    } else {
      const { data: ins, error: iErr } = await client
        .from("inv_products")
        .insert({
          store_id: storeId,
          name: it.name,
          product_key: key,
          unit,
          unit_cost: it.unitPrice,
          current_qty: it.quantity,
          reorder_level: 0,
        })
        .select("id")
        .single();
      if (iErr) return NextResponse.json({ ok: false, error: iErr.message }, { status: 500 });
      productId = ins.id;
    }

    receiptItemsInsert.push({
      receipt_id: receiptId,
      name: it.name,
      unit_price: it.unitPrice,
      quantity: it.quantity,
      product_key: key,
      is_stock_item: true,
    });
    movementsInsert.push({
      store_id: storeId,
      product_id: productId,
      movement_type: "in",
      reference_type: "receipt",
      reference_id: receiptId,
      quantity: it.quantity,
      unit_cost: it.unitPrice,
      movement_date: date,
    });
  }

  // 3) receipt_items（total_price 為 generated column，不寫入）
  const { error: riErr } = await client.from("receipt_items").insert(receiptItemsInsert);
  if (riErr) {
    if (isSchemaNotReady(riErr))
      return NextResponse.json({ ok: false, schemaReady: false, error: "receipt_items 表尚未建立，請執行 M2 遷移 SQL" });
    return NextResponse.json({ ok: false, error: riErr.message }, { status: 500 });
  }

  // 4) inv_stock_movements
  const { error: mvErr } = await client.from("inv_stock_movements").insert(movementsInsert);
  if (mvErr) {
    if (isSchemaNotReady(mvErr))
      return NextResponse.json({ ok: false, schemaReady: false, error: "inv_stock_movements 表尚未建立，請執行 M2 遷移 SQL" });
    return NextResponse.json({ ok: false, error: mvErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, receiptId, total, items: items.length });
}
