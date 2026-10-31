import { NextResponse } from "next/server";

import { buildDeliveryJobDraft, canOverwriteJob } from "@/lib/pos/delivery/job-input";
import { mapDeliveryJobRow, type PosDeliveryJobRow } from "@/lib/pos/delivery/job-row";
import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * 外送派單列表（按店）。
 *
 * ## 為什麼係「手動拉」而唔係 Realtime
 *
 * 用戶 2026-10-31 明確要求：**零 polling、唔可以增加數據用量**。
 * 所以呢條 route 只會喺：
 *   ① 「外送」tab 開啟時拉一次；
 *   ② 用戶撳「手動刷新」時再拉一次。
 * 唔會 setInterval、唔會訂閱 `pos_delivery_jobs`（張表 service_role only）。
 *
 * ## 授權
 *
 * `posRouteAuthGuard()` —— POS 終端憑證（綁店）或 admin session。
 * 同 `pos/note-presets` 一樣：先做 early-return（缺 storeId／未配置 Supabase），
 * 再落閘，令「未配置」情境嘅回應同以前一樣。
 *
 * ## 未跑 migration
 *
 * `pos_delivery_jobs` 係 0076 新表。未跑 → PostgREST 回 `42P01` / `PGRST205`。
 * 呢種情況**唔當 500**：回 `tableReady:false`，UI 顯示「請先跑 migration」而唔會爆。
 */

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** 進行中（未送達、未取消）—— 同 `types.ts` 嘅 ACTIVE_JOB_STATUSES 一致。 */
const ACTIVE_STATUSES = ["draft", "queued", "new", "accepted", "picked_up"] as const;

const JOB_COLUMNS = [
  "id",
  "store_id",
  "order_source",
  "order_ref",
  "order_no_snapshot",
  "platform",
  "delivery_mode",
  "provider",
  "provider_order_id",
  "ledger_dispatch_id",
  "status",
  "last_event",
  "customer_name",
  "customer_phone",
  "customer_address",
  "customer_lat",
  "customer_lng",
  "customer_note",
  "fee_amount_avos",
  "fee_paid_by",
  "cod_amount_avos",
  "created_by",
  "created_at",
  "updated_at",
  "delivered_at",
].join(",");

/** PostgREST／Postgres 嘅「表未建立」訊號（兩種都要認，缺一會靜靜變 500）。 */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42P01" || code === "PGRST205") return true;
  const message = String(error.message ?? "");
  return /relation .*pos_delivery_jobs.* does not exist/i.test(message) ||
    /Could not find the table 'public\.pos_delivery_jobs'/i.test(message);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    // 未配置 server key：同 note-presets 一樣唔當錯誤，UI 顯示「未開通」而唔會爆
    return NextResponse.json({ ok: true, tableReady: false, jobs: [] });
  }

  // 🔒 放喺 early-return 之後：缺 storeId／未配置嘅回應完全不變
  const denied = posRouteAuthGuard(request, storeId, "pos/delivery/jobs");
  if (denied) return denied;

  const rawLimit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
    : DEFAULT_LIMIT;

  let query = supabase
    .from("pos_delivery_jobs")
    .select(JOB_COLUMNS)
    .eq("store_id", storeId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (searchParams.get("active") === "1") {
    query = query.in("status", [...ACTIVE_STATUSES]);
  }

  const { data, error } = await query;

  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({ ok: true, tableReady: false, jobs: [] });
    }
    console.error("[pos/delivery/jobs] 讀取失敗", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    tableReady: true,
    jobs: ((data ?? []) as unknown as PosDeliveryJobRow[]).map(mapDeliveryJobRow),
  });
}

/**
 * 建立／更新派單草稿。
 *
 * ## 現階段只寫 `draft`，唔會真的派出去
 *
 * 真正推送要 Ledger v3.6 開放 A1（線上派送）／B1（外部派單）。未開放之前：
 *   - 呢支 route 只落一筆 `status='draft'` 嘅本地紀錄；
 *   - 外送 tab 見到「草稿 · 待 Ledger 開通」；
 *   - 零外部副作用（唔會打 SiteB、唔會動 `orders.status`）。
 *
 * ## 為什麼要查舊 row 才 upsert
 *
 * `onConflict` 會直接覆蓋。如果張單已經有進行中嘅派單（`new` / `accepted` /
 * `picked_up`），覆蓋就等於**靜靜換走車手**，而車手 App 仲跑緊舊單。
 * 所以先 select：進行中 → 409；只有 draft／canceled／failed 才准蓋。
 *
 * ## 錯誤碼（對齊 v3.6 交接文件 §B1）
 *
 * | code | HTTP | 情境 |
 * |---|---|---|
 * | `bad_source` / `bad_ref` | 400 | 關聯鍵唔合法 |
 * | `platform_delivery` | 409 | 平台專送／未知配送方式 |
 * | `missing_phone` / `bad_phone` / `missing_address` | 400 | 送貨資料不足 |
 * | `bad_fee` / `bad_cod` / `bad_coords` | 400 | 數字超範圍 |
 * | `dispatch_exists` | 409 | 已有進行中派單 |
 */

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const storeId = String(payload.storeId ?? "").trim();
  if (!storeId) {
    return NextResponse.json({ ok: false, error: "missing_store" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "server_not_configured" }, { status: 503 });
  }

  // 🔒 放喺 early-return 之後：同 GET 一樣，未配置嘅回應不變
  const denied = posRouteAuthGuard(request, storeId, "pos/delivery/jobs");
  if (denied) return denied;

  const built = buildDeliveryJobDraft(payload);
  if (!built.ok) {
    // 平台專送係「業務上唔准」，同參數錯誤分開 status，方便 UI 出唔同文案
    const status = built.error === "platform_delivery" ? 409 : 400;
    return NextResponse.json({ ok: false, error: built.error }, { status });
  }

  const row = built.row;

  // 先查舊 row：進行中就唔准蓋（見上面註解）
  const existing = await supabase
    .from("pos_delivery_jobs")
    .select("id,status")
    .eq("store_id", storeId)
    .eq("order_source", row.order_source)
    .eq("order_ref", row.order_ref)
    .maybeSingle();

  if (existing.error && !isMissingTable(existing.error)) {
    console.error("[pos/delivery/jobs] 查舊派單失敗", existing.error.message);
    return NextResponse.json({ ok: false, error: existing.error.message }, { status: 500 });
  }
  if (existing.error && isMissingTable(existing.error)) {
    return NextResponse.json({ ok: false, error: "table_not_ready" }, { status: 503 });
  }

  const previous = existing.data as { id: string; status: string } | null;
  if (previous && !canOverwriteJob(previous.status)) {
    return NextResponse.json(
      { ok: false, error: "dispatch_exists", status: previous.status },
      { status: 409 },
    );
  }

  const { data, error } = await supabase
    .from("pos_delivery_jobs")
    .upsert(
      {
        store_id: storeId,
        ...row,
        updated_at: new Date().toISOString(),
        // 重派時要清走上一程嘅結果，否則會殘留「已送達」時間
        delivered_at: null,
        last_event: null,
        provider_order_id: null,
        ledger_dispatch_id: null,
      },
      { onConflict: "store_id,order_source,order_ref" },
    )
    .select(JOB_COLUMNS)
    .single();

  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({ ok: false, error: "table_not_ready" }, { status: 503 });
    }
    console.error("[pos/delivery/jobs] 寫入失敗", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    job: mapDeliveryJobRow(data as unknown as PosDeliveryJobRow),
  });
}
