import { NextResponse } from "next/server";

import { KioskSettings, normalizeScanMode } from "@/lib/pos/kiosk-settings";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * 自助點餐設定（按店）。`pos_kiosk_settings` 表，0015 migration；`scan_mode` 為 0031。
 *
 * 點解唔用 `pos_device_configs`：
 *   嗰張表嘅讀取係 `.order("updated_at", { ascending: false }).limit(1)` **冇 store filter**
 *   = 「全店最新一條（任何 terminal）」。用嚟存 per-store 設定一定會錯亂 ——
 *   同 `onlineOrderSettings.autoAccept` 嗰個 bug 同一個坑（見 docs/52）。
 * 所以呢條 route 嘅 GET **一定要帶 storeId filter**。
 *
 * 見 docs/87 §4.3、docs/115（掃碼模式）。
 *
 * ## POST 係「部分更新」語意（2026-09-10）
 *
 * 舊版 POST 無腦寫死 `self_order_auto_accept`（缺欄位一律當 `true`）→ 加第二個欄位之後，
 * 「只改 scan_mode」會順手把「自動接自助單」洗返 `true`。所以改為
 * **read-then-merge**：只覆寫 payload 有帶嘅欄位，其餘沿用 DB 現值。
 *
 * ## 未跑 migration 嘅容錯
 *
 * `scan_mode` 係 0031 新加欄位。若 code 先上、migration 後跑，select / upsert 會
 * 「column does not exist」（Postgres 42703）。呢種情況**降級**為只讀寫舊欄位
 * （`scanMode` 回 `dine_in`），唔可以令整條 route 500 —— 否則連「自動接自助單」都改唔到。
 */

const DEFAULT_STORE_ID = "macau-store-a";

/** Postgres：undefined_column。 */
const PG_UNDEFINED_COLUMN = "42703";

function isMissingScanModeColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === PG_UNDEFINED_COLUMN) return true;
  return typeof error.message === "string" && error.message.includes("scan_mode");
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || DEFAULT_STORE_ID;

  // GET 保持開放（kiosk / 掃碼落單時讀一次，只暴露兩個非敏感設定），但加基本限流。
  if (!rateLimit(`pos-kiosk-settings-get:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 未配 Supabase：唔好當錯誤，返預設（免確認 + 堂食），等客端照樣落得到單（離線優先）
    return NextResponse.json({
      ok: true,
      fallback: true,
      settings: { storeId, selfOrderAutoAccept: true, scanMode: "dine_in", updatedAt: null },
    });
  }

  const withScanMode = await supabase
    .from("pos_kiosk_settings")
    .select("store_id, self_order_auto_accept, scan_mode, updated_at")
    .eq("store_id", storeId)
    .maybeSingle();

  let data: { store_id?: string; self_order_auto_accept?: boolean; updated_at?: string | null } | null =
    withScanMode.data as typeof data;
  let error = withScanMode.error;
  let scanModeColumnMissing = false;

  // 降級：0031 migration 未跑 → 唔揀 scan_mode，回預設堂食模式。
  if (isMissingScanModeColumn(error)) {
    scanModeColumnMissing = true;
    const legacy = await supabase
      .from("pos_kiosk_settings")
      .select("store_id, self_order_auto_accept, updated_at")
      .eq("store_id", storeId)
      .maybeSingle();
    data = legacy.data as typeof data;
    error = legacy.error;
  }

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rawScanMode = scanModeColumnMissing
    ? undefined
    : (withScanMode.data as { scan_mode?: string } | null)?.scan_mode;

  return NextResponse.json({
    ok: true,
    settings: {
      storeId,
      // 未設定過 → 用表嘅 default（true = 免確認直接出單，規格 5）
      selfOrderAutoAccept: data?.self_order_auto_accept ?? true,
      // 未設定過 / 欄位未存在 → 堂食（向後兼容：現存店鋪行為不變）
      scanMode: normalizeScanMode(rawScanMode),
      updatedAt: data?.updated_at ?? null,
    },
  });
}

export async function POST(request: Request) {
  // 2026-09-10 審查 P3-5：舊版 POST **完全無鑑權** —— 任何人都可以改全店接單行為
  // （例如偷偷關掉「自動接自助單」，令客人落單全部變待確認）。家陣要求 POS 終端憑證。
  const ip = clientIp(request);
  if (!rateLimit(`pos-kiosk-settings-post:${ip}`, 30, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const payload = (await request.json().catch(() => null)) as Partial<KioskSettings> | null;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }
  const storeId = String(payload?.storeId ?? "").trim() || DEFAULT_STORE_ID;

  // 部分更新：只認 payload **有帶** 嘅欄位（`undefined` = 唔改）。
  const hasAutoAccept = typeof payload.selfOrderAutoAccept === "boolean";
  const hasScanMode = payload.scanMode !== undefined;
  if (!hasAutoAccept && !hasScanMode) {
    return NextResponse.json({ ok: false, error: "冇任何可更新欄位。" }, { status: 400 });
  }
  if (hasScanMode && payload.scanMode !== "dine_in" && payload.scanMode !== "quick") {
    return NextResponse.json(
      { ok: false, error: "scanMode 只可以係 dine_in 或 quick。" },
      { status: 400 },
    );
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
  const read = await supabase
    .from("pos_kiosk_settings")
    .select("self_order_auto_accept, scan_mode")
    .eq("store_id", storeId)
    .maybeSingle();

  // 降級：0031 未跑 → 只讀寫舊欄位。
  const scanModeColumnMissing = isMissingScanModeColumn(read.error);
  if (read.error && !scanModeColumnMissing) {
    return NextResponse.json({ ok: false, error: read.error.message }, { status: 500 });
  }

  const existing = (scanModeColumnMissing ? null : read.data) as
    | { self_order_auto_accept?: boolean; scan_mode?: string }
    | null;

  const selfOrderAutoAccept = hasAutoAccept
    ? Boolean(payload.selfOrderAutoAccept)
    : existing?.self_order_auto_accept ?? true;
  const scanMode = hasScanMode
    ? normalizeScanMode(payload.scanMode)
    : normalizeScanMode(existing?.scan_mode);

  const nowIso = new Date().toISOString();
  const row: Record<string, unknown> = {
    store_id: storeId,
    self_order_auto_accept: selfOrderAutoAccept,
    updated_at: nowIso,
  };
  // 0031 未跑就唔寫 scan_mode（寫咗會 42703 令整條失敗）。
  if (!scanModeColumnMissing) row.scan_mode = scanMode;

  const { error } = await supabase.from("pos_kiosk_settings").upsert(row, { onConflict: "store_id" });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    settings: { storeId, selfOrderAutoAccept, scanMode, updatedAt: nowIso },
  });
}
