import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function POST(request: Request) {
  const payload = await request.json();
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const storeId = String(payload?.storeId ?? "macau-store-a");
  const supabase = getSupabaseServerClient();

  // 冇 Supabase 伺服器端 client（env 未配 SUPABASE_URL / SERVICE_ROLE_KEY）→
  // 唔可以靜默當成功，否則 kiosk 會顯示假成功（單號正常）但訂單其實冇寫入 DB。
  if (!supabase) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Supabase 伺服器端未配置（缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY），落單無法寫入。",
      },
      { status: 503 },
    );
  }

  if (events.length === 0) {
    return NextResponse.json({ ok: true, syncedCount: 0, receivedAt: new Date().toISOString() });
  }

  const errors: string[] = [];

  for (const event of events) {
    const { error: qErr } = await supabase.from("pos_queue_events").upsert(
      {
        id: event.id,
        type: event.type,
        entity_id: event.entityId,
        payload: event.payload,
        status: event.status,
        created_at: event.createdAt,
      },
      { onConflict: "id" },
    );
    if (qErr) errors.push(`queue_events: ${qErr.message}`);

    if (event.type === "ORDER_CREATED" || event.type === "ORDER_UPDATED") {
      const order = event.type === "ORDER_UPDATED" ? event.payload?.order : event.payload;
      if (order?.id) {
        const { error: oErr } = await supabase.from("pos_orders").upsert(
          {
            id: order.id,
            local_order_no: order.localOrderNo,
            store_id: storeId,
            table_id: order.tableId,
            table_name: order.tableName,
            status: order.status,
            fulfillment_status: order.fulfillmentStatus ?? null,
            items: order.items,
            order_note: order.orderNote ?? null,
            subtotal: order.subtotal,
            tax_amount: order.taxAmount,
            service_charge_amount: order.serviceChargeAmount,
            discount_amount: order.discountAmount,
            total: order.total,
            prepaid_amount: order.prepaidAmount ?? 0,
            online_order_id: order.onlineOrderId ?? null,
            payment_method: order.paymentMethod ?? null,
            created_at: order.createdAt,
            updated_at: order.updatedAt,
          },
          { onConflict: "id" },
        );
        if (oErr) errors.push(`pos_orders ${order.localOrderNo ?? order.id}: ${oErr.message}`);
      }
    }

    if (event.type === "ORDER_SETTLED" && event.payload?.orderId) {
      const { error: sErr } = await supabase
        .from("pos_orders")
        .update({
          status: event.payload.status ?? "settled",
          fulfillment_status: event.payload.fulfillmentStatus ?? null,
          payment_method: event.payload.paymentMethod ?? null,
          discount_amount: event.payload.discountAmount ?? 0,
          total: event.payload.total ?? 0,
          updated_at: event.createdAt,
        })
        .eq("id", event.payload.orderId);
      if (sErr) errors.push(`pos_orders settle ${event.payload.orderId}: ${sErr.message}`);
    }

    if (event.type === "PRINT_JOB_CREATED" && event.payload?.id) {
      const job = event.payload;
      const { error: jErr } = await supabase.from("pos_print_jobs").upsert(
        {
          id: job.id,
          store_id: storeId,
          order_id: job.orderId,
          order_no: job.orderNo ?? null,
          table_name: job.tableName ?? null,
          ticket_type: job.ticketType,
          printer_group: job.printerGroup,
          printer_name: job.printerName,
          items: job.items ?? [],
          status: job.status,
          created_at: job.createdAt,
        },
        { onConflict: "id" },
      );
      if (jErr) errors.push(`pos_print_jobs ${job.id}: ${jErr.message}`);
    }
  }

  if (errors.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: errors[0],
        detail: errors,
        syncedCount: events.length - errors.length,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    syncedCount: events.length,
    receivedAt: new Date().toISOString(),
  });
}
