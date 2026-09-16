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
   * 🔴 2026-09-16 再加固：**本 GET 已補上 POS 憑證閘**（同 DELETE 一致）。
   *
   * 舊註釋寫「本端點係對外主系統整合 API，所以唔加閘」—— 2026-09-16 實測
   * （`tools/audit-anon-endpoints.cjs`）確認：**匿名帶 storeId 即可抽走 269 KB / 500 張單**，
   * 而 storeId 係公開值（枱 QR = `/menu?tableId=…&store=<merchantId>`）⇒ 等於營業資料任人拖。
   * 當時亦確認**倉內完全冇 in-app GET 呼叫**（`local-orders-panel.tsx` 只用 DELETE），
   * 商家確認外部主系統未使用此端點 ⇒ 直接收閘。
   *
   * ⚠️ 若日後真係要對接外部主系統：唔好直接開返匿名，應該加一條服務憑證
   * （例：`Authorization: Bearer <INTEGRATION_API_TOKEN>`，env 缺失時 fail closed）。
   */
  if (!storeId) {
    return NextResponse.json({ ok: false, error: MISSING_STORE_MESSAGE }, { status: 400 });
  }

  const denied = posRouteAuthGuard(request, storeId, "pos/orders");
  if (denied) return denied;

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
