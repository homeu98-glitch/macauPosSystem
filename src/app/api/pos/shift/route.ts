import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { isPlaceholderStoreId } from "@/lib/pos/store-id-guard";

/**
 * GET/POST /api/pos/shift — 開工/收工班次狀態嘅雲端真源（跨裝置同步）。
 *
 * 背景：開工狀態以前只存 localStorage（每機各自為政，換機/換 browser 永遠「未開工」）。
 * 依家 `pos_shifts` 一張表 = 一個班次一行，active = `closed_at IS NULL`；
 * 每店同一時間最多一個 active 班次（DB partial unique index 保證）。
 *
 * 對應 docs/109-shift-sync-overtime-plan.md 同 supabase/migrations/0023_pos_shifts.sql。
 *
 * - GET  ?storeId=xxx          → 回傳該店 active 班次（冇就 null）+ serverNow
 * - POST action=open           → 開工（已有 active → conflict:true，以現有為準，唔另開新班次）
 * - POST action=close          → 收工（寫 closed_at + 統計，active 必須存在）
 * - POST action=ackOvertime    → 記錄「取消逾時提醒」時間（連續開工 >10h 提醒嘅權威 ack）
 *
 * 安全：同 /api/pos/sync 一致 —— service_role 寫入、storeId 白名單 + 假店黑名單、
 * 欄位長度/型別驗證、唔對外洩漏 DB 內部錯誤。
 */

const MAX_STORE_ID_LEN = 64;
const MAX_NAME_LEN = 200;
const MAX_TEXT_LEN = 2000;
const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 截斷字串（防超長寫爆 text/jsonb 欄）。非字串一律 null。 */
function text(value: unknown, maxLen = MAX_TEXT_LEN): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

/** ISO 時間戳驗證（timestamptz 欄位收到非法字串會令成個 query 報錯）。 */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** 金額：非數字 → undefined（唔寫）。clamp ±1e9。 */
function moneyOrUndef(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(-1_000_000_000, Math.min(1_000_000_000, n));
}

/** DB 蛇形 row → client camelCase。summary jsonb 照傳。 */
function mapRow(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    storeId: row.store_id as string,
    employeeAccount: (row.employee_account as string | null) ?? undefined,
    employeeName: (row.employee_name as string | null) ?? undefined,
    openedAt: row.opened_at as string,
    openingNote: (row.opening_note as string | null) ?? undefined,
    overtimeAckedAt: (row.overtime_acked_at as string | null) ?? undefined,
    closedAt: (row.closed_at as string | null) ?? undefined,
    closingNote: (row.closing_note as string | null) ?? undefined,
    actualCash: (row.actual_cash as number | null) ?? undefined,
    cashDifference: (row.cash_difference as number | null) ?? undefined,
    summary: (row.summary as Record<string, unknown> | null) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function activeShiftQuery(
  supabase: NonNullable<ReturnType<typeof getSupabaseWriteClient>>,
  storeId: string,
) {
  return supabase
    .from("pos_shifts")
    .select("*")
    .eq("store_id", storeId)
    .is("closed_at", null)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

/** storeId 驗證（同 /api/pos/sync 口徑）。合法就回傳，否則回傳 error response。 */
function validateStoreId(rawStoreId: string): { storeId: string } | { error: NextResponse } {
  if (!rawStoreId) {
    return {
      error: NextResponse.json(
        { ok: false, error: "缺少 storeId：請重新登入 POS 帳號後再試。" },
        { status: 400 },
      ),
    };
  }
  if (rawStoreId.length > MAX_STORE_ID_LEN || !STORE_ID_PATTERN.test(rawStoreId)) {
    return { error: NextResponse.json({ ok: false, error: "storeId 格式不合法" }, { status: 400 }) };
  }
  if (isPlaceholderStoreId(rawStoreId)) {
    return {
      error: NextResponse.json(
        {
          ok: false,
          error:
            `storeId「${rawStoreId}」係示範店代碼，唔係真實商戶 ID。請重新登入 POS 帳號 —— ` +
            `本機帶住嘅店舖識別應該係登入攞到嘅 merchants.id。`,
        },
        { status: 400 },
      ),
    };
  }
  return { storeId: rawStoreId };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const checked = validateStoreId((searchParams.get("storeId") ?? "").trim());
  if ("error" in checked) return checked.error;
  const { storeId } = checked;

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置（缺少 SUPABASE_SERVICE_ROLE_KEY）。" },
      { status: 503 },
    );
  }

  const { data, error } = await activeShiftQuery(supabase, storeId);
  if (error) {
    console.error("[pos/shift] GET 失敗:", error.message);
    return NextResponse.json({ ok: false, error: "讀取班次狀態失敗，請稍後重試。" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    active: data ? mapRow(data) : null,
    serverNow: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  const declaredLen = Number(request.headers.get("content-length") ?? 0);
  if (declaredLen > 128 * 1024) {
    return NextResponse.json({ ok: false, error: "請求內容過大" }, { status: 413 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤（不是合法 JSON）" }, { status: 400 });
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return NextResponse.json({ ok: false, error: "請求格式錯誤" }, { status: 400 });
  }
  const payload = raw as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : "";
  if (action !== "open" && action !== "close" && action !== "ackOvertime") {
    return NextResponse.json({ ok: false, error: "action 必須係 open / close / ackOvertime" }, { status: 400 });
  }

  const checked = validateStoreId(typeof payload.storeId === "string" ? payload.storeId.trim() : "");
  if ("error" in checked) return checked.error;
  const { storeId } = checked;

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置（缺少 SUPABASE_SERVICE_ROLE_KEY）。" },
      { status: 503 },
    );
  }

  // ─────────────────────────────────────────────
  // open：開工
  // ─────────────────────────────────────────────
  if (action === "open") {
    // 已有 active 班次 → 以現有為準（防雙重班次 / race）。前端攞到 conflict 要 merge。
    const { data: existing, error: existingError } = await activeShiftQuery(supabase, storeId);
    if (existingError) {
      console.error("[pos/shift] open 查 active 失敗:", existingError.message);
      return NextResponse.json({ ok: false, error: "開工失敗，請稍後重試。" }, { status: 500 });
    }
    if (existing) {
      return NextResponse.json({ ok: true, conflict: true, active: mapRow(existing) });
    }

    const openedAt = isoOrNull(payload.openedAt) ?? new Date().toISOString();
    const id = `shift-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const row = {
      id,
      store_id: storeId,
      employee_account: text(payload.employeeAccount, MAX_NAME_LEN),
      employee_name: text(payload.employeeName, MAX_NAME_LEN),
      opened_at: openedAt,
      opening_note: text(payload.openingNote, MAX_TEXT_LEN),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from("pos_shifts").insert(row).select("*").maybeSingle();
    if (error) {
      // 23505 = 撞 unique（另一部機喺 check 同 insert 之間開咗工）→ 照返現有 active。
      if (error.code === "23505") {
        const { data: raced } = await activeShiftQuery(supabase, storeId);
        if (raced) return NextResponse.json({ ok: true, conflict: true, active: mapRow(raced) });
      }
      console.error("[pos/shift] open 失敗:", error.message);
      return NextResponse.json({ ok: false, error: "開工寫入失敗，請稍後重試。" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, conflict: false, active: data ? mapRow(data) : undefined });
  }

  // ─────────────────────────────────────────────
  // close：收工（active 必須存在）
  // ─────────────────────────────────────────────
  if (action === "close") {
    const closingNote = text(payload.closingNote, MAX_TEXT_LEN);
    const actualCash = moneyOrUndef(payload.actualCash);
    const cashDifference = moneyOrUndef(payload.cashDifference);
    const summary =
      typeof payload.summary === "object" && payload.summary !== null && !Array.isArray(payload.summary)
        ? (payload.summary as Record<string, unknown>)
        : undefined;

    const patch: Record<string, unknown> = {
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (closingNote !== null) patch.closing_note = closingNote;
    if (actualCash !== undefined) patch.actual_cash = actualCash;
    if (cashDifference !== undefined) patch.cash_difference = cashDifference;
    if (summary !== undefined) patch.summary = summary;

    const { data, error } = await supabase
      .from("pos_shifts")
      .update(patch)
      .eq("store_id", storeId)
      .is("closed_at", null)
      .select("*")
      .maybeSingle();

    if (error) {
      console.error("[pos/shift] close 失敗:", error.message);
      return NextResponse.json({ ok: false, error: "收工寫入失敗，請稍後重試。" }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json(
        { ok: false, code: "no_active_shift", error: "沒有進行中的班次（可能已被另一部機收工）。" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, closed: mapRow(data) });
  }

  // ─────────────────────────────────────────────
  // ackOvertime：記錄「取消逾時提醒」（連續開工 >10h）
  // ─────────────────────────────────────────────
  const ackedAt = isoOrNull(payload.ackedAt) ?? new Date().toISOString();
  const { data: acked, error: ackError } = await supabase
    .from("pos_shifts")
    .update({ overtime_acked_at: ackedAt, updated_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .is("closed_at", null)
    .select("*")
    .maybeSingle();
  if (ackError) {
    console.error("[pos/shift] ackOvertime 失敗:", ackError.message);
    return NextResponse.json({ ok: false, error: "更新提醒狀態失敗，請稍後重試。" }, { status: 500 });
  }
  if (!acked) {
    return NextResponse.json(
      { ok: false, code: "no_active_shift", error: "沒有進行中的班次。" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, active: mapRow(acked) });
}
