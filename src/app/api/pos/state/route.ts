import { NextResponse } from "next/server";

import { defaultPosLocalSettings } from "@/lib/mock-data";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { normalizeDeviceConfig, normalizePosLocalSettings } from "@/lib/storage";

/** `pos_orders` 資料表 row（snake_case）。與 `/api/pos/state` 既有映射保持一致。 */
type PosOrderDbRow = {
  id: string;
  store_id?: string | null;
  local_order_no: string | null;
  table_id: string | null;
  table_name: string | null;
  status: string;
  fulfillment_status: string | null;
  sent_to_kitchen_at: string | null;
  served_at: string | null;
  items: unknown;
  order_note: string | null;
  subtotal: number;
  tax_amount: number;
  service_charge_amount: number;
  discount_amount: number;
  total: number;
  prepaid_amount: number;
  online_order_id: string | null;
  source?: string | null;
  party_size?: number | null;
  comp_note?: string | null;
  comped_at?: string | null;
  payment_method: string | null;
  created_at: string;
  updated_at: string;
};

/** `pos_orders` row → 領域物件。此映射係收銀工作台 `/api/pos/state` 的單一真源。 */
function mapOrder(order: PosOrderDbRow) {
  return {
    id: order.id,
    storeId: order.store_id ?? undefined,
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
    // 免單審計（docs/91 · 0018 migration）。未跑 migration 嘅環境會冇呢兩欄 → undefined。
    compNote: order.comp_note ?? undefined,
    compedAt: order.comped_at ?? undefined,
    paymentMethod: order.payment_method ?? undefined,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  // 訂單回傳上限：收銀工作台用預設 200（最新 200 單已足夠），
  // 報表頁需要更完整嘅歷史（今天/7天/30天/全部），可傳 `limit` 拉多啲。
  // 夾喺 [1, 5000]，超出即回報 400，避免惡意超大查詢。
  const rawLimit = searchParams.get("limit");
  let limit = 200;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5000) {
      return NextResponse.json({ ok: false, error: "limit 必須為 1–5000 的整數。" }, { status: 400 });
    }
    limit = parsed;
  }

  // 分頁偏移（0-based）。報表「全部/30天」需要分頁拉全量訂單；收銀工作台唔傳 offset（=0）。
  const rawOffset = searchParams.get("offset");
  let offset = 0;
  if (rawOffset !== null) {
    const parsed = Number.parseInt(rawOffset, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000) {
      return NextResponse.json({ ok: false, error: "offset 必須為 0–100000 的整數。" }, { status: 400 });
    }
    offset = parsed;
  }

  // 報表分頁時只需要訂單，跳過 queue/printJobs/deviceConfig 查詢，省時省流量。
  const ordersOnly = searchParams.get("ordersOnly") === "1";

  // 報表區間過濾：只回傳 created_at 或 updated_at 落在 [start, end] 內嘅訂單。
  // 用 created_at OR updated_at 可以同時覆蓋「區間內開單」同「區間內結帳/更新」兩種情況，
  // 避免只篩 updated_at 時漏咗開咗單但尚未結帳嘅單。
  const rangeStart = searchParams.get("start")?.trim() || null;
  const rangeEnd = searchParams.get("end")?.trim() || null;

  if (!supabase) {
    if (ordersOnly) {
      return NextResponse.json({ ok: true, source: "mock", orders: [] });
    }
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

  const ordersBase = storeId
    ? supabase.from("pos_orders").select("*").eq("store_id", storeId)
    : supabase.from("pos_orders").select("*");

  const ordersQuery = ordersBase
    .or(
      rangeStart && rangeEnd
        ? `and(created_at.gte.${rangeStart},created_at.lte.${rangeEnd}),and(updated_at.gte.${rangeStart},updated_at.lte.${rangeEnd})`
        : rangeStart
          ? `created_at.gte.${rangeStart},updated_at.gte.${rangeStart}`
          : rangeEnd
            ? `created_at.lte.${rangeEnd},updated_at.lte.${rangeEnd}`
            : "created_at.not.is.null,updated_at.not.is.null",
    )
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  // 報表分頁只拉訂單，跳過其餘 table。
  if (ordersOnly) {
    const { data: orders } = await ordersQuery;
    return NextResponse.json({
      ok: true,
      source: "supabase",
      orders: orders?.map(mapOrder) ?? [],
    });
  }

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
    orders: orders?.map(mapOrder) ?? [],
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
