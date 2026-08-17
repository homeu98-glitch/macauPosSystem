import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { buildDefaultSalonBootstrap } from "@/lib/salon/mock-data";

// Salon Bootstrap 配置（店家主數據）。
// 模式與餐飲 /api/pos/bootstrap 一致：server-only Supabase + 未配置時 fallback mock。
// 表：salon_bootstrap_config

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!supabase) {
    return NextResponse.json({ ...buildDefaultSalonBootstrap(), source: "mock" });
  }

  let query = supabase.from("salon_bootstrap_config").select("*");
  if (storeId) {
    query = query.eq("store_id", storeId);
  } else {
    query = query.order("updated_at", { ascending: false }).limit(1);
  }

  const { data, error } = await query.maybeSingle();

  if (error || !data) {
    return NextResponse.json({ ...buildDefaultSalonBootstrap(), source: "mock" });
  }

  return NextResponse.json({
    source: "supabase",
    sourceVersion: data.source_version ?? 1,
    storeId: data.store_id,
    storeName: data.store_name,
    currency: data.currency ?? "MOP",
    serviceCategories: data.service_categories ?? [],
    serviceItems: data.service_items ?? [],
    staff: data.staff ?? [],
    stations: data.stations ?? [],
    calendarSlotMinutes: data.calendar_slot_minutes ?? 30,
    depositEnabled: data.deposit_enabled ?? false,
    defaultServiceDurationMinutes: data.default_service_duration_minutes ?? 60,
    lastUpdatedAt: data.updated_at,
  });
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 未配置" }, { status: 500 });
  }

  const payload = (await request.json()) as Partial<{
    storeId: string;
    storeName: string;
    currency: string;
    serviceCategories: unknown;
    serviceItems: unknown;
    staff: unknown;
    stations: unknown;
    calendarSlotMinutes: number;
    depositEnabled: boolean;
    defaultServiceDurationMinutes: number;
  }>;

  const storeId = payload.storeId ?? "demo-salon-001";
  const updatedAt = new Date().toISOString();

  const { error } = await supabase.from("salon_bootstrap_config").upsert(
    {
      store_id: storeId,
      source_version: 1,
      store_name: payload.storeName ?? "示範美容院",
      currency: payload.currency ?? "MOP",
      service_categories: payload.serviceCategories ?? [],
      service_items: payload.serviceItems ?? [],
      staff: payload.staff ?? [],
      stations: payload.stations ?? [],
      calendar_slot_minutes: payload.calendarSlotMinutes ?? 30,
      deposit_enabled: payload.depositEnabled ?? false,
      default_service_duration_minutes: payload.defaultServiceDurationMinutes ?? 60,
      updated_at: updatedAt,
    },
    { onConflict: "store_id" },
  );

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, updatedAt });
}
