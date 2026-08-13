import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { normalizeBootstrapPayload } from "@/lib/bootstrap-normalizer";
import { mockBootstrap } from "@/lib/mock-data";

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!supabase) {
    const payload = normalizeBootstrapPayload(mockBootstrap);
    if (storeId) {
      return NextResponse.json({ ...payload, storeId });
    }
    return NextResponse.json(payload);
  }

  let query = supabase.from("pos_bootstrap_config").select("*");
  if (storeId) {
    query = query.eq("store_id", storeId);
  } else {
    query = query.order("updated_at", { ascending: false }).limit(1);
  }

  const { data, error } = await query.maybeSingle();

  if (error || !data) {
    return NextResponse.json(normalizeBootstrapPayload(mockBootstrap));
  }

  return NextResponse.json(
    normalizeBootstrapPayload({
      sourceVersion: data.source_version ?? 1,
      storeId: data.store_id,
      storeName: data.store_name,
      currency: data.currency,
      categories: data.categories,
      menuItems: data.menu_items,
      tables: data.tables,
      rules: data.rules,
      printerGroups: data.printer_groups,
      lastUpdatedAt: data.updated_at,
    }),
  );
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
    categories: unknown;
    menuItems: unknown;
    tables: unknown;
    rules: unknown;
    printerGroups: unknown;
  }>;

  const storeId = payload.storeId ?? "macau-store-a";
  const updatedAt = new Date().toISOString();

  const categories = payload.categories ?? [];
  const menuItems = payload.menuItems ?? [];
  const tables = payload.tables ?? [];
  const rules = payload.rules ?? {};
  const printerGroups = payload.printerGroups ?? [];

  const { error } = await supabase.from("pos_bootstrap_config").upsert(
    {
      store_id: storeId,
      source_version: 1,
      store_name: payload.storeName ?? "澳門店",
      currency: payload.currency ?? "MOP",
      categories,
      menu_items: menuItems,
      tables,
      rules,
      printer_groups: printerGroups,
      updated_at: updatedAt,
    },
    { onConflict: "store_id" },
  );

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, updatedAt });
}
