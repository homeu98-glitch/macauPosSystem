import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { buildKdsBoard } from "@/lib/kds/kds-board";
import {
  authorizeKdsRequest,
  loadKdsItemStates,
  loadKdsOrders,
  loadKdsStationSources,
  toBoardInputs,
} from "@/lib/kds/kds-server";

/**
 * 後廚屏 / 出餐台屏「拉一次全部原料」（docs/116 §6.2）。
 *
 *   GET /api/pos/kds/board?storeId=<uuid>&station=kitchen
 *
 * 回嘅係**原始輸入**（訂單 + 單品狀態 + 工位來源），**唔係**砌好嘅板。
 * 客戶端用同一份純函式 `buildKdsBoard()` 本地砌 —— 見 route 底部嘅註解。
 *
 * 點解要另開端點，唔用 `/api/pos/orders`：
 *   後者冇回 `fulfillmentStatus` / `sentToKitchenAt` / `source`，而且係為收銀台而設。
 *   補欄會影響其他 caller，所以另開一條。
 *
 * ## 即時性
 *
 * 呢條端點係「一次性拉」。之後嘅增量靠 Realtime 訂閱 `pos_orders` /
 * `pos_kds_item_state`。⚠️ **重連之後一定要再拉一次**（`onResubscribed`）——
 * Realtime 唔會補發休眠期間嘅事件，唔補拉就會永遠少幾單。
 * 客戶端亦要喺 `visibilitychange → visible` 同「靜默 > 60 秒」時補拉。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ip = clientIp(request);
  // 屏唔會密集輪詢（只喺 mount / 重連 / 回前景 / 看門狗時拉），所以額度可以闊少少
  if (!rateLimit(`pos-kds-board:${ip}`, 240, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() ?? "";
  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId。" }, { status: 400 });
  }

  const auth = authorizeKdsRequest(request, storeId);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // ⚠️ 唔可以扮成功回空板：屏會顯示「冇單」而廚房實際有單 = 靜默漏單。
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置，後廚屏無法讀取訂單。" },
      { status: 503 },
    );
  }

  const station = searchParams.get("station")?.trim() ?? "";

  const ordersRes = await loadKdsOrders(supabase, storeId);
  if (ordersRes.error) {
    return NextResponse.json({ ok: false, error: ordersRes.error.message }, { status: 500 });
  }

  const orderIds = ordersRes.bundles.map((b) => b.order.id);
  const statesRes = await loadKdsItemStates(supabase, storeId, orderIds);
  if (statesRes.error) {
    return NextResponse.json({ ok: false, error: statesRes.error.message }, { status: 500 });
  }

  const sources = await loadKdsStationSources(supabase, storeId);
  const serverTime = new Date().toISOString();

  /**
   * ## ⚠️ 點解回**原始輸入**而唔係砌好嘅板
   *
   * 客戶端要用同一份純函式 `buildKdsBoard()` 做三件事：
   *   1. 樂觀 UI（撳 ✓ 即刻本地重算，唔等 network）
   *   2. Realtime 增量（收到一張單／一行狀態就本地套用，唔使再打 REST）
   *   3. 工位統計（「而家有幾多項未完成」）
   *
   * 如果 server 回「已經砌好、已經按工位篩過」嘅板，客戶端就冇原料重算，
   * 每次 Realtime 事件都要再打一次 REST —— 咁就變相係 polling，
   * 而且會出現「server 同 client 兩套砌板邏輯」嘅經典分歧。
   */
  const stations = buildKdsBoard({
    orders: toBoardInputs(ordersRes.bundles),
    states: statesRes.states,
    station: station || null,
    printerGroups: sources.printerGroups,
    menuItemGroups: sources.menuItemGroups,
  }).stations;

  return NextResponse.json({
    ok: true,
    serverTime,
    /** `{ order: PosOrder, itemKeys: string[] }` —— 直接餵得落 `buildKdsBoard()`。 */
    orders: toBoardInputs(ordersRes.bundles),
    states: statesRes.states,
    printerGroups: sources.printerGroups,
    menuItemGroups: sources.menuItemGroups,
    /** 由 server 預算一次（同 client 演算法一致），主要用嚟對帳 / 非 React 消費者。 */
    stations,
    /**
     * 🔴 `pos_kds_item_state` 唔存在（migration 0033 未跑）。
     * 屏**一定要**顯示大字警示：呢個狀態下所有 done_qty 都係 0，
     * 「撳 ✓ 永遠唔會 persist」= 廚房做咗但系統唔知（docs/116 §3.3）。
     */
    degraded: statesRes.tableMissing ? "kds_state_table_missing" : undefined,
  });
}
