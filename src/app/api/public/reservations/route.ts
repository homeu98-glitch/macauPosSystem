import { NextResponse } from "next/server";

import { createReservationRecord } from "@/lib/pos/reservation/create";
import {
  mapReservationRow,
  type ReservationRow,
} from "@/lib/pos/reservation/row";
import {
  maskPhone,
  phoneTail,
  publicReservationView,
  readPublicStoreInfo,
} from "@/lib/pos/reservation/public";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * `POST /api/public/reservations` —— 客人自助訂位（匿名）。
 *
 * ## 風險與對應
 *
 * | 風險 | 防線 |
 * |---|---|
 * | 刷單／DoS | IP 限流（10 次 / 分鐘），加 DB `dup_guard` 唯一索引 |
 * | 改價 | 核價全部喺 `createReservationRecord()` 由菜單現價重算，唔信 body 嘅金額 |
 * | 超賣 | `create_reservation` RPC 嘅 `pg_advisory_xact_lock` 原子扣配額 |
 * | 偽造來源／狀態 | `allowedSources: ["ledger"]`、`allowForceStatus: false` |
 * | 個資外洩 | 回傳經 `publicReservationView()` 遮罩；`console` 只記 code，唔記姓名電話 |
 * | 未開放嘅店 | 先 `readPublicStoreInfo()` 驗 `exists && enabled`，唔靠 default 值 |
 *
 * ⚠️ **唔好用 `posRouteAuthGuard`** —— 客人冇 POS 憑證。
 *    呢個端點可以寫入，靠嘅係上面五條防線，唔係身份驗證。
 */

export const dynamic = "force-dynamic";

const LIST_COLUMNS = [
  "id", "store_id", "code", "biz_date", "slot_at", "party_size",
  "guest_name", "guest_phone", "guest_note", "status", "source",
  "table_id", "table_name", "order_id", "order_no", "items",
  "items_subtotal", "discount_amount", "payable_amount", "paid_amount",
  "paid_at", "payment_ref", "payment_method", "refund_amount", "refunded_at",
  "member_id", "member_discount_rate", "created_at", "confirmed_at",
  "arrived_at", "seated_at", "canceled_at", "cancel_reason", "updated_at",
].join(",");

/**
 * `GET /api/public/reservations?storeId=xxx&phone=66123456`
 *
 * 「我嘅訂位」列表。要完整電話（唔係尾 4 位）先至列得出，
 * 而且 server 再用正規化數字逐張覆核，避免 `+853` / 空格 / 括號格式唔同而漏單。
 * 電話格式唔同係澳門常見（+853 / 6612 3456 / 66123456），
 * 所以先用尾 4 位 `ilike` 縮窄候選，再喺 JS 做精確比對。
 */
export async function GET(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`pub-rsv-list:${ip}`, 20, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;
  const rawPhone = searchParams.get("phone") ?? "";
  const phoneDigits = rawPhone.replace(/\D/g, "");
  if (!storeId || phoneDigits.length < 6) {
    return NextResponse.json({ ok: false, error: "請輸入完整聯絡電話。" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "伺服器未配置 Supabase。" }, { status: 503 });

  const tail = phoneTail(phoneDigits);
  const { data, error } = await supabase
    .from("pos_reservations")
    .select(LIST_COLUMNS)
    .eq("store_id", storeId)
    .ilike("guest_phone", `%${tail}`)
    .order("slot_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[public/reservations] 列表讀取失敗", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = ((data ?? []) as unknown as ReservationRow[])
    .map(mapReservationRow)
    .filter((row) => String(row.guestPhone).replace(/\D/g, "") === phoneDigits);

  return NextResponse.json({
    ok: true,
    reservations: rows.map(publicReservationView),
    guestPhoneMasked: maskPhone(phoneDigits),
  });
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`pub-rsv-create:${ip}`, 10, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }
  // 第二層：全店全局閘，防分散 IP 打同一間店
  if (!rateLimit("pub-rsv-create:global", 120, 60_000)) {
    return NextResponse.json({ ok: false, error: "系統繁忙，請稍後再試。" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const storeId = String(payload.storeId ?? "").trim();
  if (!storeId) return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });

  const supabase = getSupabaseWriteClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "伺服器未配置 Supabase。" }, { status: 503 });

  const info = await readPublicStoreInfo(supabase, storeId);
  if (!info.tableReady || !info.exists || !info.settings.enabled) {
    return NextResponse.json({ ok: false, code: "disabled", error: "本店未開放訂位。" }, { status: 403 });
  }

  const result = await createReservationRecord(
    supabase,
    {
      storeId,
      slotAt: String(payload.slotAt ?? ""),
      partySize: Number(payload.partySize),
      guestName: String(payload.guestName ?? ""),
      guestPhone: String(payload.guestPhone ?? ""),
      guestNote: String(payload.guestNote ?? ""),
      items: payload.items,
      // 客人端一律寫 ledger，唔接受 body 指定
      source: "ledger",
      memberId: null,
      createdBy: "customer-h5",
      forceStatus: null,
    },
    {
      allowedSources: ["ledger"],
      defaultSource: "ledger",
      allowForceStatus: false,
    },
  );

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: result.code,
        error: result.error,
        ...(result.tableReady === false ? { tableReady: false } : {}),
        ...(result.rejected ? { rejected: result.rejected } : {}),
      },
      { status: result.status },
    );
  }

  // 只記訂位碼，唔好 log 姓名／電話（個人資料）
  console.info("[public/reservations] 建立", result.reservation.code);

  return NextResponse.json(
    {
      ok: true,
      reservation: publicReservationView(result.reservation),
      storeName: info.storeName,
      storePhone: info.storePhone,
      notice: info.settings.notice,
      cancelCutoffMinutes: info.settings.cancelCutoffMinutes,
      guestPhoneMasked: maskPhone(result.reservation.guestPhone),
    },
    { status: 201 },
  );
}
