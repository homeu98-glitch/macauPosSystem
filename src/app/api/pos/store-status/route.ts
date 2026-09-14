import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { DEFAULT_STORE_OPEN, normalizeStoreOpen } from "@/lib/pos/store-status";
import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * 店內營業開關（線下） per-store —— `pos_store_status` 表，migration 0039。
 *
 * ── 三類讀者 ────────────────────────────────────────────────────────────
 * | 讀者 | 方法 | 憑證 |
 * |---|---|---|
 * | 收銀機 pill（`useStoreStatus`） | GET + POST | POST 要 POS 終端憑證 |
 * | 客人端（掃碼 / kiosk，匿名） | GET | **唔使**憑證（只暴露一個 boolean，冇 PII） |
 * | server 硬閘（`/api/pos/sync`） | 直接讀 DB | 唔經本 route |
 *
 * ── 點解 GET 可以開放 ───────────────────────────────────────────────────
 * 客人掃碼時手上冇 POS 憑證，但落單前要知道「鋪頭開咗門未」。呢張表得
 * `store_id + is_open + 審計欄`，冇任何 PII（同 `pos_kiosk_settings` GET 同一判斷）。
 * 開放嘅同時加基本限流，防止被當成掃店工具。
 *
 * ── 失敗一律 fail-open（🔴 唔可以當「已暫停」）───────────────────────────
 * 未配 Supabase / migration 0039 未跑（Postgres 42P01 undefined_table）/
 * 查詢失敗 → **回 `isOpen: true`** + `fallback: true`。
 * 反過來（當已暫停）就會一斷網全店掃碼 + kiosk 停業；而真正嘅硬閘喺
 * `/api/pos/sync`，客人端讀唔到唔等於落得到單 —— 兩個方向都安全。
 *
 * 見 docs/131（開關口徑）、0039 migration（表 / RLS / Realtime）。
 */

const DEFAULT_STORE_ID = "macau-store-a";

/** Postgres：undefined_table（migration 0039 未跑）。 */
const PG_UNDEFINED_TABLE = "42P01";

interface PgError {
  code?: string;
  message?: string;
}

function isUndefinedTable(error: PgError | null | undefined): boolean {
  if (!error) return false;
  if (error.code === PG_UNDEFINED_TABLE) return true;
  // 兜底：少數 Supabase 版本唔回 code，只回訊息
  const lower = (error.message ?? "").toLowerCase();
  return lower.includes("pos_store_status") && lower.includes("does not exist");
}

function readStoreIdFromSearch(request: Request): string {
  const { searchParams } = new URL(request.url);
  return searchParams.get("storeId")?.trim() || DEFAULT_STORE_ID;
}

export async function GET(request: Request) {
  const storeId = readStoreIdFromSearch(request);

  if (!rateLimit(`pos-store-status-get:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 未配 Supabase：唔好當錯誤，返「營業中」令客端照樣落得到單（離線優先）
    return NextResponse.json({
      ok: true,
      fallback: true,
      storeId,
      isOpen: DEFAULT_STORE_OPEN,
      updatedAt: null,
    });
  }

  const { data, error } = await supabase
    .from("pos_store_status")
    .select("store_id, is_open, updated_at")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) {
    if (isUndefinedTable(error as PgError)) {
      // 0039 未跑：唔可以 500（否則客人端永遠讀唔到），亦唔可以當「已暫停」
      return NextResponse.json({
        ok: true,
        fallback: true,
        storeId,
        isOpen: DEFAULT_STORE_OPEN,
        updatedAt: null,
        warning: "pos_store_status 表未建立（需要跑 migration 0039），暫時當營業中。",
      });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    storeId,
    // 未設定過 row → null → 營業中（default true，見 0039 檔頭）
    isOpen: normalizeStoreOpen(data?.is_open, DEFAULT_STORE_OPEN),
    updatedAt: typeof data?.updated_at === "string" ? data.updated_at : null,
  });
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`pos-store-status-post:${ip}`, 30, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const payload = (await request.json().catch(() => null)) as
    | { storeId?: unknown; isOpen?: unknown }
    | null;
  if (!payload || typeof payload !== "object" || typeof payload.isOpen !== "boolean") {
    return NextResponse.json({ ok: false, error: "isOpen 必須係 boolean。" }, { status: 400 });
  }
  const storeId = typeof payload.storeId === "string" && payload.storeId.trim()
    ? payload.storeId.trim()
    : DEFAULT_STORE_ID;

  // 🔴 呢粒掣可以停全店自助落單 → 一定要 POS 終端憑證（同 kiosk-settings POST 一致）
  const authEnforced = isPosDeviceAuthRequired();
  const deviceClaims = readPosDeviceTokenFromRequest(request);
  const adminClaims = readAdminSessionFromRequest(request);
  const authorized =
    !authEnforced || Boolean(adminClaims) || Boolean(deviceClaims && deviceClaims.storeId === storeId);
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "未經授權：需要 POS 終端憑證。" }, { status: 401 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置，營業狀態無法保存。" },
      { status: 503 },
    );
  }

  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("pos_store_status").upsert(
    {
      store_id: storeId,
      is_open: payload.isOpen,
      updated_at: updatedAt,
      updated_source: "pos",
    },
    { onConflict: "store_id" },
  );

  if (error) {
    if (isUndefinedTable(error as PgError)) {
      // 明確講「寫唔到」，唔好靜靜當成功（否則收銀以為停咗業、實際照收單）
      return NextResponse.json(
        {
          ok: false,
          error: "pos_store_status 表未建立（需要跑 migration 0039），營業狀態未能保存。",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, storeId, isOpen: payload.isOpen, updatedAt });
}
