import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  normalizeGrabberSource,
  projectGrabberOrder,
  type GrabberOrder,
  type GrabberOrderRow,
} from "@/lib/grabber/grabber-order";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * 外賣平台（澳覓 / MFOOD）→ POS：插件推送訂單嘅入站端點。
 *
 * ── 呢條 route 只做三件事 ──────────────────────────────────────────────
 *   ① 驗身分（共享密鑰）　② 交畀 `projectGrabberOrder()` 轉換　③ 冪等寫入
 *   「payload → pos_orders 一列」嘅**所有判斷**都收喺 `lib/grabber/grabber-order.ts`
 *   （純函式、`node --test` 有覆蓋），呢度唔可以再寫業務邏輯，
 *   否則測試就保護唔到實際跑嘅嘢。
 *
 * ── 🔴 零影響原則 ────────────────────────────────────────────────────
 *   呢個檔案係**全新增**，唔改任何既有 route／元件。
 *   寫入用 `ON CONFLICT DO NOTHING`（`ignoreDuplicates`）→
 *   同一張單重複投遞唔會建立第二列，亦唔會覆蓋店員已經改過嘅內容。
 *
 * ── 為什麼唔可以 upsert（覆蓋）而係 DO NOTHING ────────────────────────
 *   平台單一入到 POS，店員就會開始動作（接受 → 製作中 → 完成 / 取消）。
 *   如果插件之後再送同一張單（列表每 5 秒重抓一次就會發生），
 *   **覆蓋**會把「已完成」打返「待確認」—— 呢個係最嚴重嘅一種資料損壞。
 *   ⇒ 一律 DO NOTHING，已存在就完全唔碰。
 *
 * ── 密鑰 ────────────────────────────────────────────────────────────
 *   `GRABBER_SHARED_SECRET`（環境變數）↔ 插件 `background.js` 嘅
 *   `POS_SHARED_SECRET`，兩邊要一樣。用 constant-time 比對。
 *   插件目前發嘅 header 名係 `X-Grabber-Secret`（見 `grabPush()`）。
 */

const SECRET_HEADER = "x-grabber-secret";

/** 限流：每分鐘 60 次（插件每 5 秒抓一次，一張單可能分列表＋詳情兩次送）。 */
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 60;
const attempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = attempts.get(key);
  if (!bucket || now >= bucket.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (bucket.count >= MAX_ATTEMPTS) return false;
  bucket.count += 1;
  return true;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** Constant-time 比對（避免用時間差逐字猜密鑰）。 */
function secretsMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 讀「自動接單」設定（**與 Ledger 線上單共用同一粒掣**，2026-09-24 使用者拍板）。
 *
 * ⚠️ 讀唔到（未跑 migration / 冇該店列）時**一律當「關」** → 訂單以 `draft`
 *    （待確認）入庫，等員工撳「接受」。呢個係保守方向：
 *    - 當「開」而錯 → 會自動出紙＋自動入營業額（錯咗要人手返結，代價高）
 *    - 當「關」而錯 → 訂單只係停在待確認（員工撳一下就返正常，代價低）
 */
async function readAutoAccept(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  storeId: string,
): Promise<{ autoAccept: boolean; readOk: boolean }> {
  const { data, error } = await supabase
    .from("pos_online_order_settings")
    .select("auto_accept")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error || !data) return { autoAccept: false, readOk: false };
  return { autoAccept: data.auto_accept === true, readOk: true };
}

export async function POST(request: Request) {
  const expected = process.env.GRABBER_SHARED_SECRET;
  if (!expected) {
    console.error("[integration/grabber/orders] GRABBER_SHARED_SECRET 未設定");
    return NextResponse.json({ ok: false, error: "伺服器未設定共享密鑰。" }, { status: 500 });
  }

  const given = request.headers.get(SECRET_HEADER) ?? "";
  if (!given || !secretsMatch(given, expected)) {
    return NextResponse.json({ ok: false, error: "密鑰驗證失敗。" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await request.text()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "JSON body 格式錯誤。" }, { status: 400 });
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON body 格式錯誤。" }, { status: 400 });
  }

  const storeId = typeof payload.storeId === "string" ? payload.storeId.trim() : "";
  if (!storeId) {
    // 插件要用家喺 popup 填 Store ID；冇填就一律拒收，唔好靜靜寫落錯店
    return NextResponse.json(
      { ok: false, error: "缺少 storeId（請在插件填 Store ID）。" },
      { status: 400 },
    );
  }

  const source = normalizeGrabberSource(payload.source);
  if (!source) {
    return NextResponse.json(
      { ok: false, error: `未知來源：${String(payload.source)}` },
      { status: 400 },
    );
  }

  const orders = Array.isArray(payload.orders) ? (payload.orders as GrabberOrder[]) : [];
  if (orders.length === 0) {
    return NextResponse.json({ ok: true, received: 0, created: 0, message: "冇訂單。" });
  }

  if (!checkRateLimit(`${storeId}:${clientIp(request)}`)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置，無法寫入訂單。" },
      { status: 503 },
    );
  }

  const { autoAccept, readOk } = await readAutoAccept(supabase, storeId);

  const rows: GrabberOrderRow[] = [];
  const rejected: { externalOrderId: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const order of orders) {
    const result = projectGrabberOrder({
      order,
      storeId,
      // ⚠️ Phase 2 唔傳餐牌 → 所有品項都當「對唔到」，分區用 kitchen。
      //    餐牌比對同日後嘅「平台訂單分區」（方案 A）屬 Phase 3。
      platformZone: null,
      defaultPrinterGroup: "kitchen",
      autoAccept,
    });

    if (!result.ok || !result.row) {
      rejected.push({
        externalOrderId: String(order?.externalOrderId ?? "(冇單號)"),
        reason: result.reason ?? "未知原因",
      });
      continue;
    }
    rows.push(result.row);
    for (const w of result.warnings) warnings.push(`${result.row.local_order_no}：${w}`);
  }

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      received: orders.length,
      created: 0,
      rejected,
      warnings,
      autoAccept,
    });
  }

  // 🔴 ignoreDuplicates = true → ON CONFLICT DO NOTHING。
  //    絕對唔可以改成覆蓋：會把店員已推進嘅狀態打返「待確認」。
  //    `.select("id")` 只回傳**真正新插入**嘅列 → 用嚟準確報 created。
  const { data: inserted, error } = await supabase
    .from("pos_orders")
    .upsert(rows, {
      onConflict: "store_id,source,external_order_id",
      ignoreDuplicates: true,
    })
    .select("id");

  if (error) {
    console.error("[integration/grabber/orders] 寫入失敗", error.message);
    return NextResponse.json({ ok: false, error: `寫入失敗：${error.message}` }, { status: 500 });
  }

  const created = Array.isArray(inserted) ? inserted.length : 0;

  return NextResponse.json({
    ok: true,
    received: orders.length,
    created,
    skipped: rows.length - created,
    rejected,
    warnings: warnings.slice(0, 10),
    autoAccept,
    autoAcceptReadOk: readOk,
  });
}
