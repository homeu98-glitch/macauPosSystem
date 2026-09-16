import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { MISSING_STORE_MESSAGE, posRouteAuthGuard } from "@/lib/pos/pos-route-auth";

// Salon 批量狀態拉取（開機 hydrate 用）。
// 模式與餐飲 /api/pos/state 一致：server-only Supabase + 未配置時返空 + source=mock。
// 表：salon_bookings / salon_orders / salon_customers / salon_print_jobs

function mapBooking(row: Record<string, unknown>) {
  return {
    id: row.id,
    bookingNo: row.booking_no,
    source: row.source,
    ledgerBookingId: row.ledger_booking_id,
    ledgerOrderId: row.ledger_order_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    staffId: row.staff_id,
    stationId: row.station_id,
    startAt: row.start_at,
    endAt: row.end_at,
    services: Array.isArray(row.services) ? row.services : [],
    depositAmount: row.deposit_amount != null ? Number(row.deposit_amount) : undefined,
    depositPaid: row.deposit_paid,
    depositLedgerTxnId: row.deposit_ledger_txn_id,
    status: row.status,
    orderId: row.order_id,
    notes: row.notes,
    internalNotes: row.internal_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOrder(row: Record<string, unknown>) {
  return {
    id: row.id,
    orderNo: row.order_no,
    bookingId: row.booking_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    staffId: row.staff_id,
    stationId: row.station_id,
    items: Array.isArray(row.items) ? row.items : [],
    subtotal: Number(row.subtotal ?? 0),
    discountAmount: Number(row.discount_amount ?? 0),
    serviceChargeAmount: row.service_charge_amount != null ? Number(row.service_charge_amount) : undefined,
    taxAmount: row.tax_amount != null ? Number(row.tax_amount) : undefined,
    total: Number(row.total ?? 0),
    tips: Array.isArray(row.tips) ? row.tips : [],
    tipTotal: Number(row.tip_total ?? 0),
    grandTotal: Number(row.grand_total ?? 0),
    payments: Array.isArray(row.payments) ? row.payments : [],
    depositApplied: row.deposit_applied != null ? Number(row.deposit_applied) : undefined,
    changeDue: row.change_due != null ? Number(row.change_due) : undefined,
    status: row.status,
    notes: row.notes,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    settledAt: row.settled_at,
    ledgerOrderId: row.ledger_order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCustomer(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    ledgerBalance: row.ledger_balance != null ? Number(row.ledger_balance) : undefined,
    ledgerPoints: row.ledger_points != null ? Number(row.ledger_points) : undefined,
    ledgerTier: row.ledger_tier,
    birthday: row.birthday,
    gender: row.gender,
    tags: Array.isArray(row.tags) ? row.tags : [],
    skinType: row.skin_type,
    hairType: row.hair_type,
    allergies: Array.isArray(row.allergies) ? row.allergies : [],
    preferences: row.preferences,
    formulaHistory: Array.isArray(row.formula_history) ? row.formula_history : [],
    visitCount: Number(row.visit_count ?? 0),
    lastVisitAt: row.last_visit_at,
    totalSpent: row.total_spent != null ? Number(row.total_spent) : undefined,
  };
}

function mapPrintJob(row: Record<string, unknown>) {
  return {
    id: row.id,
    orderId: row.order_id,
    orderNo: row.order_no,
    tableName: row.station_name ?? undefined,
    ticketType: row.ticket_type,
    printerGroup: row.printer_group,
    printerName: row.printer_name,
    items: Array.isArray(row.items) ? row.items : [],
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapPackageTemplate(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    price: Number(row.price ?? 0),
    validityDays: Number(row.validity_days ?? 0),
    items: Array.isArray(row.items) ? row.items : [],
    bonusPoints: Number(row.bonus_points ?? 0),
    bonusBalance: row.bonus_balance != null ? Number(row.bonus_balance) : 0,
    note: row.note,
    active: row.active ?? true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCustomerPackage(row: Record<string, unknown>) {
  return {
    id: row.id,
    customerId: row.customer_id,
    templateId: row.template_id,
    templateName: row.template_name,
    price: Number(row.price ?? 0),
    purchasedAt: row.purchased_at,
    expiresAt: row.expires_at,
    remaining: Array.isArray(row.remaining) ? row.remaining : [],
    status: row.status,
    paymentMethod: row.payment_method,
    note: row.note,
  };
}

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!supabase) {
    return NextResponse.json({
      ok: true,
      source: "mock",
      bookings: [],
      orders: [],
      customers: [],
      printJobs: [],
      packageTemplates: [],
      customerPackages: [],
    });
  }

  /**
   * 🔴 2026-09-16 資安加固：**必須帶 storeId + POS 終端憑證**。
   *
   * 舊版係 2026-09-15 審查已標記嘅 P0，但當時只加咗 storeId 要求、**冇加鑑權**；
   * 而且冇 storeId 時會**回全平台 salon 資料**。2026-09-16 實測（唔帶 storeId）：
   *   `GET /api/salon/state` → **200、19.6 KB，含 `customerName` + `customerPhone`（顧客 PII）**。
   * （當次回嘅係 `mock-*` 種子資料，未涉及真實客人，但代碼路徑同真店完全一樣。）
   *
   * 閘放喺 `!supabase`（mock）early-return 之後 ⇒ 未配置環境嘅既有回應完全不變。
   */
  if (!storeId) {
    return NextResponse.json({ ok: false, error: MISSING_STORE_MESSAGE }, { status: 400 });
  }
  const denied = posRouteAuthGuard(request, storeId, "salon/state");
  if (denied) return denied;

  const bookingsQuery = supabase.from("salon_bookings").select("*").eq("store_id", storeId).order("updated_at", { ascending: false }).limit(500);
  const ordersQuery = supabase.from("salon_orders").select("*").eq("store_id", storeId).order("updated_at", { ascending: false }).limit(500);
  const customersQuery = supabase.from("salon_customers").select("*").eq("store_id", storeId);
  const printJobsQuery = supabase.from("salon_print_jobs").select("*").eq("store_id", storeId).order("created_at", { ascending: false }).limit(300);
  const packageTemplatesQuery = supabase.from("salon_package_templates").select("*").eq("store_id", storeId);
  const customerPackagesQuery = supabase.from("salon_customer_packages").select("*").eq("store_id", storeId);

  const [
    { data: bookings },
    { data: orders },
    { data: customers },
    { data: printJobs },
    { data: packageTemplates },
    { data: customerPackages },
  ] = await Promise.all([
    bookingsQuery,
    ordersQuery,
    customersQuery,
    printJobsQuery,
    packageTemplatesQuery,
    customerPackagesQuery,
  ]);

  return NextResponse.json({
    ok: true,
    source: "supabase",
    bookings: (bookings ?? []).map(mapBooking),
    orders: (orders ?? []).map(mapOrder),
    customers: (customers ?? []).map(mapCustomer),
    printJobs: (printJobs ?? []).map(mapPrintJob),
    packageTemplates: (packageTemplates ?? []).map(mapPackageTemplate),
    customerPackages: (customerPackages ?? []).map(mapCustomerPackage),
  });
}
