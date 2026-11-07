import { NextResponse } from "next/server";

import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { mapItemsForSeat, type MenuPriceLookup } from "@/lib/pos/reservation/items";
import type { MenuItemLite } from "@/lib/pos/reservation/pricing";
import { mapReservationRow, type ReservationRow } from "@/lib/pos/reservation/row";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * `/api/pos/reservations/[id]/seat-plan` —— 入座開枱前的「重算預覽」。
 *
 * ## 為什麼要獨立一支 GET
 *
 * 入座彈窗要顯示：哪幾道菜可以帶入、哪幾道已沽清／下架、按今日菜牌重算多少錢、
 * 跟已預付差多少。呢啲計算一定要用**當日菜單**，唔可以信訂位時的快照。
 *
 * 而且呢支係 **GET（無副作用）**：店員可以反覆打開核對，唔會改任何狀態。
 * 真正改狀態係 `PATCH /api/pos/reservations/[id]` 的 `action=seat`。
 *
 * ## 沽清
 *
 * `pos_soldout` 係另一張表（POS 自己）。呢度只校驗「菜單仍有這道菜」與「價格」；
 * 沽清由前端用本地 `soldOutMap` 再標一次 —— 兩邊都唔可以靜默刪。
 */

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

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

  const denied = posRouteAuthGuard(request, storeId, "pos/reservations/[id]/seat-plan");
  if (denied) return denied;

  const { data: row, error: readError } = await supabase
    .from("pos_reservations")
    .select("*")
    .eq("store_id", storeId)
    .eq("id", id)
    .maybeSingle();

  if (readError) {
    if (isMissingTable(readError)) {
      return NextResponse.json({ ok: false, tableReady: false, error: "訂位資料表未建立。" }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: readError.message }, { status: 500 });
  }
  if (!row) return NextResponse.json({ ok: false, error: "找不到這張訂位。" }, { status: 404 });

  const reservation = mapReservationRow(row as unknown as ReservationRow);

  if (reservation.status === "seated" || reservation.status === "completed") {
    return NextResponse.json(
      { ok: false, error: "這張訂位已經入座。" },
      { status: 409 },
    );
  }
  if (reservation.status === "canceled" || reservation.status === "no_show") {
    return NextResponse.json(
      { ok: false, error: "已取消／未到的訂位不可入座。" },
      { status: 409 },
    );
  }

  const { data: bootstrap } = await supabase
    .from("pos_bootstrap_config")
    .select("menu_items,rules")
    .eq("store_id", storeId)
    .maybeSingle();

  const menuItems = ((bootstrap?.menu_items ?? []) as unknown as MenuItemLite[]) ?? [];
  const rules = (bootstrap?.rules ?? {}) as { memberDiscountRate?: number };
  const discountRate =
    typeof rules.memberDiscountRate === "number" && rules.memberDiscountRate > 0 && rules.memberDiscountRate < 100
      ? rules.memberDiscountRate
      : null;

  const byId = new Map(menuItems.map((item) => [item.id, item]));
  const lookup: MenuPriceLookup = (menuItemId) => {
    const item = byId.get(menuItemId);
    if (!item) return null;
    return {
      name: item.name,
      price: Number(item.price) || 0,
      memberPrice: typeof item.memberPrice === "number" ? item.memberPrice : null,
      soldOut: item.soldOut === true || item.active === false,
    };
  };

  const plan = mapItemsForSeat({
    items: reservation.items,
    discountRate,
    lookup,
    paidAmount: reservation.paidAmount,
  });

  return NextResponse.json({
    ok: true,
    reservation,
    plan,
    /** 建議枱位條件：容量要夠坐 */
    requiredCapacity: reservation.partySize,
    turnMinutes: Number((await readTurnMinutes(supabase, storeId)) ?? 90),
  });
}

async function readTurnMinutes(
  supabase: NonNullable<ReturnType<typeof getSupabaseWriteClient>>,
  storeId: string,
): Promise<number> {
  const { data } = await supabase
    .from("pos_reservation_settings")
    .select("turn_minutes")
    .eq("store_id", storeId)
    .maybeSingle();
  const value = Number((data as { turn_minutes?: number } | null)?.turn_minutes);
  return Number.isFinite(value) && value > 0 ? value : 90;
}
