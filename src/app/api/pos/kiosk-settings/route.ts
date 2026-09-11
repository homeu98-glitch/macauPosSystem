import { NextResponse } from "next/server";

import {
  KioskSettings,
  normalizeKioskPrinters,
  normalizeScanMode,
} from "@/lib/pos/kiosk-settings";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import type { DevicePrinterConfig } from "@/lib/types";

/**
 * 自助點餐設定（按店）。`pos_kiosk_settings` 表，0015 migration；
 * `scan_mode` 為 0031；`printers`（kiosk 專屬打印機）為 0032。
 *
 * 點解唔用 `pos_device_configs`：
 *   嗰張表嘅讀取係 `.order("updated_at", { ascending: false }).limit(1)` **冇 store filter**
 *   = 「全店最新一條（任何 terminal）」。用嚟存 per-store 設定一定會錯亂 ——
 *   同 `onlineOrderSettings.autoAccept` 嗰個 bug 同一個坑（見 docs/52）。
 * 所以呢條 route 嘅 GET **一定要帶 storeId filter**。
 *
 * 見 docs/87 §4.3、§6.2、docs/115（掃碼模式）、0032 migration（kiosk 打印機）。
 *
 * ## POST 係「部分更新」語意（2026-09-10）
 *
 * 舊版 POST 無腦寫死 `self_order_auto_accept`（缺欄位一律當 `true`）→ 加第二個欄位之後，
 * 「只改 scan_mode」會順手把「自動接自助單」洗返 `true`。所以改為
 * **read-then-merge**：只覆寫 payload 有帶嘅欄位，其餘沿用 DB 現值。
 *
 * ## 未跑 migration 嘅容錯（多級降級）
 *
 * `scan_mode` 係 0031、`printers` 係 0032 新加欄位。若 code 先上、migration 後跑，
 * select / upsert 會「column does not exist」（Postgres 42703）。呢種情況**逐級降級**：
 *   1. 全欄位 → 2. 冇 `printers` → 3. 連 `scan_mode` 都冇（最舊 schema）
 * 唔可以令整條 route 500 —— 否則連「自動接自助單」都改唔到。
 *
 * ⚠️ 42703 本身**唔會講係邊一個欄位**，所以唔可以「見到 42703 就假設係 printers」，
 * 一定要逐級試（下面 `selectKioskRow()` / `upsertKioskRow()`）。
 *
 * ⚠️ 讀唔到嘅欄位要 **omit**（唔好回 `[]`）：client 端用「key 唔存在」區分
 * 「server 未有呢個欄位（保留本機快取）」同「server 真係冇設定（清空快取）」。
 */

const DEFAULT_STORE_ID = "macau-store-a";

/** Postgres：undefined_column。 */
const PG_UNDEFINED_COLUMN = "42703";

interface PgError {
  code?: string;
  message?: string;
}

function isUndefinedColumn(error: PgError | null | undefined): boolean {
  return Boolean(error && error.code === PG_UNDEFINED_COLUMN);
}

interface KioskRow {
  store_id?: string;
  self_order_auto_accept?: boolean;
  scan_mode?: string;
  printers?: unknown;
  updated_at?: string | null;
}

interface SelectResult {
  data: KioskRow | null;
  error: PgError | null;
  /** 欄位唔存在（migration 未跑）→ 回值要 omit，等 client 保留本機快取。 */
  scanModeMissing: boolean;
  printersMissing: boolean;
}

type SupabaseLike = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

const COLUMNS_FULL = "store_id, self_order_auto_accept, scan_mode, printers, updated_at";
const COLUMNS_NO_PRINTERS = "store_id, self_order_auto_accept, scan_mode, updated_at";
const COLUMNS_LEGACY = "store_id, self_order_auto_accept, updated_at";

/**
 * 逐級降級讀取。42703 唔會指出邊個欄位，所以係「由最豐富嘅 select 試到最舊」。
 */
async function selectKioskRow(supabase: SupabaseLike, storeId: string): Promise<SelectResult> {
  const attempts: { columns: string; scanModeMissing: boolean; printersMissing: boolean }[] = [
    { columns: COLUMNS_FULL, scanModeMissing: false, printersMissing: false },
    { columns: COLUMNS_NO_PRINTERS, scanModeMissing: false, printersMissing: true },
    { columns: COLUMNS_LEGACY, scanModeMissing: true, printersMissing: true },
  ];

  let lastError: PgError | null = null;
  for (const attempt of attempts) {
    const res = await supabase
      .from("pos_kiosk_settings")
      .select(attempt.columns)
      .eq("store_id", storeId)
      .maybeSingle();
    if (!res.error) {
      return {
        data: res.data as KioskRow | null,
        error: null,
        scanModeMissing: attempt.scanModeMissing,
        printersMissing: attempt.printersMissing,
      };
    }
    lastError = res.error as PgError;
    // 只有「欄位唔存在」先值得再試舊 schema；其餘（權限 / 網絡 / RLS）即刻回報。
    if (!isUndefinedColumn(lastError)) break;
  }

  return { data: null, error: lastError, scanModeMissing: false, printersMissing: false };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || DEFAULT_STORE_ID;

  // GET 保持開放（kiosk / 掃碼落單時讀一次，只暴露非敏感設定），但加基本限流。
  if (!rateLimit(`pos-kiosk-settings-get:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 未配 Supabase：唔好當錯誤，返預設（免確認 + 堂食 + 冇 kiosk 打印機），
    // 等客端照樣落得到單（離線優先）。
    // ⚠️ 刻意**唔回** `printers`：client 見到 key 唔存在 → 保留本機快取。
    return NextResponse.json({
      ok: true,
      fallback: true,
      settings: { storeId, selfOrderAutoAccept: true, scanMode: "dine_in", updatedAt: null },
    });
  }

  const row = await selectKioskRow(supabase, storeId);
  if (row.error) {
    return NextResponse.json({ ok: false, error: row.error.message }, { status: 500 });
  }

  const settings: {
    storeId: string;
    selfOrderAutoAccept: boolean;
    scanMode: string;
    updatedAt: string | null;
    printers?: DevicePrinterConfig[];
  } = {
    storeId,
    // 未設定過 → 用表嘅 default（true = 免確認直接出單，規格 5）
    selfOrderAutoAccept: row.data?.self_order_auto_accept ?? true,
    // 未設定過 / 欄位未存在 → 堂食（向後兼容：現存店鋪行為不變）
    scanMode: row.scanModeMissing ? "dine_in" : normalizeScanMode(row.data?.scan_mode),
    updatedAt: row.data?.updated_at ?? null,
  };
  // 欄位唔存在 → **omit**（唔好回 []），client 靠「key 唔存在」保留本機快取。
  if (!row.printersMissing) {
    settings.printers = normalizeKioskPrinters(row.data?.printers);
  }

  return NextResponse.json({ ok: true, settings });
}

/** upsert 用嘅 payload（同 select 一樣要逐級降級）。 */
interface UpsertFields {
  selfOrderAutoAccept: boolean;
  scanMode: string;
  printers: DevicePrinterConfig[];
}

async function upsertKioskRow(
  supabase: SupabaseLike,
  storeId: string,
  fields: UpsertFields,
  nowIso: string,
): Promise<PgError | null> {
  // 逐級降級：全欄位 → 冇 printers → 連 scan_mode 都冇。
  const attempts: { includePrinters: boolean; includeScanMode: boolean }[] = [
    { includePrinters: true, includeScanMode: true },
    { includePrinters: false, includeScanMode: true },
    { includePrinters: false, includeScanMode: false },
  ];

  let lastError: PgError | null = null;
  for (const attempt of attempts) {
    const row: Record<string, unknown> = {
      store_id: storeId,
      self_order_auto_accept: fields.selfOrderAutoAccept,
      updated_at: nowIso,
    };
    if (attempt.includeScanMode) row.scan_mode = fields.scanMode;
    if (attempt.includePrinters) row.printers = fields.printers;

    const { error } = await supabase.from("pos_kiosk_settings").upsert(row, { onConflict: "store_id" });
    if (!error) return null;
    lastError = error as PgError;
    if (!isUndefinedColumn(lastError)) break;
  }

  return lastError;
}

export async function POST(request: Request) {
  // 2026-09-10 審查 P3-5：舊版 POST **完全無鑑權** —— 任何人都可以改全店接單行為
  // （例如偷偷關掉「自動接自助單」，令客人落單全部變待確認）。家陣要求 POS 終端憑證。
  const ip = clientIp(request);
  if (!rateLimit(`pos-kiosk-settings-post:${ip}`, 30, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const payload = (await request.json().catch(() => null)) as
    | (Partial<KioskSettings> & { printers?: unknown })
    | null;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }
  const storeId = String(payload?.storeId ?? "").trim() || DEFAULT_STORE_ID;

  // 部分更新：只認 payload **有帶** 嘅欄位（`undefined` = 唔改）。
  const hasAutoAccept = typeof payload.selfOrderAutoAccept === "boolean";
  const hasScanMode = payload.scanMode !== undefined;
  const hasPrinters = payload.printers !== undefined;
  if (!hasAutoAccept && !hasScanMode && !hasPrinters) {
    return NextResponse.json({ ok: false, error: "冇任何可更新欄位。" }, { status: 400 });
  }
  if (hasScanMode && payload.scanMode !== "dine_in" && payload.scanMode !== "quick") {
    return NextResponse.json(
      { ok: false, error: "scanMode 只可以係 dine_in 或 quick。" },
      { status: 400 },
    );
  }
  // 打印機清單一定要係 array；元素由 normalizeKioskPrinters() 逐個白名單過濾。
  if (hasPrinters && !Array.isArray(payload.printers)) {
    return NextResponse.json({ ok: false, error: "printers 只可以係陣列。" }, { status: 400 });
  }

  const authEnforced = isPosDeviceAuthRequired();
  const deviceClaims = readPosDeviceTokenFromRequest(request);
  const adminClaims = readAdminSessionFromRequest(request);
  const authorized = !authEnforced || Boolean(adminClaims) || Boolean(deviceClaims && deviceClaims.storeId === storeId);
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "未經授權：需要 POS 終端憑證。" }, { status: 401 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置，自助點餐設定無法保存到後台。" },
      { status: 503 },
    );
  }

  // read-then-merge：攞現值做底，再覆寫 payload 有帶嘅欄位。
  const current = await selectKioskRow(supabase, storeId);
  if (current.error) {
    return NextResponse.json({ ok: false, error: current.error.message }, { status: 500 });
  }

  const selfOrderAutoAccept = hasAutoAccept
    ? Boolean(payload.selfOrderAutoAccept)
    : current.data?.self_order_auto_accept ?? true;
  const scanMode = hasScanMode
    ? normalizeScanMode(payload.scanMode)
    : normalizeScanMode(current.data?.scan_mode);
  // 只改一個欄位唔可以洗走另一個：printers 亦要 read-then-merge。
  // ⚠️ 若 `printers` 欄位未存在（migration 未跑），`current.data?.printers` 係 undefined
  // → 當空陣列；upsert 嘅降級邏輯亦會自動剝走呢個欄位。
  const printers = hasPrinters
    ? normalizeKioskPrinters(payload.printers)
    : normalizeKioskPrinters(current.data?.printers);

  const nowIso = new Date().toISOString();
  const writeError = await upsertKioskRow(supabase, storeId, { selfOrderAutoAccept, scanMode, printers }, nowIso);
  if (writeError) {
    return NextResponse.json({ ok: false, error: writeError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    settings: { storeId, selfOrderAutoAccept, scanMode, printers, updatedAt: nowIso },
  });
}
