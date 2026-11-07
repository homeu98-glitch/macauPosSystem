import { NextResponse } from "next/server";

import { readPublicStoreInfo, toPublicSettings } from "@/lib/pos/reservation/public";
import { reservationBizDate } from "@/lib/pos/reservation/biz-date";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * `GET /api/public/reservations/settings?storeId=xxx` —— 客人端開頁第一支。
 *
 * 匿名端點，**唔可以**用 `posRouteAuthGuard`（客人冇 POS 終端憑證）。
 * 防濫用靠 IP 限流；輸出靠 `toPublicSettings()` 白名單，唔會洩漏內部設定。
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`pub-rsv-settings:${ip}`, 60, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;
  if (!storeId) return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "伺服器未配置 Supabase。" }, { status: 503 });
  }

  const info = await readPublicStoreInfo(supabase, storeId);

  return NextResponse.json({
    ok: true,
    tableReady: info.tableReady,
    // 未設定過嘅店一律當未開放，唔可以因為 default 值就放人入嚟
    enabled: info.exists && info.settings.enabled && info.tableReady,
    storeName: info.storeName,
    currency: info.currency,
    storePhone: info.storePhone,
    today: reservationBizDate(new Date(), {}),
    settings: toPublicSettings(info.settings),
  });
}
