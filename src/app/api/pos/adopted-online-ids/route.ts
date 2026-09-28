// GET /api/pos/adopted-online-ids?storeId=xxx&hours=48
//
// 線上單自動補建嘅**雲端交叉核對**端點（2026-09-27）。
//
// ## 為咩要有呢條 route
//
// 2026-09-24 事故（見 `docs/reviews/order-001-missing-from-report-2026-09-24.md` §4）：
// 「Ledger 已完成 ＋ 已付款、但 POS 從未入帳」嘅線上單會令店內／交班／報表**靜默少計**。
// 修補入口係 `adoptCompletedLedgerOrderToLocal()`（`ledger-pos-bridge`），
// 佢**已經有**硬 guard：本機 `loadOrders()` 冇 `ledger-<id>` 才補。
//
// 🔴 但該 guard 有一個已知邊界：**本機 `loadOrders()` 只有當前裝置嘅歷史**。
//    換機／清過瀏覽器資料／新 iPad ⇒ 本機冇嗰張單嘅紀錄 ⇒
//    「其實雲端**早已經有**呢張單」都會被當成「漏帳」而再補一次。
//    補一次唔會雙計（`id = ledger-<ledgerId>` upsert），但會：
//      ① 用 Ledger 明細**覆蓋**店內加菜 ⇒ 金額縮水（2026-09-24 實案痛點）；
//      ② 令該行嘅 `updated_at` 被 server 重蓋 ⇒ 有機會漂去其他日。
//
// ⇒ 呢條 route 喺**補建之前**提供一次雲端查核：回傳該店近 N 小時內
//   「已經帶 `online_order_id`」嘅 Ledger 單 id 集合。客戶端把呢批 id
//   併入本地判準，就可杜絕上述「雲端明明有、本機以為冇」嘅誤補。
//
// ## 設計原則（嚴格遵守「不影響現有的功能」）
//
// - **唯讀**：只 SELECT，零寫入、零副作用。
// - **零 Ledger 耦合**：只讀 POS 自己嘅 `pos_orders`；唔查 Ledger 表（唔猜對方 schema）。
// - **零新增請求**：呼叫端搭既有節拍（見 `pos-app.tsx`），唔會多打一次。
// - **唔可以令補建失效**：呢條 route 壞（500／超時／未配置）時，呼叫端必須
//   fallback 返「只用本機判準」＝**行為同今日一致**，唔可以變成「因為查唔到所以唔補」。
// - **時間窗**：預設 48 小時（Ledger 線上單 + 補建單都唔會太舊；亦限制 egress）。
//
// ## 為何唔可以匿名
//
// 回傳嘅係該店成批 Ledger 單 id。知道 storeId（枱 QR 內容已公開）就可以攞到 ⇒
// 必須過 `posRouteAuthGuard`（POS 終端憑證／admin session，見 `@/lib/pos/pos-route-auth`）。
// 🔴 閘一定要放喺 `!supabase` 之後 —— 維持 mock／未配置環境嘅既有行為。
import { NextResponse } from "next/server";

import { jsonWithEgressLog } from "@/lib/egress-log-server";
import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { rateLimit } from "@/lib/pos/rate-limit";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** log 前綴（同 route 路徑一致，方便搵）。 */
const TAG = "[pos/adopted-online-ids]";

/** 回傳上限：一張單一行 `id + online_order_id`，2000 行 egress 仍然細（<100 KB）。 */
const MAX_ROWS = 2000;

/** 時間窗預設 48 小時；夾在 1–168 小時（7 日）。 */
const DEFAULT_HOURS = 48;
const MIN_HOURS = 1;
const MAX_HOURS = 168;

/** 每店每分鐘最多 30 次（呼叫端搭既有節拍，正常遠低於此）。 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;

function clampHours(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_HOURS;
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.floor(parsed)));
}

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;
  const hours = clampHours(searchParams.get("hours"));

  // 維持既有「未配置 Supabase（mock / 本機）」行為：回「空集合」而**唔係**報錯。
  // 呼叫端設計上會把「空集合」當「冇額外資訊」⇒ fallback 本機判準 ⇒ 行為同今日一致。
  if (!supabase) {
    return NextResponse.json({ ok: true, onlineOrderIds: [], configured: false });
  }

  // 🔒 閘放喺 `!supabase` 之後（同 `/api/pos/print-jobs/status` 一致）。
  const denied = posRouteAuthGuard(request, storeId, TAG);
  if (denied) return denied;

  // ⚠️ in-memory rate limit（每個 Vercel 實例一份）⇒ 多實例下實際更寬鬆，屬可接受
  //   （fail-open：呢條 route 只做讀取，唔會因為放行多幾次而壞事）。
  //   簽名：`rateLimit(key, max, windowMs)`（見 `@/lib/pos/rate-limit`）。
  if (!rateLimit(`pos-adopted-online-ids:${storeId}`, RATE_MAX, RATE_WINDOW_MS)) {
    return NextResponse.json(
      { ok: false, error: "請求過於頻繁，請稍後再試。" },
      { status: 429, headers: { "cache-control": "no-store" } },
    );
  }

  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  // 🔴 只拉兩個欄位（`id` / `online_order_id`）— 唔可以 `select("*")`：
  //    `items` / 收據內容係 mg 級，會令 egress 爆。
  // 🔴 `not(...is.null)` 過濾：只有「對應 Ledger 單」嘅行才需要。
  const { data, error } = await supabase
    .from("pos_orders")
    .select("id, online_order_id")
    .eq("store_id", storeId)
    .not("online_order_id", "is", null)
    .gte("updated_at", sinceIso)
    .order("updated_at", { ascending: false })
    .limit(MAX_ROWS);

  if (error) {
    console.warn(`${TAG} 查詢失敗（store=${storeId}）：`, error.message);
    // fail-open：回 200 + 空集合（呼叫端會 fallback 本機判準），而唔係 5xx 令呼叫端
    // 以為「系統壞」。⚠️ 但一定要帶 `degraded: true` 令呼叫端／log 睇得出係降級。
    return jsonWithEgressLog(
      TAG,
      { ok: true, onlineOrderIds: [], configured: true, degraded: true, error: error.message },
      { store: storeId, route: "pos/adopted-online-ids" },
      { storeId },
    );
  }

  const ids = new Set<string>();
  for (const row of data ?? []) {
    const value = (row as { online_order_id?: string | null }).online_order_id;
    if (typeof value === "string" && value) ids.add(value);
  }

  return jsonWithEgressLog(
    TAG,
    {
      ok: true,
      onlineOrderIds: Array.from(ids),
      configured: true,
      hours,
      truncated: (data?.length ?? 0) >= MAX_ROWS,
    },
    { store: storeId, route: "pos/adopted-online-ids" },
    { storeId },
  );
}
