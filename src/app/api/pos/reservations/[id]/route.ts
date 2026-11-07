import { NextResponse } from "next/server";

import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import {
  canCancelReservation,
  canMarkArrived,
  canSeat,
  mapReservationRow,
  toReservationStatus,
  type ReservationRow,
} from "@/lib/pos/reservation/row";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * `/api/pos/reservations/[id]` —— 單張訂位的狀態操作。
 *
 * | Method | 用途 |
 * |---|---|
 * | GET   | 讀單張（含預點菜快照） |
 * | PATCH | 確認 / 到店 / 取消 / 未到 / 入座 / 改期 |
 *
 * ## 狀態機（唯一真源在 `row.ts` 的 `can*` 函數）
 *
 * ```
 * pending → confirmed → arrived → seated → completed
 *    ↓          ↓          ↓
 * canceled   no_show    no_show
 * ```
 *
 * ⚠️ `seated` 之後**不可**由訂位側取消 —— 菜已落廚房，要走訂單退款流程。
 */

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const COLUMNS = [
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
  return /pos_reservation/.test(String(error.message ?? ""));
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!storeId) return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  if (!id) return NextResponse.json({ ok: false, error: "缺少訂位 id" }, { status: 400 });

  const supabase = getSupabaseWriteClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "伺服器未配置 Supabase。" }, { status: 503 });

  const denied = posRouteAuthGuard(request, storeId, "pos/reservations/[id]");
  if (denied) return denied;

  const { data, error } = await supabase
    .from("pos_reservations")
    .select(COLUMNS)
    .eq("store_id", storeId)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({ ok: false, tableReady: false, error: "訂位資料表未建立。" }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ ok: false, error: "找不到這張訂位。" }, { status: 404 });

  return NextResponse.json({ ok: true, reservation: mapReservationRow(data as unknown as ReservationRow) });
}

type PatchBody = {
  storeId?: string;
  action?: string;
  tableId?: string;
  tableName?: string;
  orderId?: string;
  orderNo?: string;
  reason?: string;
  slotAt?: string;
  partySize?: number;
};

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const payload = (body ?? {}) as PatchBody;
  const storeId = String(payload.storeId ?? "").trim();
  const action = String(payload.action ?? "").trim();

  if (!storeId) return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  if (!id) return NextResponse.json({ ok: false, error: "缺少訂位 id" }, { status: 400 });
  if (!action) return NextResponse.json({ ok: false, error: "缺少 action" }, { status: 400 });

  const supabase = getSupabaseWriteClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "伺服器未配置 Supabase。" }, { status: 503 });

  const denied = posRouteAuthGuard(request, storeId, "pos/reservations/[id]");
  if (denied) return denied;

  const { data: current, error: readError } = await supabase
    .from("pos_reservations")
    .select(COLUMNS)
    .eq("store_id", storeId)
    .eq("id", id)
    .maybeSingle();

  if (readError || !current) {
    return NextResponse.json({ ok: false, error: "找不到這張訂位。" }, { status: 404 });
  }

  const reservation = mapReservationRow(current as unknown as ReservationRow);
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = { updated_at: nowIso };

  switch (action) {
    case "confirm": {
      if (reservation.status !== "pending") {
        return NextResponse.json({ ok: false, error: "只有待確認的訂位可以確認。" }, { status: 409 });
      }
      patch.status = "confirmed";
      patch.confirmed_at = nowIso;
      break;
    }

    case "arrive": {
      if (!canMarkArrived(reservation.status)) {
        return NextResponse.json(
          { ok: false, error: `「${reservation.status}」狀態不可標記到店。` },
          { status: 409 },
        );
      }
      patch.status = "arrived";
      patch.arrived_at = nowIso;
      break;
    }

    case "cancel": {
      if (!canCancelReservation(reservation.status)) {
        return NextResponse.json(
          { ok: false, error: "已入座的訂位不可取消，請走訂單退款流程。" },
          { status: 409 },
        );
      }
      patch.status = "canceled";
      patch.canceled_at = nowIso;
      patch.cancel_reason = String(payload.reason ?? "").slice(0, 200) || null;
      break;
    }

    case "no_show": {
      if (reservation.status !== "confirmed" && reservation.status !== "arrived") {
        return NextResponse.json({ ok: false, error: "只有已確認／已到店的訂位可以標記未到。" }, { status: 409 });
      }
      patch.status = "no_show";
      patch.canceled_at = nowIso;
      patch.cancel_reason = String(payload.reason ?? "未到").slice(0, 200);
      break;
    }

    case "seat": {
      if (!canSeat(reservation.status)) {
        return NextResponse.json(
          { ok: false, error: "只有已確認／已到店的訂位可以入座。" },
          { status: 409 },
        );
      }
      const tableId = String(payload.tableId ?? "").trim();
      if (!tableId) return NextResponse.json({ ok: false, error: "缺少枱號。" }, { status: 400 });

      patch.status = "seated";
      patch.seated_at = nowIso;
      patch.table_id = tableId;
      patch.table_name = String(payload.tableName ?? "").slice(0, 60) || null;
      patch.order_id = payload.orderId ? String(payload.orderId).slice(0, 120) : null;
      patch.order_no = payload.orderNo ? String(payload.orderNo).slice(0, 60) : null;
      break;
    }

    case "link_order": {
      // 入座當刻（`seat`）仲未有訂單 —— 張單係店員喺收銀台按「送廚房」先至生成。
      // 所以 order_id 要之後由 `pos-app` 補一次 PATCH（`order-link.ts`）。
      // 呢個 action **只寫訂單號、唔改狀態**，且係冪等：重複打唔會出事。
      if (reservation.status !== "seated" && reservation.status !== "completed") {
        return NextResponse.json({ ok: false, error: "只有已入座的訂位可以綁定訂單。" }, { status: 409 });
      }
      const orderId = String(payload.orderId ?? "").trim();
      if (!orderId) return NextResponse.json({ ok: false, error: "缺少訂單 id。" }, { status: 400 });
      // 已綁定另一張單就唔好覆寫：換枱／返結之後唔可以被遲到的舊事件蓋走。
      if (reservation.orderId && reservation.orderId !== orderId) {
        return NextResponse.json({ ok: false, error: "這張訂位已綁定其他訂單。" }, { status: 409 });
      }
      patch.order_id = orderId.slice(0, 120);
      patch.order_no = payload.orderNo ? String(payload.orderNo).slice(0, 60) : null;
      break;
    }

    case "complete": {
      if (reservation.status !== "seated") {
        return NextResponse.json({ ok: false, error: "只有已入座的訂位可以標記完成。" }, { status: 409 });
      }
      patch.status = "completed";
      break;
    }

    case "reschedule": {
      if (reservation.status === "seated" || reservation.status === "completed") {
        return NextResponse.json({ ok: false, error: "已入座的訂位不可改期。" }, { status: 409 });
      }
      const nextSlot = String(payload.slotAt ?? "").trim();
      if (!nextSlot) return NextResponse.json({ ok: false, error: "缺少新的時間。" }, { status: 400 });
      const at = new Date(nextSlot);
      if (Number.isNaN(at.getTime())) {
        return NextResponse.json({ ok: false, error: "時間格式不正確。" }, { status: 400 });
      }
      patch.slot_at = at.toISOString();
      patch.biz_date = nextSlot.slice(0, 10);
      if (Number.isFinite(Number(payload.partySize)) && Number(payload.partySize) > 0) {
        patch.party_size = Math.trunc(Number(payload.partySize));
      }
      break;
    }

    default:
      return NextResponse.json({ ok: false, error: `不支援的動作：${action}` }, { status: 400 });
  }

  const { data: updated, error: writeError } = await supabase
    .from("pos_reservations")
    .update(patch)
    .eq("store_id", storeId)
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (writeError) {
    if (isMissingTable(writeError)) {
      return NextResponse.json({ ok: false, tableReady: false, error: "訂位資料表未建立。" }, { status: 503 });
    }
    console.error("[pos/reservations/[id]] 更新失敗", writeError.message);
    return NextResponse.json({ ok: false, error: writeError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    reservation: mapReservationRow(updated as unknown as ReservationRow),
    status: toReservationStatus((updated as unknown as ReservationRow).status),
  });
}
