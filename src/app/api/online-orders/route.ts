import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

type OnlineOrderType = "dine_in" | "pickup" | "self_delivery" | "rider_delivery";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = (searchParams.get("type") ?? "dine_in") as OnlineOrderType;

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({
      ok: true,
      source: "mock",
      orders: [
        {
          id: "online-001",
          type,
          status: "new",
          customerName: "線上客戶",
          total: 86,
          createdAt: new Date().toISOString(),
          items: [
            { name: "叉燒飯", qty: 1 },
            { name: "凍檸茶", qty: 2 },
          ],
        },
      ],
    });
  }

  // 預留：你之後告訴我實際表名/欄位，我就把這段換成真查詢
  // 目前先用一個通用假設：表名 online_orders
  const { data, error } = await supabase
    .from("online_orders")
    .select("*")
    .eq("type", type)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json(
      { ok: false, source: "supabase", error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, source: "supabase", orders: data ?? [] });
}

