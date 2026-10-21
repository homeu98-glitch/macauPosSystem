import { NextResponse } from "next/server";

import { requireAdmin, storeFilterOrDeny } from "@/lib/admin-guard.server";
import { mapOrderRow } from "@/lib/pos-order-row";
import { fetchOrdersInRange } from "@/lib/pos-orders-range";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * GET /api/admin/orders — admin panel 跨店訂單讀取（只讀）。
 *
 * Query params：
 * - storeId（可選）：不帶 = 全部店（「全部」彙總報表 / 總覽用）；帶 = 指定店
 * - start / end（可選）：ISO 區間；過濾口徑 = `created_at ∈ 區間 OR updated_at ∈ 區間`
 *   （同 /api/pos/state 及報表 client 端 orderMatchesReportRange 一致）
 * - limit（默認 500，夾 [1, 5000]）、offset（分頁）
 *
 * 把關：admin session token（呢個 endpoint 可以跨店讀單，唔可以好似
 * /api/pos/state 咁開放——收銀工作台嗰個係店內信任環境，admin 呢個係全店視角）。
 *
 * 問題 6（2026-09-06 修）：
 * - start / end 一律轉 UTC ISO（`...Z`）——同一 instant 嘅 lossless 表示，
 *   徹底避開 PostgREST 對 `+08:00` offset 值嘅解析歧義。
 * - 區間過濾改用 `fetchOrdersInRange()` 兩腿合併（見 src/lib/pos-orders-range.ts）：
 *   OR 語義（超集），唔再用 `.or()` nested 語法，亦唔會好似中間版嘅 AND chain
 *   咁漏「昨日開單、今日結帳」嘅單。
 */

function toUtcIso(iso: string): string {
  // 接受 "2026-09-06T00:00:00+08:00" / "2026-09-06T00:00:00Z" / "2026-09-06"，統一轉 UTC ISO。
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString();
}

export async function GET(request: Request) {
  // 🔴 2026-10-21（P1）：唔再係「有 token = 睇全部」。
  // scope 由 server 解析；`storeId` 必須 ∈ scope，否則 403（唔可以靜默降級）。
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.res;
  const { claims, scope } = guard;

  const { searchParams } = new URL(request.url);
  const requestedStoreId = searchParams.get("storeId")?.trim() || null;
  const filter = storeFilterOrDeny(scope, requestedStoreId, request);
  if (!filter.ok) return filter.res;
  /** null = 平台級「全部店」；陣列 = scope 內店舖（空陣列 = 一間都冇）。 */
  const storeIds = filter.storeIds;

  const rawLimit = searchParams.get("limit");
  let limit = 500;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5000) {
      return NextResponse.json({ ok: false, error: "limit 必須為 1–5000 的整數。" }, { status: 400 });
    }
    limit = parsed;
  }

  const rawOffset = searchParams.get("offset");
  let offset = 0;
  if (rawOffset !== null) {
    const parsed = Number.parseInt(rawOffset, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000) {
      return NextResponse.json({ ok: false, error: "offset 必須為 0–100000 的整數。" }, { status: 400 });
    }
    offset = parsed;
  }

  // 問題 6（2026-09-06 修）：轉 UTC ISO 避開 `+08:00` 解析歧義。
  const start = searchParams.get("start")?.trim() ? toUtcIso(searchParams.get("start")!.trim()) : null;
  const end = searchParams.get("end")?.trim() ? toUtcIso(searchParams.get("end")!.trim()) : null;

  // 🩺 可觀測性（2026-09-07 修）：每次請求都 log 入參，排查空數據時直接睇 server log。
  // 對照前端 Network tab 嘅 query string，可以一眼睇出係「前端冇傳」定「後端查唔到」。
  console.log("[admin/orders] request", {
    account: claims.account,
    storeIds: storeIds ?? "all",
    startRaw: searchParams.get("start"),
    endRaw: searchParams.get("end"),
    start,
    end,
    limit,
    offset,
  });

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 🩺 2026-09-07 修：**唔可以再 fail-open 返 `ok: true` + 空陣列**。
    // 舊版喺 Supabase 未配置（缺 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）時靜默返空，
    // 前端完全分唔到「今日真係冇單」定「資料庫未連到」，只會顯示一片空白——
    // 呢個係「報表完全無數據」最常見嘅隱性根因。而家改成 fail-closed 出 503 + 明確 code。
    const missing: string[] = [];
    if (!process.env.SUPABASE_URL && !process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY && !process.env.SUPABASE_ANON_KEY) {
      missing.push("SUPABASE_SERVICE_ROLE_KEY");
    }
    console.error("[admin/orders] supabase_not_configured", { missing });
    return NextResponse.json(
      {
        ok: false,
        code: "supabase_not_configured",
        error: `POS 資料庫未配置（缺少 ${missing.join(" / ")}），無法讀取訂單。`,
      },
      { status: 503 },
    );
  }

  const { orders, error } = await fetchOrdersInRange({ supabase, storeIds, start, end, limit, offset });

  if (error) {
    console.error("[admin/orders] query_failed", { storeIds, start, end, limit, offset, error });
    return NextResponse.json({ ok: false, error: "讀取訂單失敗。", detail: error }, { status: 502 });
  }

  // 🩺 可觀測性：記錄實際查到嘅筆數 + 區間，0 筆時用 warn 方便喺 log 度 grep。
  const summary = { account: claims.account, storeIds: storeIds ?? "all", start, end, count: orders.length };
  if (orders.length === 0) {
    console.warn("[admin/orders] empty_result", summary);
  } else {
    console.log("[admin/orders] result", summary);
  }

  return NextResponse.json({
    ok: true,
    // 回傳實際過濾範圍：null = 全部店；陣列 = 只含這些店（前端可用嚟核對「我睇緊邊幾間」）
    scope: storeIds ?? "all",
    orders: orders.map((row) => mapOrderRow(row)),
    limit,
    offset,
    // 🩺 畀前端／排查用：直接喺 response 帶住查詢條件，唔使再對照 log 推敲。
    debug: { start, end, count: orders.length },
  });
}
