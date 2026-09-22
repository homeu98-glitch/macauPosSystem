import { NextResponse } from "next/server";

import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { getLedgerServiceClient } from "@/lib/ledger/admin-server";
import { EGRESS_FREE_QUOTA_BYTES, macauDayString, recentMacauDays } from "@/lib/pos/egress-usage";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * `/api/admin/traffic` — 每家店雲端用量（admin panel，migration 0048）。
 *
 * ## 為咩要有
 *
 * Supabase Dashboard 只會俾**專案總數**，但一個專案裡面有**多間店**
 * （`pos_*` 全部按 `store_id` 隔離）⇒ 商家答唔到「邊間店食咗幾多」、
 * 「加多一間店會唔會爆 5 GB 免費額」。2026-09-22 就係因為答唔到，
 * 要人手拉 Supabase ＋ Vercel log 去反推（實測 92% 流量來自一部舊 bundle 分頁）。
 *
 * ## 設計
 *
 * · **只回原始 row**（`pos_egress_daily`）＋店名對照，**唔喺 server 端分組／計 KPI** ——
 *   匯總邏輯收喺純模組 `@/lib/pos/egress-usage`（14 條單測），頁面用同一份，
 *   避免「API 一套、頁面另一套」口徑漂移（同 `/api/admin/sessions` 同一個做法）。
 * · **migration 未跑要 graceful**：`pos_egress_daily` 唔存在 → 回
 *   `{ ok: true, available: false, reason }`，令 admin 頁顯示「未啟用」而唔係爆 500。
 * · 鑑權同其他 admin API 一致（`readAdminSessionFromRequest`）。
 *
 * ## 口徑（頁面要寫明）
 *
 * 量到嘅係「Vercel Function → 瀏覽器／APK」嘅 response bytes；
 * Supabase 帳單官方口徑係「Supabase → Vercel Function」。方向相反、數量級一致
 * ⇒ 做相對比較足夠，精確對帳單請睇 Supabase Dashboard。
 */

/** 回傳 row 上限（90 日 × 多店 × 幾條路徑，遠低於此；純粹防呆）。 */
const MAX_ROWS = 20_000;
const MAX_STORES_FOR_NAMES = 2_000;

export async function GET(request: Request) {
  const claims = readAdminSessionFromRequest(request);
  if (!claims) {
    return NextResponse.json({ ok: false, error: "未授權，請先登入管理後台。" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const rawDays = Number.parseInt(searchParams.get("days") ?? "14", 10);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 90) : 14;

  const nowMs = Date.now();
  const dayList = recentMacauDays(nowMs, days);

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({
      ok: true,
      available: false,
      reason: "Supabase 未配置（mock / 本機環境）。",
      windowDays: dayList,
      days,
      quotaBytes: EGRESS_FREE_QUOTA_BYTES,
      today: macauDayString(nowMs),
      rows: [],
      stores: [],
    });
  }

  const { data, error } = await supabase
    .from("pos_egress_daily")
    .select("store_id, day, route, calls, bytes")
    .gte("day", dayList[0])
    .order("day", { ascending: false })
    .limit(MAX_ROWS);

  if (error) {
    // 42P01 = undefined_table（migration 0048 未跑）→ 唔好當錯，admin 頁照開得成。
    if (/42P01|does not exist/i.test(`${error.code ?? ""} ${error.message}`)) {
      return NextResponse.json({
        ok: true,
        available: false,
        reason: "未跑 migration 0048（pos_egress_daily 未建立）→ 用量計量尚未啟用。",
        windowDays: dayList,
        days,
        quotaBytes: EGRESS_FREE_QUOTA_BYTES,
        today: macauDayString(nowMs),
        rows: [],
        stores: [],
      });
    }
    console.error("[admin/traffic] query failed:", error.message);
    return NextResponse.json({ ok: false, error: "讀取用量失敗。" }, { status: 500 });
  }

  // 店名對照（Ledger `merchants`）。讀唔到 → 空陣列，前端 fallback 顯示 storeId。
  let stores: Array<{ id: string; name: string }> = [];
  try {
    const ledger = getLedgerServiceClient();
    if (ledger) {
      const { data: merchants } = await ledger
        .from("merchants")
        .select("id, name")
        .limit(MAX_STORES_FOR_NAMES);
      stores = (merchants ?? [])
        .map((row: { id?: string; name?: string | null }) => ({
          id: String(row.id ?? ""),
          name: row.name ?? String(row.id ?? ""),
        }))
        .filter((s) => s.id);
    }
  } catch {
    stores = [];
  }

  return NextResponse.json({
    ok: true,
    available: true,
    days,
    windowDays: dayList,
    today: macauDayString(nowMs),
    quotaBytes: EGRESS_FREE_QUOTA_BYTES,
    nowIso: new Date(nowMs).toISOString(),
    rows: (data ?? []).map((row: {
      store_id?: string | null;
      day?: string | null;
      route?: string | null;
      calls?: number | null;
      bytes?: number | null;
    }) => ({
      storeId: String(row.store_id ?? ""),
      day: String(row.day ?? ""),
      route: String(row.route ?? "other"),
      calls: Number(row.calls ?? 0),
      bytes: Number(row.bytes ?? 0),
    })),
    stores,
  });
}
