import { NextResponse } from "next/server";

import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { mapOrderRow } from "@/lib/pos-order-row";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * GET /api/admin/orders — admin panel 跨店訂單讀取（只讀）。
 *
 * Query params：
 * - storeId（可選）：不帶 = 全部店（「全部」彙總報表 / 總覽用）；帶 = 指定店
 * - start / end（可選）：ISO 區間，過濾 created_at（同 /api/pos/state 口徑一致）
 * - limit（默認 500，夾 [1, 5000]）、offset（分頁）
 *
 * 把關：admin session token（呢個 endpoint 可以跨店讀單，唔可以好似
 * /api/pos/state 咁開放——收銀工作台嗰個係店內信任環境，admin 呢個係全店視角）。
 */

export async function GET(request: Request) {
  const claims = readAdminSessionFromRequest(request);
  if (!claims) {
    return NextResponse.json({ ok: false, error: "未授權，請先登入管理後台。" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

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

  const start = searchParams.get("start")?.trim() || null;
  const end = searchParams.get("end")?.trim() || null;

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ ok: true, source: "mock", orders: [] });
  }

  let query = supabase.from("pos_orders").select("*");
  if (storeId) query = query.eq("store_id", storeId);
  if (start && end) {
    // 同 /api/pos/state 一致：created_at OR updated_at 落喺區間內都收，
    // 覆蓋「區間內開單」同「區間內結帳」兩種情況。
    query = query.or(
      `and(created_at.gte.${start},created_at.lte.${end}),and(updated_at.gte.${start},updated_at.lte.${end})`,
    );
  } else if (start) {
    query = query.gte("created_at", start);
  } else if (end) {
    query = query.lte("created_at", end);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ ok: false, error: "讀取訂單失敗。", detail: error.message }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    scope: storeId ?? "all",
    orders: (data ?? []).map((row) => mapOrderRow(row as Parameters<typeof mapOrderRow>[0])),
    limit,
    offset,
  });
}
