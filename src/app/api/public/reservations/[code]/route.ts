import { NextResponse } from "next/server";

import { mapReservationRow, type ReservationRow } from "@/lib/pos/reservation/row";
import { maskPhone, phoneTail, publicReservationView, readPublicStoreInfo } from "@/lib/pos/reservation/public";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * `GET /api/public/reservations/[code]?storeId=xxx&tail=3456`
 *
 * 客人查單／成功頁重新整理用。
 *
 * 🔴 **雙因子**：`R1106-018` 係每日順序碼，好易猜。
 *    一定要同時驗「電話尾 4 位」先至可以回資料，否則任何人枚舉 code
 *    就拎到全店客人姓名同電話尾碼。
 *
 * 輸出仍然經 `publicReservationView()` 遮罩，唔會回完整電話。
 */

export const dynamic = "force-dynamic";

const COLUMNS = [
  "id", "store_id", "code", "biz_date", "slot_at", "party_size",
  "guest_name", "guest_phone", "guest_note", "status", "source",
  "table_id", "table_name", "order_id", "order_no", "items",
  "items_subtotal", "discount_amount", "payable_amount", "paid_amount",
  "paid_at", "payment_ref", "payment_method", "refund_amount", "refunded_at",
  "member_id", "member_discount_rate", "created_at", "confirmed_at",
  "arrived_at", "seated_at", "canceled_at", "cancel_reason", "updated_at",
].join(",");

type RouteContext = { params: Promise<{ code: string }> };

export async function GET(request: Request, context: RouteContext) {
  const ip = clientIp(request);
  if (!rateLimit(`pub-rsv-lookup:${ip}`, 30, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const { code } = await context.params;
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;
  const tail = (searchParams.get("tail") ?? "").replace(/\D/g, "").slice(-4);

  if (!storeId || !code) {
    return NextResponse.json({ ok: false, error: "缺少 storeId 或訂位碼。" }, { status: 400 });
  }
  if (tail.length !== 4) {
    return NextResponse.json({ ok: false, error: "請輸入聯絡電話尾 4 位。" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "伺服器未配置 Supabase。" }, { status: 503 });

  const { data, error } = await supabase
    .from("pos_reservations")
    .select(COLUMNS)
    .eq("store_id", storeId)
    .eq("code", code)
    .maybeSingle();

  if (error) {
    console.error("[public/reservations/[code]] 讀取失敗", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "找不到這張訂位。" }, { status: 404 });
  }

  const row = mapReservationRow(data as unknown as ReservationRow);
  if (phoneTail(row.guestPhone) !== tail) {
    // 唔好講「電話唔啱」定「code 唔存在」，避免變成枚舉 oracle
    return NextResponse.json({ ok: false, error: "找不到這張訂位。" }, { status: 404 });
  }

  const info = await readPublicStoreInfo(supabase, storeId);
  return NextResponse.json({
    ok: true,
    reservation: publicReservationView(row),
    storeName: info.storeName,
    storePhone: info.storePhone,
    notice: info.settings.notice,
    cancelCutoffMinutes: info.settings.cancelCutoffMinutes,
    guestPhoneMasked: maskPhone(row.guestPhone),
  });
}
