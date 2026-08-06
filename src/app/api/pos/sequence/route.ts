import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export async function POST(request: Request) {
  const payload = (await request.json()) as {
    kind?: "pos" | "pickup" | "counter" | "delivery";
    storeId?: string;
  };
  const kind =
    payload.kind === "pickup"
      ? "pickup"
      : payload.kind === "counter"
        ? "counter"
        : payload.kind === "delivery"
          ? "delivery"
          : "pos";
  const storeId = payload.storeId ?? "macau-store-a";

  const supabase = getSupabaseServerClient();

  const now = new Date();
  const bizDate = now.toISOString().slice(0, 10); // 先用 UTC 字串，SQL function 會用 Macau 時區更準

  if (!supabase) {
    const random = Math.floor(Math.random() * 99) + 1;
    return NextResponse.json({
      ok: true,
      source: "mock",
      kind,
      value: random,
      display:
        kind === "pickup"
          ? `自取${pad2(random)}`
          : kind === "counter"
            ? `取餐${pad2(random)}`
            : kind === "delivery"
              ? `外賣${pad2(random)}`
              : `訂單${pad2(random)}`,
      bizDate,
    });
  }

  // 優先使用 SQL function（若你已在 DB 裡建立）
  const { data: rpcData, error: rpcError } = await supabase.rpc("next_daily_sequence", {
    p_store_id: storeId,
    p_kind: kind,
  });

  if (!rpcError && typeof rpcData === "number") {
    return NextResponse.json({
      ok: true,
      source: "supabase",
      kind,
      value: rpcData,
      display:
        kind === "pickup"
          ? `自取${pad2(rpcData)}`
          : kind === "counter"
            ? `取餐${pad2(rpcData)}`
            : kind === "delivery"
              ? `外賣${pad2(rpcData)}`
              : `訂單${pad2(rpcData)}`,
      bizDate,
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error:
        rpcError?.message ??
        "找不到 next_daily_sequence()，請先在 Supabase 執行 migration SQL 建立序號函數。",
    },
    { status: 500 },
  );
}
