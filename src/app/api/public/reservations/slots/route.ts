import { NextResponse } from "next/server";

import { bizDateWindow, reservationBizDate } from "@/lib/pos/reservation/biz-date";
import { readPublicStoreInfo } from "@/lib/pos/reservation/public";
import { buildDaySlots } from "@/lib/pos/reservation/slots";
import type { SlotUsage } from "@/lib/pos/reservation/types";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * `GET /api/public/reservations/slots?storeId=xxx&date=YYYY-MM-DD`
 *
  * 同 POS 嘅 `/api/pos/reservations/slots` **共用同一套** `buildDaySlots()`
 * （時段生成 + 餘量 + 已過時間判斷），只係唔使 POS 憑證、輸出收窄。
 * 唔好喺客人頁自己計餘量 —— 兩套算法一定有一日對唔上，客人會揀到已滿時段。
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`pub-rsv-slots:${ip}`, 120, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;
  if (!storeId) return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });

  const supabase = getSupabaseWriteClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "伺服器未配置 Supabase。" }, { status: 503 });

  const info = await readPublicStoreInfo(supabase, storeId);
  if (!info.tableReady || !info.exists || !info.settings.enabled) {
    return NextResponse.json({ ok: true, enabled: false, slots: [] });
  }

  const today = reservationBizDate(new Date(), {});
  const dateParam = searchParams.get("date")?.trim() || null;
  const bizDate = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : today;
  // 唔可以查太遠將來：同 `validateReservationInput` 嘅 leadDaysMax 同一口徑
  const maxDate = new Date(`${today}T00:00:00Z`);
  maxDate.setUTCDate(maxDate.getUTCDate() + Math.max(1, info.settings.leadDaysMax));
  if (bizDate > maxDate.toISOString().slice(0, 10)) {
    return NextResponse.json({ ok: true, enabled: true, bizDate, slots: [], emptyReason: "too_far" });
  }

  const window = bizDateWindow(bizDate, info.settings.serviceHours);
  if (!window) {
    return NextResponse.json({ ok: true, enabled: true, bizDate, slots: [], emptyReason: "no_service_hours" });
  }

  const { data: rows, error } = await supabase.rpc("reservation_slot_usage", {
    p_store_id: storeId,
    p_from: window.start.toISOString(),
    p_to: window.end.toISOString(),
  });
  if (error) {
    console.error("[public/reservations/slots] 讀取用量失敗", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const usage = ((rows ?? []) as Array<{ slot_at: string; used: number; guests: number }>).map(
    (row): SlotUsage => ({ slotAt: row.slot_at, used: Number(row.used) || 0, guests: Number(row.guests) || 0 }),
  );
  const slots = buildDaySlots({ bizDate, settings: info.settings, usage });

  return NextResponse.json({
    ok: true,
    enabled: true,
    bizDate,
    today,
    quota: info.settings.slotQuota,
    turnMinutes: info.settings.turnMinutes,
    intervalMinutes: info.settings.slotIntervalMinutes,
    largePartyThreshold: info.settings.largePartyThreshold,
    slots,
  });
}
