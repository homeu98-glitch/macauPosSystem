import { NextResponse } from "next/server";

import {
  normalizePeriodAmounts,
  type PlatformPeriodAmounts,
} from "@/lib/pos/platform-settlement";
import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * GET /api/pos/platform-settlements?storeId=xxx[&source=mfood][&limit=12]
 *
 * 回該店最近幾個**帳期**嘅平台結算金額（應收／實收／服務費）。
 *
 * ── 為什麼要有（2026-09-28 真機實證）────────────────────────────────
 * 逐單口徑（0060 `pos_orders.platform_*`）靠 `tradeNo` ↔ `external_order_id`
 * 配對，但**實測配對唔上** ⇒ 報表三格永遠冇數。
 * 帳期金額（`pos_platform_settlements`，migration 0061）係平台**一定有**嘅數字，
 * 報表用它做保底。呢支 route 就係嗰條讀取通道。
 *
 * ── 🔴 鑑權 ────────────────────────────────────────────────────────
 * 財務數字係商家敏感資料 ⇒ 用 `posRouteAuthGuard`（POS 終端憑證 / admin session，
 * 且**綁店**：`claims.storeId === storeId`）。唔可以開放 anon 讀取。
 * （報表本身跑喺已登入嘅 POS 或 admin 環境，唔會受影響。）
 *
 * ── ⚠️ 口徑 ────────────────────────────────────────────────────────
 * 回嘅係**帳期**級數字，同逐單加總唔同，**唔可以相加**。
 * 呼叫端（報表）要負責標示用咗邊個口徑 —— 呢度只回原始資料。
 *
 * ── 未配置 / 查唔到 ────────────────────────────────────────────────
 * 一律回 `{ ok: true, settlements: [] }`，唔回 500 ——
 * 「未有對帳資料」係**合法狀態**（新店、未跑 migration 0061），
 * 唔應該令報表整塊壞掉。真正嘅 DB 錯誤才 500（並寫 log）。
 */
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 60;

/** 只接受已知來源（同 `normalizeGrabberSource` 同一套值）。 */
const KNOWN_SOURCES = new Set(["mfood", "aomi"]);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  // 授權閘（含 missing-store 判準）—— 通過回 null
  const denied = posRouteAuthGuard(request, storeId, "pos/platform-settlements");
  if (denied) return denied;
  // 到呢度 storeId 一定有值（guard 已擋 null），但 TS 唔知 → 再收窄一次
  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId。" }, { status: 400 });
  }

  const sourceParam = searchParams.get("source")?.trim() || "";
  if (sourceParam && !KNOWN_SOURCES.has(sourceParam)) {
    return NextResponse.json(
      { ok: false, error: `未知來源：${sourceParam}` },
      { status: 400 },
    );
  }

  const limitRaw = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 未配置：唔可以當「有數」，亦唔可以 500 令報表壞掉 → 回空
    return NextResponse.json({ ok: true, settlements: [] });
  }

  let query = supabase
    .from("pos_platform_settlements")
    .select("source,period,should_amount,receive_amount,subsidy_amount,service_fee,fetched_at")
    .eq("store_id", storeId)
    .order("fetched_at", { ascending: false })
    .limit(limit);
  if (sourceParam) query = query.eq("source", sourceParam);

  const { data, error } = await query;

  if (error) {
    // 🔴 未跑 migration 0061 時，Postgres 會報 "relation does not exist"。
    //    呢種情況**唔應該**令報表 500（商家只係未跑 migration）→ 回空 + warn。
    const missingTable = /does not exist|schema cache/i.test(error.message);
    if (missingTable) {
      console.warn(
        "[pos/platform-settlements] 表不存在（未跑 migration 0061？）",
        error.message,
      );
      return NextResponse.json({ ok: true, settlements: [] });
    }
    console.error("[pos/platform-settlements] 查詢失敗", error.message);
    return NextResponse.json({ ok: false, error: "查詢平台帳期資料失敗。" }, { status: 500 });
  }

  type Row = {
    source: string | null;
    period: string | null;
    should_amount: number | string | null;
    receive_amount: number | string | null;
    subsidy_amount: number | string | null;
    service_fee: number | string | null;
    fetched_at: string | null;
  };

  const rows = (data ?? []) as unknown as Row[];

  // 正規化經純函式（`normalizePeriodAmounts`）—— 同入庫同一套口徑，唔可以兩邊各寫一份
  const settlements = rows
    .map((r) => {
      const n = normalizePeriodAmounts({
        period: r.period,
        should: r.should_amount,
        receive: r.receive_amount,
        subsidy: r.subsidy_amount,
        fee: r.service_fee,
      });
      if (!n) return null;
      return {
        source: r.source ?? "",
        period: n.period,
        should: n.should,
        receive: n.receive,
        subsidy: n.subsidy,
        fee: n.fee,
        fetchedAt: r.fetched_at,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  // 最新一筆（`order by fetched_at desc` 已保證第一筆最新）
  const latest: PlatformPeriodAmounts & { source: string; fetchedAt: string | null } | null =
    settlements.length > 0
      ? {
          period: settlements[0].period,
          should: settlements[0].should,
          receive: settlements[0].receive,
          subsidy: settlements[0].subsidy,
          fee: settlements[0].fee,
          source: settlements[0].source,
          fetchedAt: settlements[0].fetchedAt,
        }
      : null;

  return NextResponse.json({ ok: true, settlements, latest });
}
