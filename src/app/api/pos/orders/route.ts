import { NextResponse } from "next/server";

import { MISSING_STORE_MESSAGE, posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  // 維持原有「未配置 Supabase（mock）→ 回空 orders」行為。
  if (!supabase) {
    return NextResponse.json({ ok: true, source: "mock", orders: [] });
  }

  /**
   * 🔴 2026-09-15 資安加固：**必須帶 storeId**。
   *
   * 以前 `storeId` 係 optional，唔帶就回「全平台最新 500 單」——
   * 即係任何人唔使登入、唔使知任何店 ID，一次 GET 就拖走全部店嘅訂單
   * （枱號、菜品、備註、金額、時間）。
   *
   * ⚠️ **為何呢條 GET 唔加 POS 憑證閘**（同其他 pos/* 唔一致，係刻意的）：
   * `docs/integration/main-system-integration.md` 同 `docs/06-api-reference.md`
   * 將本端點列為**對外嘅主系統整合 API**，外部主系統冇 `posDeviceToken`。
   * 加閘會直接打斷整合，所以呢一步只收窄「全平台傾倒」；
   * 要進一步收到「綁店」，需要同整合方協調另一套 service 憑證（已列入待辦）。
   */
  if (!storeId) {
    return NextResponse.json({ ok: false, error: MISSING_STORE_MESSAGE }, { status: 400 });
  }

  const query = supabase
    .from("pos_orders")
    .select("*")
    .eq("store_id", storeId)
    .order("updated_at", { ascending: false })
    .limit(500);
  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    source: "supabase",
    orders:
      data?.map((order) => ({
        id: order.id,
        localOrderNo: order.local_order_no,
        tableId: order.table_id,
        tableName: order.table_name,
        status: order.status,
        items: Array.isArray(order.items) ? order.items : [],
        orderNote: order.order_note ?? undefined,
        subtotal: Number(order.subtotal ?? 0),
        taxAmount: Number(order.tax_amount ?? 0),
        serviceChargeAmount: Number(order.service_charge_amount ?? 0),
        discountAmount: Number(order.discount_amount ?? 0),
        total: Number(order.total ?? 0),
        prepaidAmount: Number(order.prepaid_amount ?? 0),
        onlineOrderId: order.online_order_id ?? undefined,
        paymentMethod: order.payment_method ?? undefined,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
      })) ?? [],
  });
}

export async function DELETE(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  }

  // 無 Supabase（mock 模式）：本地由前端清，DB 無嘢要刪，當成功。
  if (!supabase) {
    return NextResponse.json({ ok: true, source: "mock", deleted: 0 });
  }

  // 🔒 2026-09-15 資安加固：本端點以前**完全冇鑑權**，只要知道 storeId（枱 QR 內容已公開）
  // 就可以**一鍵刪光該店所有線下訂單**（`online_order_id IS NULL`），營收紀錄無法復原。
  // ⚠️ 閘放喺 mock early-return 之後 → 未配置環境嘅既有回應完全不變。
  const denied = posRouteAuthGuard(request, storeId, "pos/orders");
  if (denied) return denied;

  // 只清「店內線下訂單」：online_order_id IS NULL。
  // exclude Ledger 線上單（online_order_id 唔空）→ 免同會員餘額 / 線上單脫鉤。
  const { count, error } = await supabase
    .from("pos_orders")
    .delete({ count: "exact" })
    .eq("store_id", storeId)
    .is("online_order_id", null);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, source: "supabase", deleted: count ?? 0, deletedAt: new Date().toISOString() });
}
