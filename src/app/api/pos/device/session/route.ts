import { NextResponse } from "next/server";

import { mintSessionFromBoundDevice } from "@/lib/pos/device-session.server";
import { updateBoundDeviceToken, verifyBoundDevice } from "@/lib/pos/device-binding-server";
import { issuePosDeviceToken } from "@/lib/pos/pos-device-token";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * `/api/pos/device/session` —— 已初始化裝置**免店主帳密**開機。
 *
 * | 方法 | 用途 | 鑑權 |
 * |---|---|---|
 * | POST | 用裝置 secret 換一個完整 POS session（含真 Ledger token） | 裝置 secret |
 * | PATCH | 客戶端輪換咗 refresh token → 同步返 server 副本 | 裝置 secret |
 *
 * ## 為何唔可以只簽 pv1
 *
 * `pv1` 只證明「呢部機屬呢間店」，但會員、加值、報表、權限控制全部要
 * `ledgerAccessToken`（見 `src/lib/ledger/*`）。換 token 嘅實作收喺
 * `device-session.server.ts`，同「登入頁揀身份」共用（避免兩份漂移）。
 *
 * ## 失敗語義
 *
 * · 表未建 / 未配置 → `tableReady:false`（200），客戶端靜靜落返登入頁
 * · secret 錯 / 已撤銷 → 401（客戶端會清走本機授權，唔會無限重試）
 * · refresh token 已死 → 401 + `code:"binding_expired"`
 */

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bad(error: string, status: number, code: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, code, ...extra }, { status });
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

  const minted = await mintSessionFromBoundDevice({ storeId, deviceId, secret });
  if (!minted.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: minted.error,
        code: minted.code,
        tableReady: minted.tableMissing ? false : undefined,
      },
      { status: minted.status },
    );
  }

  const posDeviceToken = issuePosDeviceToken({
    storeId,
    account: `device:${deviceId.slice(0, 12)}`,
    // 🔴 刻意係 cashier：呢一刻未知邊個員工。真權限由 L2 簽到（sv1）決定。
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
      name: minted.storeName,
      role: "cashier",
      merchantId: storeId,
      storeIds: [storeId],
      permissions: { refundOrder: false, voidItem: false, manageAccounts: false },
      allowedModules: minted.allowedModules,
      loggedInAt: new Date().toISOString(),
      ledgerAccessToken: minted.accessToken,
      ledgerRefreshToken: minted.refreshToken,
      posDeviceToken,
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
