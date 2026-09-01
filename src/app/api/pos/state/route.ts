import { NextResponse } from "next/server";

import { defaultPosLocalSettings } from "@/lib/mock-data";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { normalizeDeviceConfig, normalizePosLocalSettings } from "@/lib/storage";

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!supabase) {
    return NextResponse.json({
      ok: true,
      source: "mock",
      orders: [],
      queue: [],
      printJobs: [],
      localSettings: defaultPosLocalSettings,
      deviceConfig: null,
    });
  }

  const ordersQuery = storeId
    ? supabase.from("pos_orders").select("*").eq("store_id", storeId).order("updated_at", { ascending: false }).limit(200)
    : supabase.from("pos_orders").select("*").order("updated_at", { ascending: false }).limit(200);
  const queueQuery = supabase.from("pos_queue_events").select("*").order("created_at", { ascending: false }).limit(300);
  const printJobsQuery = storeId
    ? supabase.from("pos_print_jobs").select("*").eq("store_id", storeId).order("created_at", { ascending: false }).limit(200)
    : supabase.from("pos_print_jobs").select("*").order("created_at", { ascending: false }).limit(200);
  const deviceConfigQuery = storeId
    ? supabase.from("pos_device_configs").select("*").eq("store_id", storeId).order("updated_at", { ascending: false }).limit(1)
    : supabase.from("pos_device_configs").select("*").order("updated_at", { ascending: false }).limit(1);

  const [{ data: orders }, { data: queue }, { data: printJobs }, { data: deviceConfigs }] = await Promise.all([
    ordersQuery,
    queueQuery,
    printJobsQuery,
    deviceConfigQuery,
  ]);

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
        fulfillmentStatus: order.fulfillment_status ?? undefined,
        sentToKitchenAt: order.sent_to_kitchen_at ?? undefined,
        servedAt: order.served_at ?? undefined,
        items: Array.isArray(order.items) ? order.items : [],
        orderNote: order.order_note ?? undefined,
        subtotal: Number(order.subtotal ?? 0),
        taxAmount: Number(order.tax_amount ?? 0),
        serviceChargeAmount: Number(order.service_charge_amount ?? 0),
        discountAmount: Number(order.discount_amount ?? 0),
        total: Number(order.total ?? 0),
        prepaidAmount: Number(order.prepaid_amount ?? 0),
        onlineOrderId: order.online_order_id ?? undefined,
        // docs/87 §5.2：訂單來源（kiosk / scan / pos）。舊 migration 冇呢欄 → fallback "pos"。
        source: order.source ?? "pos",
        partySize: order.party_size == null ? undefined : Number(order.party_size),
        // 免單審計（docs/91 · 0018 migration）。
        // ⚠️ 呢度一定要帶：mergeOrderLists() 係「timestamp 新嘅**成個 object** 取代舊嘅」，
        //    唔係逐欄 merge。server 版冇呢兩欄 → reload 時會把本機嘅免單備註清走。
        //    未跑 0018 migration 嘅環境會冇呢兩欄 → undefined（唔會崩）。
        compNote: order.comp_note ?? undefined,
        compedAt: order.comped_at ?? undefined,
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
    deviceConfig: deviceConfigRow
      ? normalizeDeviceConfig({
          deviceId: deviceConfigRow.device_id,
          terminalName: deviceConfigRow.terminal_name,
          storeId: deviceConfigRow.store_id,
          printers: Array.isArray(deviceConfigRow.printers) ? deviceConfigRow.printers : [],
          updatedAt: deviceConfigRow.updated_at,
        })
      : null,
    localSettings: normalizePosLocalSettings(deviceConfigRow?.local_settings ?? defaultPosLocalSettings),
  });
}
