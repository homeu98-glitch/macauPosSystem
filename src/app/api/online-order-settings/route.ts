import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function GET() {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({
      ok: true,
      autoAccept: false,
    });
  }

  const { data, error } = await supabase
    .from("online_order_settings")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({
      ok: true,
      autoAccept: false,
    });
  }

  return NextResponse.json({
    ok: true,
    autoAccept: Boolean(data.auto_accept),
  });
}

export async function POST(request: Request) {
  const payload = await request.json();
  const supabase = getSupabaseServerClient();

  if (supabase) {
    const { error } = await supabase.from("online_order_settings").upsert(
      {
        store_id: payload?.storeId ?? "macau-store-a",
        auto_accept: Boolean(payload?.autoAccept),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id" },
    );

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    autoAccept: Boolean(payload?.autoAccept),
    updatedAt: new Date().toISOString(),
  });
}
