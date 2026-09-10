import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export async function POST(request: Request) {
  // 2026-09-10 審查 P3-5：呢支 API 保持**匿名開放** —— 客人掃碼落單一定要攞單號，
  // 冇可能要求登入。但一定要限流，否則知道 storeId 就可以無限消耗單號。
  if (!rateLimit(`pos-sequence:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const payload = (await request.json().catch(() => null)) as {
    kind?: "pos" | "pickup" | "counter" | "delivery";
    storeId?: string;
  } | null;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }
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
    // 唔可以 fake 一個隨機單號當成功：否則 kiosk 會顯示「訂單12」但其實冇寫入 DB。
    // 直接失敗，等 kiosk / 收銀見到真錯誤。
    return NextResponse.json(
      {
        ok: false,
        error: "Supabase 伺服器端未配置（缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY），無法取單號。",
      },
      { status: 503 },
    );
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
