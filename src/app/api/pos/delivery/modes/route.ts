import { NextResponse } from "next/server";

import { buildDeliveryModeMap, type PlatformOrderModeRow } from "@/lib/pos/delivery/delivery-mode";
import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * 平台單配送方式（澳覓 `sendType` / MFOOD `deliveryType`）→ `{ [pos_orders.id]: mode }`。
 *
 * ## 為什麼要另開一支 route（而唔係塞入 `/api/pos/state`）
 *
 * 2026-10-31 決定：**唔改現有 state route**（零風險），另開一支細端點。
 * - 只回 enum（`platform` / `merchant` / `pickup` / `unknown`），每張單幾十 bytes；
 * - `raw_json` 成 KB，**永遠唔會**離開伺服器；
 * - 前端只會喺訂單頁／快餐 strip 載入時打一次（帶當前見到嘅平台單 id），
 *   **冇 polling、冇 Realtime**。
 *
 * ## 為什麼要 client 傳 ids
 *
 * 唔傳 ids 就只好拉最近 48 小時全部平台單，會白讀一堆 raw_json。
 * 傳 ids 可以只讀「畫面上嗰幾張」，server→Supabase 嘅流量最省。
 * 冇傳 ids（例如第一次載入未計好）就 fallback 最近 48 小時、最多 100 張。
 *
 * ## 未跑 0054（冇 raw_json 欄）
 *
 * PostgREST 會回 `42703` / `PGRST204`。呢種情況回空 map（等於全部 unknown），
 * UI 會 fail-closed 唔顯示派送掣 —— 唔會爆、亦唔會誤派。
 */

export const dynamic = "force-dynamic";

const MAX_IDS = 100;
const FALLBACK_HOURS = 48;

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42703" || code === "PGRST204") return true;
  const message = String(error.message ?? "");
  return /column .*raw_json.* does not exist/i.test(message) ||
    /Could not find the 'raw_json' column/i.test(message);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: true, modes: {} });
  }

  // 🔒 放喺 early-return 之後：缺 storeId／未配置嘅回應完全不變
  const denied = posRouteAuthGuard(request, storeId, "pos/delivery/modes");
  if (denied) return denied;

  const ids = (searchParams.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, MAX_IDS);

  let query = supabase
    .from("pos_orders")
    .select("id,source,raw_json")
    .eq("store_id", storeId)
    .in("source", ["aomi", "mfood"])
    .limit(MAX_IDS);

  if (ids.length > 0) {
    query = query.in("id", ids);
  } else {
    const since = new Date(Date.now() - FALLBACK_HOURS * 3600 * 1000).toISOString();
    query = query.gte("created_at", since).order("created_at", { ascending: false });
  }

  const { data, error } = await query;

  if (error) {
    if (isMissingColumn(error)) {
      // 舊 schema：冇 raw_json → 全部當 unknown（fail-closed）
      return NextResponse.json({ ok: true, modes: {}, reason: "raw_json_missing" });
    }
    console.error("[pos/delivery/modes] 讀取失敗", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    modes: buildDeliveryModeMap((data ?? []) as unknown as PlatformOrderModeRow[]),
  });
}
