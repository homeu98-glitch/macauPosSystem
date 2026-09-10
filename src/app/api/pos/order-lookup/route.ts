import { NextResponse } from "next/server";

import { mapOrderRow, PosOrderDbRow } from "@/lib/pos-order-row";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { isPlaceholderStoreId } from "@/lib/pos/store-id-guard";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * GET /api/pos/order-lookup?storeId=&orderId=   ← 精確單張（客人自己嘅單）
 * GET /api/pos/order-lookup?storeId=&tableId=   ← 依**台號**查該台未結嘅掃碼單
 *
 * 2026-09-10 掃碼點餐審查 P0-4 / P2-4。
 *
 * 【背景】客人手機「重複掃碼 resume」舊版打 `/api/pos/state?storeId=` —— 嗰支 API
 * **無鑑權**，一次回全店 200 單 + 300 queue + 200 printJobs + 打印模板 + 店級設定。
 * 即係「知道 storeId（QR 已公開）就可以拉走全店資料」，而且客人為咗查一張單
 * 要落幾百 KB 流量。
 *
 * 【本端點】
 *   - 只回**白名單欄位**（客人自己張單需要嘅嘢），唔回 queue / 打印任務 / 設定 / 模板；
 *   - per-IP rate limit。
 *
 * ## 點解要有 tableId 模式（2026-09-10 需求 1「資料以 DB 為準」）
 *
 * 舊版只有 `orderId` 模式，而客人端嘅 orderId 來自 `sessionStorage("kiosk-last-order")`。
 * 客人**第一次**掃 A01（換手機 / 清咗 session / 用另一部機）→ 冇 orderId → 舊 client
 * 直接 `return null` → 畫面當「新枱」顯示空白餐牌，但 DB 明明已經有 A01 嘅已下單菜品。
 *
 * 掃碼下單嘅查詢鍵本來就係**台號**（見需求 2：客人端唔需要、亦唔會見到單號）；
 * 所以呢度加 `tableId` 模式，回該台**所有非終態**嘅客人掃碼單（通常 0 或 1 張）。
 *
 * ## 為何只認 `source = "scan"`
 *
 * 同一張枱嘅 open 單可能係職員用收銀台落（`source="pos"`）或自助機落（`"kiosk"`）。
 * 呢啲單**唔可以**被掃碼端 resume 加菜：
 *   ① 收銀端嘅「自助單確認 / 拒絕」「加單補印廚房單」全部以 `isSelfOrder(order)`
 *      （`source ∈ {kiosk, scan}`）分流 —— 客人改咗一張 `source="pos"` 嘅單，收銀端
 *      **唔會**補印廚房單 → 廚房收唔到加嘅菜（靜默漏單，正是 2026-09-10 事故同一類病）；
 *   ② server 寫入會把 `source` / `local_order_no` 由職員單嘅值改成掃碼單嘅值，令
 *      報表 / 對單 / 打印模板全部走樣。
 * 所以掃碼端只 resume「客人自己嘅掃碼單」。若某枱嘅 open 單係職員落嘅，客人會見到
 * 正常點餐介面（唔會顯示空白），加點由職員處理 —— 呢個係**刻意邊界**，唔係漏做。
 */

const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LEN = 128;

/** 客人端要嘅白名單欄位 —— 唔好 `select("*")`（避免日後加咗內部欄位就被動外洩）。 */
const ORDER_COLUMNS =
  "id,store_id,local_order_no,table_id,table_name,status,fulfillment_status,sent_to_kitchen_at,served_at," +
  "items,order_note,subtotal,tax_amount,service_charge_amount,discount_amount,total,prepaid_amount," +
  "online_order_id,source,payment_method,created_at,updated_at";

/**
 * 台號查詢只回「未結」單：已結帳 / 已取消 / 已退款 / 已付款（快餐先收後做）嘅單
 * 對下一位客人嚟講係上一輪嘅事，唔應該 resume。
 *
 * ⚠️ 同 `kiosk-order.ts` 嘅 `TERMINAL_STATUSES` 必須保持一致（客戶端會再 filter 一次）。
 */
const NON_TERMINAL_FILTER = "(settled,cancelled,refunded,partially_refunded,paid)";

/** 一張枱同時有幾張未結掃碼單屬異常（正常 1 張）；回上限避免極端情況拉爆 payload。 */
const TABLE_ORDER_LIMIT = 20;

export async function GET(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`pos-order-lookup:${ip}`, 60, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || "";
  const orderId = searchParams.get("orderId")?.trim() || "";
  const tableId = searchParams.get("tableId")?.trim() || "";

  if (!storeId || storeId.length > 64 || !STORE_ID_PATTERN.test(storeId) || isPlaceholderStoreId(storeId)) {
    return NextResponse.json({ ok: false, error: "storeId 不合法。" }, { status: 400 });
  }
  if (!orderId && !tableId) {
    return NextResponse.json({ ok: false, error: "需要提供 orderId 或 tableId。" }, { status: 400 });
  }
  if (orderId.length > MAX_ID_LEN || tableId.length > MAX_ID_LEN) {
    return NextResponse.json({ ok: false, error: "查詢參數不合法。" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 未配置：唔可以當「查唔到」，亦唔可以亂回；客人端收到 null 就會當「冇未結單」正常落新單。
    return NextResponse.json({ ok: true, order: null, orders: [] });
  }

  // ── 模式 A：依**台號**查該台未結掃碼單（需求 1 / 2 嘅主查詢路徑）──
  if (tableId) {
    const { data, error } = await supabase
      .from("pos_orders")
      .select(ORDER_COLUMNS)
      .eq("store_id", storeId)
      .eq("table_id", tableId)
      .eq("source", "scan")
      .not("status", "in", NON_TERMINAL_FILTER)
      .order("created_at", { ascending: true })
      .limit(TABLE_ORDER_LIMIT);

    if (error) {
      console.error("[pos/order-lookup] 依台號查詢失敗:", error.message);
      return NextResponse.json({ ok: false, error: "查詢訂單失敗。" }, { status: 500 });
    }

    // supabase-js 對「字串拼接嘅 select」推導唔到型別 → 經 unknown 轉一次（欄位已由 select() 白名單鎖死）。
    const rows = (data ?? []) as unknown as PosOrderDbRow[];
    const orders = rows.map(mapOrderRow);
    return NextResponse.json({
      ok: true,
      // `order` = 最新一張（升序排嘅最後一張）—— 兼容舊 client 只讀 `order` 嘅寫法。
      order: orders.length > 0 ? orders[orders.length - 1] : null,
      orders,
    });
  }

  // ── 模式 B：精確單張（同一部手機重複掃碼，session 仲有 orderId）──
  const { data, error } = await supabase
    .from("pos_orders")
    .select(ORDER_COLUMNS)
    .eq("store_id", storeId)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error("[pos/order-lookup] 查詢失敗:", error.message);
    return NextResponse.json({ ok: false, error: "查詢訂單失敗。" }, { status: 500 });
  }

  const row = data as unknown as PosOrderDbRow;
  const order = data ? mapOrderRow(row) : null;
  return NextResponse.json({ ok: true, order, orders: order ? [order] : [] });
}
