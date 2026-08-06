import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function GET() {
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ ok: true, source: "mock", orders: [] });
  }

  const { data, error } = await supabase
    .from("pos_orders")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(500);

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
