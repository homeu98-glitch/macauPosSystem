import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import {
  buildReceiptItems,
  resolveExpenseUserId,
  resolveMerchantId,
  type InventoryReceiptInput,
} from "@/lib/expense-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 更新收據（mirror save-receipt 的 update 路徑）：表頭欄位 + 合併 raw_ocr_data；
 * 若帶 items 則先刪後插（整批取代），實現品項的新增/修改/刪除。
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const body = (await request.json()) as InventoryReceiptInput;
  const resolved = await resolveExpenseUserId(client, body.account ?? null);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  let merchantId: string | null = typeof body.merchant_id === "string" && body.merchant_id ? body.merchant_id : null;
  if (!merchantId && body.merchant_name) {
    const m = await resolveMerchantId(client, userId, { merchant_name: body.merchant_name });
    if ("error" in m) return NextResponse.json({ ok: false, error: m.error }, { status: m.status });
    merchantId = m.merchantId;
  }

  const update: Record<string, unknown> = {};
  if (body.total_amount !== undefined) update.total_amount = Number(body.total_amount) || 0;
  if (body.date) update.receipt_date = body.date;
  if (merchantId) update.merchant_id = merchantId;

  const raw: Record<string, unknown> = {};
  if (body.receipt_number !== undefined) raw.receipt_number = body.receipt_number || null;
  if (body.payment_method) raw.payment_method = body.payment_method;
  if (body.payment_status) raw.payment_status = body.payment_status;
  if (Object.keys(raw).length > 0) {
    const { data: cur } = await client.from("receipts").select("raw_ocr_data").eq("id", id).eq("user_id", userId).maybeSingle();
    update.raw_ocr_data = { ...(cur?.raw_ocr_data ?? {}), ...raw };
  }

  const { error: uErr } = await client.from("receipts").update(update).eq("id", id).eq("user_id", userId);
  if (uErr) return NextResponse.json({ ok: false, error: uErr.message }, { status: 500 });

  if (Array.isArray(body.items)) {
    const { error: dErr } = await client.from("receipt_items").delete().eq("receipt_id", id);
    if (dErr) return NextResponse.json({ ok: false, error: dErr.message }, { status: 500 });
    const itemRows = buildReceiptItems(id, userId, body.items);
    if (itemRows.length > 0) {
      const { error: iErr } = await client.from("receipt_items").insert(itemRows);
      if (iErr) return NextResponse.json({ ok: false, error: iErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const account = new URL(request.url).searchParams.get("account");
  const resolved = await resolveExpenseUserId(client, account);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  const { error: dItemsErr } = await client.from("receipt_items").delete().eq("receipt_id", id);
  if (dItemsErr) return NextResponse.json({ ok: false, error: dItemsErr.message }, { status: 500 });

  const { error } = await client.from("receipts").delete().eq("id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
