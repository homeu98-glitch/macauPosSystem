import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { resolveLedgerPublicConfig } from "@/lib/ledger/supabase-server-auth";
import { loadMerchantGrants } from "@/lib/pos/merchant-modules-server";
import { issuePosDeviceToken } from "@/lib/pos/pos-device-token";
import {
  updateBoundDeviceToken,
  verifyBoundDevice,
} from "@/lib/pos/device-binding-server";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * `/api/pos/device/session` —— 已授權裝置**免店主帳密**開機。
 *
 * | 方法 | 用途 | 鑑權 |
 * |---|---|---|
 * | POST | 用裝置 secret 換一個完整 POS session（含真 Ledger token） | 裝置 secret |
 * | PATCH | 客戶端輪換咗 refresh token → 同步返 server 副本 | 裝置 secret |
 *
 * ## 為何唔可以只簽 pv1
 *
 * `pv1` 只證明「呢部機屬呢間店」，但會員、加值、報表、權限控制全部要
 * `ledgerAccessToken`（見 `src/lib/ledger/*`）。所以呢條 route 一定要用
 * `pos_bound_devices.refresh_token_enc` 去 Supabase 換一對**新** token 返嚟。
 *
 * ## Refresh token 輪換（🔴 極重要）
 *
 * Supabase 每次 refresh 都會**輪換** refresh token（舊票即刻失效）。所以：
 *   ① 呢度 refresh 完會**即刻**寫返新票落 DB；
 *   ② 客戶端之後自己再 refresh 時，會經 PATCH 把新票同步返嚟
 *      （`syncDeviceBindingRefreshToken()`，見 `src/lib/ledger/session.ts`）。
 * 冇 ② 嘅話，DB 嗰張票會喺第一次客戶端 refresh 之後變成廢票 ⇒
 * 第二日開機失敗（「授權已失效」），而且查極都查唔到原因。
 *
 * ## 失敗語義
 *
 * · 表未建 / 未配置 → `tableReady:false`（200），客戶端靜靜落返登入頁
 * · secret 錯 / 已撤銷 → 401（客戶端會清走本機授權，唔會無限重試）
 * · refresh token 已死（例如 Ledger 改密碼／session 被撤）→ 401 + `code:"binding_expired"`
 */

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bad(error: string, status: number, code: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, code, ...extra }, { status });
}

/** 一個乾淨嘅 Ledger client（唔帶舊 access token）—— 只用 refresh token 換新 session。 */
function createRefreshClient() {
  const { url, anonKey } = resolveLedgerPublicConfig();
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function POST(request: Request) {
  if (!rateLimit(`pos-device-session:${clientIp(request)}`, 30, 60_000)) {
    return bad("請求過於頻繁，請稍後再試。", 429, "rate_limited");
  }

  const body = (await request.json().catch(() => null)) as {
    storeId?: string;
    deviceId?: string;
    secret?: string;
  } | null;

  const storeId = readText(body?.storeId);
  const deviceId = readText(body?.deviceId);
  const secret = readText(body?.secret);
  if (!storeId) return bad("缺少 storeId。", 400, "store_required");
  if (!DEVICE_ID_PATTERN.test(deviceId)) return bad("裝置識別碼無效。", 400, "device_invalid");
  if (!secret) return bad("缺少裝置憑證。", 400, "secret_required");

  const verified = await verifyBoundDevice(storeId, deviceId, secret);
  if (!verified.ok) {
    return NextResponse.json(
      { ok: false, error: verified.error, tableReady: verified.tableMissing ? false : undefined },
      { status: verified.status },
    );
  }

  const client = createRefreshClient();
  if (!client) {
    return bad("Ledger 環境變數未設定，暫時無法自動開機。", 503, "ledger_not_configured");
  }

  const { data: refreshed, error: refreshError } = await client.auth.refreshSession({
    refresh_token: verified.device.refreshToken,
  });

  if (refreshError || !refreshed.session) {
    console.warn(
      "[pos/device/session] refresh token 已失效:",
      deviceId,
      refreshError?.message ?? "no session",
    );
    return bad(
      "呢部機嘅登入憑證已過期，請店主重新授權（或重新登入一次）。",
      401,
      "binding_expired",
    );
  }

  const accessToken = refreshed.session.access_token;
  const refreshToken = refreshed.session.refresh_token;

  // 即刻寫返新票：refresh token 已輪換，舊票已死。
  const saved = await updateBoundDeviceToken({ storeId, deviceId, refreshToken });
  if (!saved.ok) {
    // 寫唔返 = 下次開機一定失敗。要嘈（但唔可以令今次開機失敗）。
    console.error("[pos/device/session] 未能保存輪換後嘅 refresh token:", saved.error);
  }

  // 店名／商戶狀態（同 /api/ledger/login 同一口徑）
  const { data: merchantRows } = await client
    .from("merchants")
    .select("status, name")
    .eq("id", storeId)
    .limit(1);
  const merchant = merchantRows?.[0] as { status?: string; name?: string } | undefined;
  const merchantStatus = String(merchant?.status ?? "").toLowerCase();
  if (merchantStatus && merchantStatus !== "active" && merchantStatus !== "pending") {
    return bad("商戶狀態異常，暫時無法開機。", 403, "merchant_inactive");
  }

  const allowedModules = await loadMerchantGrants(storeId);
  const posDeviceToken = issuePosDeviceToken({
    storeId,
    account: `device:${deviceId.slice(0, 12)}`,
    // 🔴 刻意係 cashier：呢一刻未知邊個員工。真權限由 L2 簽到（sv1）決定；
    //    店主如果要用自己權限，正常登入一次即可。
    role: "cashier",
  });

  // 簽唔到 pv1 ⇒ 開機之後 `/api/pos/sync` 會 401（靜默收唔到單）。
  // 寧願而家明明白白失敗，好過「開到機但落唔到單」。
  if (!posDeviceToken) {
    console.error("[pos/device/session] 未能簽發 pv1（未設定任何 server secret）");
    return bad("系統未設定終端憑證密鑰，暫時無法自動開機。", 503, "secret_missing");
  }

  return NextResponse.json({
    ok: true,
    session: {
      account: `device:${deviceId.slice(0, 12)}`,
      name: merchant?.name ?? "店員終端",
      role: "cashier",
      merchantId: storeId,
      storeIds: [storeId],
      permissions: { refundOrder: false, voidItem: false, manageAccounts: false },
      allowedModules,
      loggedInAt: new Date().toISOString(),
      ledgerAccessToken: accessToken,
      ledgerRefreshToken: refreshToken,
      posDeviceToken: posDeviceToken ?? undefined,
    },
  });
}

export async function PATCH(request: Request) {
  if (!rateLimit(`pos-device-token-sync:${clientIp(request)}`, 120, 60_000)) {
    return bad("請求過於頻繁，請稍後再試。", 429, "rate_limited");
  }

  const body = (await request.json().catch(() => null)) as {
    storeId?: string;
    deviceId?: string;
    secret?: string;
    refreshToken?: string;
  } | null;

  const storeId = readText(body?.storeId);
  const deviceId = readText(body?.deviceId);
  const secret = readText(body?.secret);
  const refreshToken = readText(body?.refreshToken);
  if (!storeId || !DEVICE_ID_PATTERN.test(deviceId) || !secret || !refreshToken) {
    return bad("參數不完整。", 400, "invalid_params");
  }

  const verified = await verifyBoundDevice(storeId, deviceId, secret);
  if (!verified.ok) {
    return NextResponse.json(
      { ok: false, error: verified.error, tableReady: verified.tableMissing ? false : undefined },
      { status: verified.status },
    );
  }

  const saved = await updateBoundDeviceToken({ storeId, deviceId, refreshToken });
  if (!saved.ok) {
    return NextResponse.json(
      { ok: false, error: saved.error, tableReady: saved.tableMissing ? false : undefined },
      { status: saved.status },
    );
  }
  return NextResponse.json({ ok: true });
}
