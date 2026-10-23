import { NextResponse } from "next/server";

import { mintSessionFromBoundDevice } from "@/lib/pos/device-session.server";
import {
  verifyBoundDevice,
  verifyBoundDeviceByDeviceId,
} from "@/lib/pos/device-binding-server";
import { issuePosDeviceToken } from "@/lib/pos/pos-device-token";
import { issueOperatorToken } from "@/lib/pos/staff-operator-token";
import { normalizeStaffNo } from "@/lib/pos/staff-core";
import { authenticatePosStaff } from "@/lib/pos/staff-server";
import { normalizeStoreAccount, resolveStoreAccount } from "@/lib/pos/store-account-server";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * `POST /api/pos/login/identity` —— 登入第 3–4 步：店員揀身份 + PIN → 完整 session。
 *
 * ## 為何要有呢條 route（docs/160 §11）
 *
 * 新流程唔再要求「店主先登入、再喺 /operator 簽到」。店員喺登入頁直接揀自己、
 * 打 PIN 就入得 —— **就算店主啱啱按咗登出**。
 *
 * ## 店員冇 Ledger 戶口，點會有 ledgerAccessToken？
 *
 * 會員／加值／報表全部要 Ledger token。呢部機如果**已由店主登入過**（自動初始化），
 * server 就存住店主 PIN 嘅密文，可以即場簽一個**全新獨立** session
 * （`mintSessionFromBoundDevice`）。未初始化 → 明確提示店主先登入一次。
 *
 * 🔴 2026-10-23 改版（docs/161）：以前存 refresh token，店主一登出就撤銷咗嗰個
 *    session ⇒ 憑證即死（實測撞到）。而家改存 PIN 密文，每次開機都係新 session。
 *
 * ## 次序（🔴 唔可以調亂）
 *
 * ① 驗裝置憑證（無憑證連 PIN 都唔會驗 ⇒ 唔可以被當成 PIN 爆破通道）
 * ② 驗店員 PIN（per-IP 限流 + per-staff 5 次鎖 15 分鐘）
 * ③ 用裝置 PIN 換一個全新 Ledger session
 * ④ 簽 sv1 操作員 token（真權限來源）＋ pv1 終端憑證（寫入用）
 *
 * 店主分支**唔經呢度**：仍然用 `/api/ledger/login`（Ledger 驗身），
 * 成功後 server 直接寫入裝置授權。
 */

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function bad(error: string, status: number, code: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, code, ...extra }, { status });
}

export async function POST(request: Request) {
  if (!rateLimit(`pos-login-identity:${clientIp(request)}`, 10, 60_000)) {
    return bad("嘗試過於頻繁，請一分鐘後再試。", 429, "rate_limited");
  }

  const body = (await request.json().catch(() => null)) as {
    account?: string;
    staffNo?: string;
    pin?: string;
    deviceId?: string;
    deviceSecret?: string;
  } | null;

  const account = normalizeStoreAccount(body?.account);
  const staffNo = normalizeStaffNo(body?.staffNo);
  const pin = String(body?.pin ?? "").replace(/\D/g, "").slice(0, 4);
  const deviceId = String(body?.deviceId ?? "").trim();
  const deviceSecret = String(body?.deviceSecret ?? "").trim();

  if (!staffNo) return bad("請選擇身份。", 400, "staff_required");
  if (!/^\d{4}$/.test(pin)) return bad("請輸入 4 位 PIN。", 400, "pin_invalid");
  if (!DEVICE_ID_PATTERN.test(deviceId) || !deviceSecret) {
    return bad("呢部機未初始化，請店主先登入一次。", 401, "device_not_ready");
  }

  // 店舖由**裝置**決定（docs/161）：已初始化嘅機唔應該再問店員 8 位店舖帳號。
  // 冇 device 憑證時才退回「帳號 → storeId」嘅舊路徑（向後兼容舊 client）。
  let storeId = "";
  let storeName = "";
  if (account) {
    const resolved = await resolveStoreAccount(account);
    if (!resolved) {
      return bad("搵唔到呢個帳號嘅店舖，請店主先登入一次。", 400, "account_unknown");
    }
    storeId = resolved.storeId;
    storeName = resolved.storeName;
  } else {
    const device = await verifyBoundDeviceByDeviceId(deviceId, deviceSecret);
    if (!device.ok) {
      return bad(
        device.error,
        device.status,
        device.tableMissing ? "table_missing" : "device_not_ready",
        { tableReady: device.tableMissing ? false : undefined },
      );
    }
    storeId = device.device.storeId;
    const resolved = await resolveStoreAccount(device.device.account);
    storeName = resolved?.storeName ?? "";
  }

  // ① 先驗裝置憑證 —— 冇憑證就唔會驗 PIN，避免呢條 route 變成爆破通道
  //    （呢度只做**便宜**嘅 secret 核對；真正換 session 留到 PIN 過咗之後）
  const gate = await verifyBoundDevice(storeId, deviceId, deviceSecret);
  if (!gate.ok) {
    return bad(gate.error, gate.status, gate.tableMissing ? "table_missing" : "device_not_ready");
  }

  // ② 驗店員 PIN（含 per-staff 鎖定）
  const auth = await authenticatePosStaff({
    storeId,
    staffNo,
    pin,
  });
  if (!auth.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: auth.error,
        code: "staff_auth_failed",
        retryAfterSec: auth.retryAfterSec,
        tableReady: auth.tableMissing ? false : undefined,
      },
      { status: auth.status },
    );
  }

  // ③ 換 Ledger session（用裝置內嘅店主 PIN 即場簽一個**全新** session）
  const minted = await mintSessionFromBoundDevice({
    storeId,
    deviceId,
    secret: deviceSecret,
  });
  if (!minted.ok) {
    return bad(minted.error, minted.status, minted.code);
  }

  // ④ 簽 sv1（真權限）＋ pv1（終端寫入）
  const operatorToken = issueOperatorToken({
    storeId,
    staffId: auth.staff.id,
    staffNo: auth.staff.staffNo,
    name: auth.staff.name,
    role: auth.staff.role,
    permissions: auth.staff.permissions,
  });
  if (!operatorToken) {
    return bad("伺服器未設定簽發憑證嘅密鑰，暫時無法登入。", 503, "secret_missing");
  }

  const posDeviceToken = issuePosDeviceToken({
    storeId,
    account: `staff:${auth.staff.staffNo}`,
    role: auth.staff.role === "manager" ? "manager" : "cashier",
  });
  if (!posDeviceToken) {
    return bad("系統未設定終端憑證密鑰，暫時無法登入。", 503, "secret_missing");
  }

  return NextResponse.json({
    ok: true,
    session: {
      account: `staff:${auth.staff.staffNo}`,
      name: minted.storeName || storeName || "店舖終端",
      // 店長 → manager、收銀 → cashier（同 Ledger 角色口徑一致）。
      // 🔴 真權限一律由 operator（sv1）決定，呢個 role 只影響頁面白名單。
      role: auth.staff.role === "manager" ? "manager" : "cashier",
      merchantId: storeId,
      storeIds: [storeId],
      permissions: {
        refundOrder: auth.staff.permissions.actions.refundOrder,
        voidItem: auth.staff.permissions.actions.voidItem,
        manageAccounts: false,
      },
      allowedModules: minted.allowedModules,
      loggedInAt: new Date().toISOString(),
      ledgerAccessToken: minted.accessToken,
      ledgerRefreshToken: minted.refreshToken,
      posDeviceToken,
    },
    token: operatorToken.token,
    expiresAt: operatorToken.expiresAt,
    operator: {
      staffId: auth.staff.id,
      staffNo: auth.staff.staffNo,
      name: auth.staff.name,
      role: auth.staff.role,
      permissions: auth.staff.permissions,
    },
  });
}
