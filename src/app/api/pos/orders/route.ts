import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!supabase) {
    return NextResponse.json({ ok: true, source: "mock", orders: [] });
  }

  const query = storeId
    ? supabase.from("pos_orders").select("*").eq("store_id", storeId).order("updated_at", { ascending: false }).limit(500)
    : supabase.from("pos_orders").select("*").order("updated_at", { ascending: false }).limit(500);
  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    source: "supabase",
    orders:
      data?.map((order) => ({
        id: order.id,
        localOrderNo: order.local_order_no,
        tableId: order.table_id,
        tableName: order.table_name,
        status: order.status,
        items: Array.isArray(order.items) ? order.items : [],
        orderNote: order.order_note ?? undefined,
        subtotal: Number(order.subtotal ?? 0),
        taxAmount: Number(order.tax_amount ?? 0),
        serviceChargeAmount: Number(order.service_charge_amount ?? 0),
        discountAmount: Number(order.discount_amount ?? 0),
        total: Number(order.total ?? 0),
        prepaidAmount: Number(order.prepaid_amount ?? 0),
        onlineOrderId: order.online_order_id ?? undefined,
        paymentMethod: order.payment_method ?? undefined,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
      })) ?? [],
  });
}

export async function DELETE(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  }

  // 無 Supabase（mock 模式）：本地由前端清，DB 無嘢要刪，當成功。
  if (!supabase) {
    return NextResponse.json({ ok: true, source: "mock", deleted: 0 });
  }

  // 只清「店內線下訂單」：online_order_id IS NULL。
  // exclude Ledger 線上單（online_order_id 唔空）→ 免同會員餘額 / 線上單脫鉤。
  const { count, error } = await supabase
    .from("pos_orders")
    .delete({ count: "exact" })
    .eq("store_id", storeId)
    .is("online_order_id", null);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, source: "supabase", deleted: count ?? 0, deletedAt: new Date().toISOString() });
}
