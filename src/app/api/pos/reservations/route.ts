import { NextResponse } from "next/server";

import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { createReservationRecord } from "@/lib/pos/reservation/create";
import { mapReservationRow, type ReservationRow } from "@/lib/pos/reservation/row";
import { rangeToDates } from "@/lib/pos/reservation/slots";
import type { ReservationRange } from "@/lib/pos/reservation/types";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * `/api/pos/reservations` —— 訂位列表與建立。
 *
 * | Method | 用途 |
 * |---|---|
 * | GET  | 按營業日範圍／狀態撈列表（POS 訂位台、會員通後台共用） |
 * | POST | 建立訂位（**服務端核價** + DB 原子扣配額） |
 *
 * ## 為什麼建立要走 RPC 而不是直接 insert
 *
 * 配額必須在 DB 原子扣。兩個客人在 18:00 同時提交，各自讀到「剩 1 組」
 * 就會超賣。`create_reservation()` 用 `pg_advisory_xact_lock` 串行化同店同日，
 * 前端／route 完全唔參與配額判斷。
 *
 * ## 金額口徑
 *
 * 前端只傳 `menuItemId / qty / specs`。價錢、菜名、會員折扣一律由 server
 * 按 `pos_bootstrap_config` 的菜單現價重算（見 `pricing.ts`）。
 */

export const dynamic = "force-dynamic";

const MAX_LIMIT = 300;

const RESERVATION_COLUMNS = [
  "id",
  "store_id",
  "code",
  "biz_date",
  "slot_at",
  "party_size",
  "guest_name",
  "guest_phone",
  "guest_note",
  "status",
  "source",
  "table_id",
  "table_name",
  "order_id",
  "order_no",
  "items",
  "items_subtotal",
  "discount_amount",
  "payable_amount",
  "paid_amount",
  "paid_at",
  "payment_ref",
  "payment_method",
  "refund_amount",
  "refunded_at",
  "member_id",
  "member_discount_rate",
  "created_at",
  "confirmed_at",
  "arrived_at",
  "seated_at",
  "canceled_at",
  "cancel_reason",
  "updated_at",
].join(",");

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42P01" || code === "PGRST204" || code === "PGRST205") return true;
  const message = String(error.message ?? "");
  return /pos_reservation/.test(message) || /Could not find the '[^']*' column/.test(message);
}

/** 澳門今日 `YYYY-MM-DD`（澳門固定 UTC+8，無夏令時）。 */
function macauToday(now = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate(),
  ).padStart(2, "0")}`;
}

const VALID_RANGES: readonly ReservationRange[] = ["today", "tomorrow", "7d", "30d", "all"];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: true, tableReady: false, reservations: [], range: null });
  }

  const denied = posRouteAuthGuard(request, storeId, "pos/reservations");
  if (denied) return denied;

  const rangeParam = (searchParams.get("range") ?? "today") as ReservationRange;
  const range: ReservationRange = VALID_RANGES.includes(rangeParam) ? rangeParam : "today";
  const computed = rangeToDates(range, macauToday());

  const fromParam = searchParams.get("from")?.trim() || null;
  const toParam = searchParams.get("to")?.trim() || null;
  const from = fromParam ?? computed.from;
  const to = toParam ?? computed.to;

  const statusParam = searchParams.get("status")?.trim() || null;
  const statuses = statusParam ? statusParam.split(",").filter(Boolean) : [];

  const rawLimit = Number(searchParams.get("limit") ?? MAX_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
    : MAX_LIMIT;

  let query = supabase
    .from("pos_reservations")
    .select(RESERVATION_COLUMNS)
    .eq("store_id", storeId)
    .order("slot_at", { ascending: true })
    .limit(limit);

  if (from) query = query.gte("biz_date", from);
  if (to) query = query.lte("biz_date", to);
  if (statuses.length > 0) query = query.in("status", statuses);

  const { data, error } = await query;

  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({ ok: true, tableReady: false, reservations: [] });
    }
    console.error("[pos/reservations] 讀取失敗", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    tableReady: true,
    range: { from, to },
    reservations: ((data ?? []) as unknown as ReservationRow[]).map(mapReservationRow),
  });
}

/**
 * 建立訂位。核價／校驗／配額全部收歸 `createReservationRecord()`
 * （同客人端 `/api/public/reservations` 共用，避免兩個入口漂移）。
 * 呢度只負責：解析 body、檢查店 ID、POS 終端授權。
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const storeId = String(payload.storeId ?? "").trim();
  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "伺服器未配置 Supabase。" }, { status: 503 });
  }

  const denied = posRouteAuthGuard(request, storeId, "pos/reservations");
  if (denied) return denied;

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
      source: String(payload.source ?? "pos"),
      memberId: payload.memberId ? String(payload.memberId) : null,
      createdBy: payload.createdBy ? String(payload.createdBy) : null,
      forceStatus: payload.forceStatus ? String(payload.forceStatus) : null,
    },
    {
      allowedSources: ["pos", "ledger", "phone", "walkin"],
      defaultSource: "pos",
      allowForceStatus: true,
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
  return NextResponse.json({ ok: true, reservation: result.reservation }, { status: 201 });
}
