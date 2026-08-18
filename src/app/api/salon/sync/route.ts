import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

// Salon 同步上傳（離線佇列 flush 用）。
// 模式與餐飲 /api/pos/sync 一致：消費 {storeId, events:[{type,entityId,payload}]}，
// 按 type upsert 入對應 salon_* 表 + 寫 salon_queue_events 審計。
// payload 為該 entity 嘅整個陣列（客戶端 pushSalonMutation 已帶齊）。

function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `qe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function upsertBooking(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, storeId: string, rec: Record<string, unknown>) {
  await supabase.from("salon_bookings").upsert(
    {
      id: rec.id,
      store_id: storeId,
      booking_no: rec.bookingNo,
      source: rec.source,
      ledger_booking_id: rec.ledgerBookingId,
      ledger_order_id: rec.ledgerOrderId,
      customer_id: rec.customerId,
      customer_name: rec.customerName,
      customer_phone: rec.customerPhone,
      staff_id: rec.staffId,
      station_id: rec.stationId,
      start_at: rec.startAt,
      end_at: rec.endAt,
      services: rec.services ?? [],
      deposit_amount: rec.depositAmount,
      deposit_paid: rec.depositPaid,
      deposit_ledger_txn_id: rec.depositLedgerTxnId,
      status: rec.status,
      order_id: rec.orderId,
      notes: rec.notes,
      internal_notes: rec.internalNotes,
      created_at: rec.createdAt,
      updated_at: rec.updatedAt,
    },
    { onConflict: "id" },
  );
}

async function upsertOrder(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, storeId: string, rec: Record<string, unknown>) {
  await supabase.from("salon_orders").upsert(
    {
      id: rec.id,
      store_id: storeId,
      order_no: rec.orderNo,
      booking_id: rec.bookingId,
      customer_id: rec.customerId,
      customer_name: rec.customerName,
      customer_phone: rec.customerPhone,
      staff_id: rec.staffId,
      station_id: rec.stationId,
      items: rec.items ?? [],
      subtotal: rec.subtotal,
      discount_amount: rec.discountAmount,
      service_charge_amount: rec.serviceChargeAmount,
      tax_amount: rec.taxAmount,
      total: rec.total,
      tips: rec.tips ?? [],
      tip_total: rec.tipTotal,
      grand_total: rec.grandTotal,
      payments: rec.payments ?? [],
      deposit_applied: rec.depositApplied,
      change_due: rec.changeDue,
      status: rec.status,
      notes: rec.notes,
      started_at: rec.startedAt,
      completed_at: rec.completedAt,
      settled_at: rec.settledAt,
      ledger_order_id: rec.ledgerOrderId,
      created_at: rec.createdAt,
      updated_at: rec.updatedAt,
    },
    { onConflict: "id" },
  );
}

async function upsertPrintJob(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, storeId: string, rec: Record<string, unknown>) {
  await supabase.from("salon_print_jobs").upsert(
    {
      id: rec.id,
      store_id: storeId,
      order_id: rec.orderId,
      order_no: rec.orderNo,
      station_name: rec.tableName,
      ticket_type: rec.ticketType,
      printer_group: rec.printerGroup,
      printer_name: rec.printerName,
      items: rec.items ?? [],
      status: rec.status,
      created_at: rec.createdAt,
    },
    { onConflict: "id" },
  );
}

async function upsertCustomer(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, storeId: string, rec: Record<string, unknown>) {
  await supabase.from("salon_customers").upsert(
    {
      id: rec.id,
      store_id: storeId,
      name: rec.name,
      phone: rec.phone,
      ledger_balance: rec.ledgerBalance,
      ledger_points: rec.ledgerPoints,
      ledger_tier: rec.ledgerTier,
      birthday: rec.birthday,
      gender: rec.gender,
      file_number: rec.fileNumber ?? null,
      tags: rec.tags ?? [],
      skin_type: rec.skinType,
      hair_type: rec.hairType,
      allergies: rec.allergies ?? [],
      preferences: rec.preferences,
      formula_history: rec.formulaHistory ?? [],
      visit_count: rec.visitCount,
      last_visit_at: rec.lastVisitAt,
      total_spent: rec.totalSpent,
      updated_at: rec.updatedAt ?? new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

async function upsertProductSale(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, storeId: string, rec: Record<string, unknown>) {
  await supabase.from("salon_product_sales").upsert(
    {
      id: rec.id,
      store_id: storeId,
      product_id: rec.productId,
      product_name: rec.productName,
      price: rec.price,
      commission_rate: rec.commissionRate,
      commission_amount: rec.commissionAmount,
      staff_id: rec.staffId,
      staff_name: rec.staffName,
      customer_id: rec.customerId ?? null,
      customer_name: rec.customerName,
      payment_method: rec.paymentMethod ?? null,
      sold_at: rec.soldAt ?? null,
      note: rec.note ?? null,
      created_at: rec.createdAt ?? new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

async function upsertStaffLeave(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, storeId: string, rec: Record<string, unknown>) {
  await supabase.from("salon_staff_leaves").upsert(
    {
      id: rec.id,
      store_id: storeId,
      staff_id: rec.staffId,
      start_date: rec.start,
      end_date: rec.end,
      reason: rec.reason ?? null,
      created_at: rec.createdAt ?? new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

async function upsertStaffShift(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, storeId: string, rec: Record<string, unknown>) {
  await supabase.from("salon_staff_shifts").upsert(
    {
      id: rec.id,
      store_id: storeId,
      staff_id: rec.staffId,
      date: rec.date,
      start_time: rec.start,
      end_time: rec.end,
      note: rec.note ?? null,
      created_at: rec.createdAt ?? new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

async function upsertBootstrap(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, rec: Record<string, unknown>) {
  await supabase.from("salon_bootstrap_config").upsert(
    {
      store_id: rec.storeId ?? "demo-salon-001",
      source_version: rec.sourceVersion ?? 1,
      store_name: rec.storeName ?? "示範美容院",
      currency: rec.currency ?? "MOP",
      service_categories: rec.serviceCategories ?? [],
      service_items: rec.serviceItems ?? [],
      staff: rec.staff ?? [],
      stations: rec.stations ?? [],
      calendar_slot_minutes: rec.calendarSlotMinutes ?? 30,
      deposit_enabled: rec.depositEnabled ?? false,
      default_service_duration_minutes: rec.defaultServiceDurationMinutes ?? 60,
      products: rec.products ?? [],
      staff_level_multipliers: (Array.isArray(rec.staffLevelTypes) ? rec.staffLevelTypes : []).reduce(
        (m: Record<string, number>, t: { id?: string; multiplier?: number }) => {
          if (t?.id) m[t.id] = Number(t.multiplier) || 0;
          return m;
        },
        {},
      ),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );
}

async function upsertPackageTemplate(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, storeId: string, rec: Record<string, unknown>) {
  await supabase.from("salon_package_templates").upsert(
    {
      id: rec.id,
      store_id: storeId,
      name: rec.name ?? "",
      price: rec.price ?? 0,
      validity_days: rec.validityDays ?? 0,
      items: rec.items ?? [],
      bonus_points: rec.bonusPoints ?? 0,
      bonus_balance: rec.bonusBalance ?? 0,
      note: rec.note,
      active: rec.active ?? true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

async function upsertCustomerPackage(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, storeId: string, rec: Record<string, unknown>) {
  await supabase.from("salon_customer_packages").upsert(
    {
      id: rec.id,
      store_id: storeId,
      customer_id: rec.customerId,
      template_id: rec.templateId,
      template_name: rec.templateName,
      price: rec.price ?? 0,
      purchased_at: rec.purchasedAt,
      expires_at: rec.expiresAt,
      remaining: rec.remaining ?? [],
      status: rec.status,
      payment_method: rec.paymentMethod,
      note: rec.note,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

export async function POST(request: Request) {
  const payload = (await request.json()) as {
    storeId?: string;
    events?: Array<{ type: string; entityId?: string; payload?: unknown }>;
  };
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const storeId = String(payload?.storeId ?? "demo-salon-001");
  const supabase = getSupabaseServerClient();

  if (supabase && events.length > 0) {
    for (const ev of events) {
      const arr = Array.isArray(ev.payload) ? (ev.payload as Record<string, unknown>[]) : ev.payload ? [ev.payload as Record<string, unknown>] : [];
      for (const rec of arr) {
        if (!rec?.id) continue;
        if (ev.type === "BOOKING_CREATED" || ev.type === "BOOKING_UPDATED" || ev.type === "BOOKING_CANCELLED" || ev.type === "BOOKING_CHECKED_IN" || ev.type === "BOOKING_NO_SHOW") {
          await upsertBooking(supabase, storeId, rec);
        } else if (ev.type === "ORDER_DRAFT_CREATED" || ev.type === "ORDER_SETTLED") {
          await upsertOrder(supabase, storeId, rec);
        } else if (ev.type === "PRINT_JOB_CREATED") {
          await upsertPrintJob(supabase, storeId, rec);
        } else if (ev.type === "CUSTOMER_UPDATED") {
          await upsertCustomer(supabase, storeId, rec);
        } else if (ev.type === "BOOTSTRAP_UPDATED") {
          await upsertBootstrap(supabase, rec);
        } else if (ev.type === "PACKAGE_TEMPLATE_UPDATED") {
          await upsertPackageTemplate(supabase, storeId, rec);
        } else if (ev.type === "CUSTOMER_PACKAGE_UPDATED") {
          await upsertCustomerPackage(supabase, storeId, rec);
        } else if (ev.type === "PRODUCT_SALE_CREATED") {
          await upsertProductSale(supabase, storeId, rec);
        } else if (ev.type === "STAFF_LEAVE_UPDATED") {
          await upsertStaffLeave(supabase, storeId, rec);
        } else if (ev.type === "STAFF_SHIFT_UPDATED") {
          await upsertStaffShift(supabase, storeId, rec);
        }
      }

      await supabase.from("salon_queue_events").upsert(
        {
          id: newId(),
          type: ev.type,
          entity_id: ev.entityId ?? null,
          payload: ev.payload ?? null,
          status: "synced",
          created_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    syncedCount: events.length,
    receivedAt: new Date().toISOString(),
  });
}
