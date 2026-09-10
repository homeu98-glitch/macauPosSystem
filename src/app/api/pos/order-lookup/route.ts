import { NextResponse } from "next/server";

import { mapOrderRow, PosOrderDbRow } from "@/lib/pos-order-row";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { isPlaceholderStoreId } from "@/lib/pos/store-id-guard";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * GET /api/pos/order-lookup?storeId=&orderId=
 *
 * 2026-09-10 掃碼點餐審查 P0-4 / P2-4。
 *
 * 【背景】客人手機「重複掃碼 resume」舊版打 `/api/pos/state?storeId=` —— 嗰支 API
 * **無鑑權**，一次回全店 200 單 + 300 queue + 200 printJobs + 打印模板 + 店級設定。
 * 即係「知道 storeId（QR 已公開）就可以拉走全店資料」，而且客人為咗查一張單
 * 要落幾百 KB 流量。
 *
 * 【本端點】
 *   - 只回**一張**單，而且要 `orderId` 精確匹配（訂單 id 係 UUID，不可枚舉）；
 *   - 只回**白名單欄位**（客人自己張單需要嘅嘢），唔回 queue / 打印任務 / 設定 / 模板；
 *   - per-IP rate limit。
 *
 * 註：客人掃碼本質係匿名，所以呢支 API 冇憑證要求（同落單一致），靠「UUID 不可枚舉 +
 * 精確匹配 + 限流」把關。要真正收緊就要引入客人 session（見 docs/110）。
 */

const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LEN = 128;

export async function GET(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`pos-order-lookup:${ip}`, 60, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || "";
  const orderId = searchParams.get("orderId")?.trim() || "";

  if (!storeId || storeId.length > 64 || !STORE_ID_PATTERN.test(storeId) || isPlaceholderStoreId(storeId)) {
    return NextResponse.json({ ok: false, error: "storeId 不合法。" }, { status: 400 });
  }
  if (!orderId || orderId.length > MAX_ID_LEN) {
    return NextResponse.json({ ok: false, error: "orderId 不合法。" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 未配置：唔可以當「查唔到」，亦唔可以亂回；客人端收到 null 就會當「冇未結單」正常落新單。
    return NextResponse.json({ ok: true, order: null });
  }

  // 白名單欄位 —— 唔好 `select("*")`（避免日後加咗內部欄位就被動外洩）。
  const { data, error } = await supabase
    .from("pos_orders")
    .select(
      "id,store_id,local_order_no,table_id,table_name,status,fulfillment_status,sent_to_kitchen_at,served_at," +
        "items,order_note,subtotal,tax_amount,service_charge_amount,discount_amount,total,prepaid_amount," +
        "online_order_id,source,payment_method,created_at,updated_at",
    )
    .eq("store_id", storeId)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error("[pos/order-lookup] 查詢失敗:", error.message);
    return NextResponse.json({ ok: false, error: "查詢訂單失敗。" }, { status: 500 });
  }

  // supabase-js 對「字串拼接嘅 select」推導唔到型別（會 infer GenericStringError），
  // 所以經 unknown 轉一次；欄位清單已由上面 select() 白名單鎖死。
  const row = data as unknown as PosOrderDbRow;
  return NextResponse.json({ ok: true, order: data ? mapOrderRow(row) : null });
}
