import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function POST(request: Request) {
  const payload = await request.json();
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const supabase = getSupabaseServerClient();

  if (supabase && events.length > 0) {
    for (const event of events) {
      await supabase.from("pos_queue_events").upsert(
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

      if (event.type === "ORDER_CREATED" || event.type === "ORDER_UPDATED") {
        const order = event.type === "ORDER_UPDATED" ? event.payload?.order : event.payload;
        if (order?.id) {
          await supabase.from("pos_orders").upsert(
            {
              id: order.id,
              local_order_no: order.localOrderNo,
              store_id: "macau-store-a",
              table_id: order.tableId,
              table_name: order.tableName,
              status: order.status,
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
        }
      }

      if (event.type === "ORDER_SETTLED" && event.payload?.orderId) {
        await supabase
          .from("pos_orders")
          .update({
            status: event.payload.status ?? "settled",
            payment_method: event.payload.paymentMethod ?? null,
            discount_amount: event.payload.discountAmount ?? 0,
            total: event.payload.total ?? 0,
            updated_at: event.createdAt,
          })
          .eq("id", event.payload.orderId);

        if (event.payload.memberPhone) {
          const { data: member } = await supabase
            .from("pos_members")
            .select("*")
            .eq("phone", event.payload.memberPhone)
            .maybeSingle();

          if (member) {
            await supabase
              .from("pos_members")
              .update({
                balance: Math.max(0, Number(member.balance ?? 0) - Number(event.payload.memberDeduction ?? 0)),
                updated_at: new Date().toISOString(),
              })
              .eq("id", member.id);

            if (Array.isArray(event.payload.couponIds) && event.payload.couponIds.length > 0) {
              await supabase
                .from("pos_member_coupons")
                .update({ used_at: new Date().toISOString() })
                .in("id", event.payload.couponIds);
            }
          }
        }
      }

      if (event.type === "PRINT_JOB_CREATED" && event.payload?.id) {
        const job = event.payload;
        await supabase.from("pos_print_jobs").upsert(
          {
            id: job.id,
            store_id: "macau-store-a",
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
      }
    }
  }

  return NextResponse.json({
    ok: true,
    syncedCount: events.length,
    receivedAt: new Date().toISOString(),
  });
}
