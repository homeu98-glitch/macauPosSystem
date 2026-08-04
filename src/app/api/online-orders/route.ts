import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

type OnlineOrderType = "dine_in" | "pickup" | "self_delivery" | "rider_delivery";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") ?? "all";

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({
      ok: true,
      source: "mock",
      orders: [
        {
          id: "online-001",
          sourceId: "online-001",
          type: type === "all" ? "dine_in" : type,
          status: "new",
          customerName: "線上客戶",
          total: 86,
          createdAt: new Date().toISOString(),
          items: [
            { name: "叉燒飯", qty: 1 },
            { name: "凍檸茶", qty: 2 },
          ],
        },
      ],
    });
  }

  // 預留：你之後告訴我實際表名/欄位，我就把這段換成真查詢
  // 目前先用一個通用假設：表名 online_orders
  let query = supabase
    .from("online_orders")
    .select("*, online_order_items(product_name, qty)")
    .order("created_at", { ascending: false })
    .limit(50);

  if (type !== "all") {
    query = query.eq("type", type as OnlineOrderType);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json(
      { ok: false, source: "supabase", error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    source: "supabase",
    orders:
      data?.map((order) => ({
        id: order.order_no ?? order.id,
        sourceId: order.id,
        type: order.type,
        status: order.status,
        customerName: order.customer_name,
        total: Number(order.total ?? 0),
        createdAt: order.created_at,
        items: (order.online_order_items ?? []).map((item: { product_name: string; qty: number }) => ({
          name: item.product_name,
          qty: item.qty,
        })),
      })) ?? [],
  });
}

export async function POST(request: Request) {
  const payload = (await request.json()) as {
    action?: "accept" | "assign_table" | "auto_accept" | "handoff_to_rider";
    orderId?: string;
    tableName?: string;
    orderIds?: string[];
    riderFee?: number;
    riderNote?: string;
  };

  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({
      ok: true,
      source: "mock",
      action: payload.action ?? null,
      orderId: payload.orderId ?? null,
      tableName: payload.tableName ?? null,
      orderIds: payload.orderIds ?? [],
      updatedAt: new Date().toISOString(),
    });
  }

  if (payload.action === "accept" && payload.orderId) {
    const { error } = await supabase
      .from("online_orders")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", payload.orderId);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  if (payload.action === "assign_table" && payload.orderId) {
    const { error } = await supabase
      .from("online_orders")
      .update({ status: "accepted", assigned_table_name: payload.tableName ?? null })
      .eq("id", payload.orderId);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  if (payload.action === "auto_accept" && Array.isArray(payload.orderIds) && payload.orderIds.length > 0) {
    const { error } = await supabase
      .from("online_orders")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .in("id", payload.orderIds);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  if (payload.action === "handoff_to_rider" && payload.orderId) {
    const { error } = await supabase
      .from("online_orders")
      .update({
        type: "rider_delivery",
        status: "accepted",
        rider_fee: payload.riderFee ?? null,
        rider_note: payload.riderNote ?? null,
      })
      .eq("id", payload.orderId);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    source: "supabase",
    action: payload.action ?? null,
    orderId: payload.orderId ?? null,
    tableName: payload.tableName ?? null,
    orderIds: payload.orderIds ?? [],
    updatedAt: new Date().toISOString(),
  });
}
