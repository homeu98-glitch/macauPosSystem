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

  const filtered = (data ?? []).filter(
    (order) => !(order.type === "dine_in" && order.assigned_table_name),
  );

  return NextResponse.json({
    ok: true,
    source: "supabase",
    orders:
      filtered.map((order) => ({
        id: order.order_no ?? order.id,
        sourceId: order.id,
        type: order.type,
        status: order.status,
        paymentStatus: (order.payment_status ?? "unpaid") as "paid" | "unpaid",
        paidAmount: Number(order.paid_amount ?? 0),
        customerName: order.customer_name,
        phone: order.customer_phone ?? order.phone ?? null,
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
    action?:
      | "accept"
      | "assign_table"
      | "auto_accept"
      | "handoff_to_rider"
      | "convert_quick"
      | "cancel"
      | "confirm_customer_cancel"
      | "reject_customer_cancel";
    orderId?: string;
    tableName?: string;
    tableId?: string;
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
    const { data: orderRow } = await supabase.from("online_orders").select("*").eq("id", payload.orderId).maybeSingle();
    const { error } = await supabase
      .from("online_orders")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", payload.orderId);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // 自取單：生成「自取XX」單號（獨立序號）
    if (orderRow?.type === "pickup" && !orderRow.order_no) {
      const { data: seq } = await supabase.rpc("next_daily_sequence", {
        p_store_id: orderRow.store_id ?? "macau-store-a",
        p_kind: "pickup",
      });
      if (typeof seq === "number") {
        const display = `自取${String(seq).padStart(2, "0")}`;
        await supabase.from("online_orders").update({ order_no: display }).eq("id", payload.orderId);
      }
    }
  }

  if (payload.action === "assign_table" && payload.orderId) {
    const { data: onlineOrder, error: orderError } = await supabase
      .from("online_orders")
      .select("*, online_order_items(product_name, qty)")
      .eq("id", payload.orderId)
      .maybeSingle();

    if (orderError || !onlineOrder) {
      return NextResponse.json({ ok: false, error: orderError?.message ?? "線上訂單不存在" }, { status: 500 });
    }

    const { error } = await supabase
      .from("online_orders")
      .update({ status: "accepted", assigned_table_name: payload.tableName ?? null })
      .eq("id", payload.orderId);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // 堂食：選桌後把菜品轉入 POS 桌台訂單
    if (onlineOrder.type === "dine_in" && payload.tableId) {
      const { data: bootstrapRow } = await supabase
        .from("pos_bootstrap_config")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const menuItems: Array<{ id: string; name: string; price: number; printerGroup: string }> = Array.isArray(bootstrapRow?.menu_items)
        ? bootstrapRow!.menu_items
        : [];

      const mappedItems: Array<{
        menuItemId: string;
        name: string;
        quantity: number;
        price: number;
        printerGroup: "kitchen" | "drinks" | "receipt";
      }> = (onlineOrder.online_order_items ?? []).map((item: { product_name: string; qty: number }) => {
        const menu = menuItems.find((m) => m.name === item.product_name);
        return {
          menuItemId: menu?.id ?? `ext-${item.product_name}`,
          name: item.product_name,
          quantity: item.qty,
          price: Number(menu?.price ?? 0),
          printerGroup: (menu?.printerGroup ?? "kitchen") as "kitchen" | "drinks" | "receipt",
        };
      });

      const subtotal = mappedItems.reduce((sum, row) => sum + row.price * row.quantity, 0);
      const taxAmount = 0;
      const total = subtotal + taxAmount;
      const prepaidAmount = Number(onlineOrder.paid_amount ?? 0);

      await supabase.from("pos_orders").upsert(
        {
          id: `online-${onlineOrder.id}`,
          local_order_no: onlineOrder.order_no ?? onlineOrder.id,
          store_id: onlineOrder.store_id ?? "macau-store-a",
          table_id: payload.tableId,
          table_name: payload.tableName ?? "",
          status: "sent_to_kitchen",
          items: mappedItems,
          subtotal,
          tax_amount: taxAmount,
          service_charge_amount: 0,
          discount_amount: 0,
          total,
          prepaid_amount: prepaidAmount,
          online_order_id: onlineOrder.id,
          payment_method: null,
          created_at: onlineOrder.created_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
    }
  }

  if (payload.action === "convert_quick" && payload.orderId) {
    const { data: onlineOrder, error: orderError } = await supabase
      .from("online_orders")
      .select("*, online_order_items(product_name, qty)")
      .eq("id", payload.orderId)
      .maybeSingle();

    if (orderError || !onlineOrder) {
      return NextResponse.json({ ok: false, error: orderError?.message ?? "線上訂單不存在" }, { status: 500 });
    }

    const { data: bootstrapRow } = await supabase
      .from("pos_bootstrap_config")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const menuItems: Array<{ id: string; name: string; price: number; printerGroup: string }> = Array.isArray(bootstrapRow?.menu_items)
      ? bootstrapRow!.menu_items
      : [];

    const mappedItems: Array<{
      menuItemId: string;
      name: string;
      quantity: number;
      price: number;
      printerGroup: "kitchen" | "drinks" | "receipt";
    }> = (onlineOrder.online_order_items ?? []).map((item: { product_name: string; qty: number }) => {
      const menu = menuItems.find((m) => m.name === item.product_name);
      return {
        menuItemId: menu?.id ?? `ext-${item.product_name}`,
        name: item.product_name,
        quantity: item.qty,
        price: Number(menu?.price ?? 0),
        printerGroup: (menu?.printerGroup ?? "kitchen") as "kitchen" | "drinks" | "receipt",
      };
    });

    const subtotal = mappedItems.reduce((sum, row) => sum + row.price * row.quantity, 0);
    const taxAmount = 0;
    const total = subtotal + taxAmount;
    const prepaidAmount = Number(onlineOrder.paid_amount ?? 0);

    let orderNo = onlineOrder.order_no ?? onlineOrder.id;
    let tableName = "堂食";
    let nextKind: "counter" | "pickup" | "delivery" | null = null;

    if (onlineOrder.type === "dine_in") {
      tableName = "堂食";
      nextKind = "counter";
    } else if (onlineOrder.type === "pickup") {
      tableName = "自取";
      nextKind = "pickup";
    } else if (onlineOrder.type === "rider_delivery") {
      tableName = "外賣";
      nextKind = "delivery";
    } else {
      tableName = "外賣";
      nextKind = "delivery";
    }

    if (nextKind && !onlineOrder.order_no) {
      const { data: seq } = await supabase.rpc("next_daily_sequence", {
        p_store_id: onlineOrder.store_id ?? "macau-store-a",
        p_kind: nextKind,
      });
      if (typeof seq === "number") {
        orderNo =
          nextKind === "pickup"
            ? `自取${String(seq).padStart(2, "0")}`
            : nextKind === "delivery"
              ? `外賣${String(seq).padStart(2, "0")}`
              : `取餐${String(seq).padStart(2, "0")}`;
        await supabase.from("online_orders").update({ order_no: orderNo }).eq("id", payload.orderId);
      }
    }

    await supabase.from("pos_orders").upsert(
      {
        id: `online-${onlineOrder.id}`,
        local_order_no: orderNo,
        store_id: onlineOrder.store_id ?? "macau-store-a",
        table_id: "counter",
        table_name: tableName,
        status: "sent_to_kitchen",
        items: mappedItems,
        subtotal,
        tax_amount: taxAmount,
        service_charge_amount: 0,
        discount_amount: 0,
        total,
        prepaid_amount: prepaidAmount,
        online_order_id: onlineOrder.id,
        payment_method: null,
        created_at: onlineOrder.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );

    return NextResponse.json({
      ok: true,
      source: "supabase",
      posOrder: {
        id: `online-${onlineOrder.id}`,
        localOrderNo: orderNo,
        tableId: "counter",
        tableName,
        status: "sent_to_kitchen",
        items: mappedItems,
        subtotal,
        taxAmount,
        serviceChargeAmount: 0,
        discountAmount: 0,
        total,
        prepaidAmount,
        onlineOrderId: onlineOrder.id,
        paymentMethod: undefined,
        createdAt: onlineOrder.created_at ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
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

  if ((payload.action === "cancel" || payload.action === "confirm_customer_cancel") && payload.orderId) {
    const status = payload.action === "cancel" ? "cancelled_by_merchant" : "cancelled_by_customer";
    const { error } = await supabase
      .from("online_orders")
      .update({ status, cancelled_at: new Date().toISOString() })
      .eq("id", payload.orderId);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // TODO：對接主系統取消訂單 API（你提供 endpoint 後再接）
    return NextResponse.json({ ok: true, source: "supabase", status });
  }

  if (payload.action === "reject_customer_cancel" && payload.orderId) {
    const { error } = await supabase
      .from("online_orders")
      .update({ status: "cancel_rejected", cancel_rejected_at: new Date().toISOString() })
      .eq("id", payload.orderId);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // TODO：對接主系統「不認同取消」API（你提供 endpoint 後再接）
    return NextResponse.json({ ok: true, source: "supabase", status: "cancel_rejected" });
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
