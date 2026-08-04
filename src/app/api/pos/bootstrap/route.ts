import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { normalizeBootstrapPayload } from "@/lib/bootstrap-normalizer";
import { mockBootstrap } from "@/lib/mock-data";

export async function GET() {
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json(normalizeBootstrapPayload(mockBootstrap));
  }

  const { data, error } = await supabase
    .from("pos_bootstrap_config")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

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
