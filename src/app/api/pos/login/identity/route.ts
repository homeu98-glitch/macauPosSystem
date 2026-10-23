import { NextResponse } from "next/server";

import { mintSessionFromBoundDevice } from "@/lib/pos/device-session.server";
import { verifyBoundDevice } from "@/lib/pos/device-binding-server";
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
 * server 就有加密保存嘅 refresh token，可以代店員換一對新 token
 * （`mintSessionFromBoundDevice`）。未初始化 → 明確提示店主先登入一次。
 *
 * ## 次序（🔴 唔可以調亂）
 *
 * ① 驗裝置憑證（無憑證連 PIN 都唔會驗 ⇒ 唔可以被當成 PIN 爆破通道）
 * ② 驗店員 PIN（per-IP 限流 + per-staff 5 次鎖 15 分鐘）
 * ③ 簽 sv1 操作員 token（真權限來源）＋ pv1 終端憑證（寫入用）
 *
 * 店主分支**唔經呢度**：仍然用 `/api/ledger/login`（Ledger 驗身），
 * 成功後由客戶端靜靜初始化呢部機。
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

  if (!account) return bad("請輸入 8 位數字帳號。", 400, "account_invalid");
  if (!staffNo) return bad("請選擇身份。", 400, "staff_required");
  if (!/^\d{4}$/.test(pin)) return bad("請輸入 4 位 PIN。", 400, "pin_invalid");
  if (!DEVICE_ID_PATTERN.test(deviceId) || !deviceSecret) {
    return bad("呢部機未初始化，請店主先登入一次。", 401, "device_not_ready");
  }

  const resolved = await resolveStoreAccount(account);
  if (!resolved) {
    return bad("搵唔到呢個帳號嘅店舖，請店主先登入一次。", 400, "account_unknown");
  }

  // ① 先驗裝置憑證 —— 冇憑證就唔會驗 PIN，避免呢條 route 變成爆破通道
  //    （呢度只做**便宜**嘅 secret 核對；真正換 token 留到 PIN 過咗之後，
  //      否則每次打錯 PIN 都會輪換一次 refresh token，白白燒 Supabase call）
  const gate = await verifyBoundDevice(resolved.storeId, deviceId, deviceSecret);
  if (!gate.ok) {
    return bad(gate.error, gate.status, gate.tableMissing ? "table_missing" : "device_not_ready");
  }

  // ② 驗店員 PIN（含 per-staff 鎖定）
  const auth = await authenticatePosStaff({
    storeId: resolved.storeId,
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

  // ③ 換 Ledger token（refresh token 會輪換 → 即刻寫返 DB）
  const minted = await mintSessionFromBoundDevice({
    storeId: resolved.storeId,
    deviceId,
    secret: deviceSecret,
  });
  if (!minted.ok) {
    return bad(minted.error, minted.status, minted.code);
  }

  // ③ 簽 sv1（真權限）＋ pv1（終端寫入）
  const operatorToken = issueOperatorToken({
    storeId: resolved.storeId,
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
    storeId: resolved.storeId,
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
      name: minted.storeName || resolved.storeName || "店舖終端",
      // 店長 → manager、收銀 → cashier（同 Ledger 角色口徑一致）。
      // 🔴 真權限一律由 operator（sv1）決定，呢個 role 只影響頁面白名單。
      role: auth.staff.role === "manager" ? "manager" : "cashier",
      merchantId: resolved.storeId,
      storeIds: [resolved.storeId],
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
