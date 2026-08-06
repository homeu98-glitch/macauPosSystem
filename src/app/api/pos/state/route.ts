import { NextResponse } from "next/server";

import { defaultMembers } from "@/lib/mock-data";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { defaultPosLocalSettings } from "@/lib/mock-data";
import { normalizePosLocalSettings } from "@/lib/storage";

export async function GET() {
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({
      ok: true,
      source: "mock",
      orders: [],
      queue: [],
      printJobs: [],
      members: defaultMembers,
      localSettings: defaultPosLocalSettings,
      deviceConfig: null,
    });
  }

  const [{ data: orders }, { data: queue }, { data: printJobs }, { data: deviceConfigs }, { data: members }, { data: coupons }] =
    await Promise.all([
      supabase.from("pos_orders").select("*").order("updated_at", { ascending: false }).limit(200),
      supabase.from("pos_queue_events").select("*").order("created_at", { ascending: false }).limit(300),
      supabase.from("pos_print_jobs").select("*").order("created_at", { ascending: false }).limit(200),
      supabase.from("pos_device_configs").select("*").order("updated_at", { ascending: false }).limit(1),
      supabase.from("pos_members").select("*").order("updated_at", { ascending: false }).limit(200),
      supabase.from("pos_member_coupons").select("*").order("created_at", { ascending: false }).limit(500),
    ]);

  const couponMap = new Map<string, typeof coupons>();
  (coupons ?? []).forEach((coupon) => {
    const list = couponMap.get(coupon.member_id) ?? [];
    list.push(coupon);
    couponMap.set(coupon.member_id, list);
  });

  const deviceConfigRow = deviceConfigs?.[0] ?? null;

  return NextResponse.json({
    ok: true,
    source: "supabase",
    orders:
      orders?.map((order) => ({
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
    queue:
      queue?.map((event) => ({
        id: event.id,
        type: event.type,
        entityId: event.entity_id,
        payload: event.payload,
        status: event.status,
        createdAt: event.created_at,
      })) ?? [],
    printJobs:
      printJobs?.map((job) => ({
        id: job.id,
        orderId: job.order_id,
        orderNo: job.order_no ?? undefined,
        tableName: job.table_name ?? undefined,
        ticketType: job.ticket_type,
        printerGroup: job.printer_group,
        printerName: job.printer_name,
        items: Array.isArray(job.items) ? job.items : [],
        status: job.status,
        createdAt: job.created_at,
      })) ?? [],
    members:
      members?.map((member) => ({
        id: member.id,
        name: member.name,
        phone: member.phone,
        balance: Number(member.balance ?? 0),
        level: member.level ?? undefined,
        coupons:
          couponMap.get(member.id)?.map((coupon) => ({
            id: coupon.id,
            title: coupon.title,
            type: coupon.type,
            amountOff: coupon.amount_off ?? undefined,
            percentOff: coupon.percent_off ?? undefined,
            maxOff: coupon.max_off ?? undefined,
            minSpend: coupon.min_spend ?? undefined,
            stackable: Boolean(coupon.stackable),
            expiresAt: coupon.expires_at ?? undefined,
            usedAt: coupon.used_at ?? undefined,
          })) ?? [],
      })) ?? [],
    deviceConfig: deviceConfigRow
      ? {
          deviceId: deviceConfigRow.device_id,
          terminalName: deviceConfigRow.terminal_name,
          storeId: deviceConfigRow.store_id,
          printers: Array.isArray(deviceConfigRow.printers) ? deviceConfigRow.printers : [],
          updatedAt: deviceConfigRow.updated_at,
        }
      : null,
    localSettings: normalizePosLocalSettings(deviceConfigRow?.local_settings ?? defaultPosLocalSettings),
  });
}
