import { NextResponse } from "next/server";

import { readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { normalizeStaffNo } from "@/lib/pos/staff-core";
import { issueOperatorToken } from "@/lib/pos/staff-operator-token";
import { authenticatePosStaff } from "@/lib/pos/staff-server";

/**
 * `POST /api/pos/staff/login` —— 店員簽到（工號 + PIN）。
 *
 * ## 為何要有呢條 route（2026-10-23）
 *
 * 商家實況：**員工唔一定個個有 Ledger 戶口**（兼職／臨時工）。
 * 所以店員唔可以只靠 `/api/ledger/login`（8 位電話 + PIN）。
 * 呢度係 POS 本地簽到：工號 + PIN，成功後簽一張 `sv1` 操作員 token。
 *
 * ## 分層（唔可以搞亂）
 *
 * ```
 * L1 裝置登入（Ledger，8位電話+PIN）→ 證明「呢部機屬於邊間店」＋拎 ledger token
 * L2 店員簽到（本 route）            → 證明「而家係邊個店員、可做咩」
 * ```
 *
 * ⚠️ 客人掃碼／未登入嘅裝置**唔應該**打呢條 route：店員簽到係店內操作。
 *    若請求帶咗 `pv1`（POS 終端憑證），會額外核對 storeId 一致。
 *
 * ## 防爆破（4 位 PIN 只有 10⁴ 組合）
 *
 * - route 層：per-IP 10 次／分鐘（同 `/api/ledger/login` 同一手法）；
 * - 帳號層：per-staff 連續 5 次錯 → 鎖 15 分鐘（`authenticatePosStaff()`）。
 *   單靠 IP 限流唔夠 —— 換 IP 即繞過。
 */

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;

type Bucket = { count: number; resetAt: number };
const attempts = new Map<string, Bucket>();

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

function allow(ip: string): boolean {
  const now = Date.now();
  const bucket = attempts.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  if (bucket.count >= LOGIN_MAX_ATTEMPTS) return false;
  bucket.count += 1;
  return true;
}

export async function POST(request: Request) {
  if (!allow(clientIp(request))) {
    return NextResponse.json(
      { ok: false, error: "嘗試過於頻繁，請一分鐘後再試。" },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const payload = (body ?? {}) as { storeId?: unknown; staffNo?: unknown; pin?: unknown };
  const storeId = String(payload.storeId ?? "").trim();
  const staffNo = normalizeStaffNo(payload.staffNo);
  const pin = String(payload.pin ?? "").trim();

  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少店舖資料，請重新登入 POS。" }, { status: 400 });
  }
  if (!staffNo) {
    return NextResponse.json({ ok: false, error: "請輸入工號。" }, { status: 400 });
  }
  if (!/^\d{4}$/.test(pin)) {
    return NextResponse.json({ ok: false, error: "請輸入 4 位 PIN。" }, { status: 400 });
  }

  // 若請求帶 POS 終端憑證，一定要係同一間店（防跨店簽到）
  const device = readPosDeviceTokenFromRequest(request);
  if (device && device.storeId !== storeId) {
    return NextResponse.json(
      { ok: false, error: "此終端唔屬於呢間店，無法簽到。" },
      { status: 403 },
    );
  }

  const result = await authenticatePosStaff({ storeId, staffNo, pin });
  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        retryAfterSec: result.retryAfterSec,
        tableReady: result.tableMissing ? false : undefined,
      },
      { status: result.status },
    );
  }

  const issued = issueOperatorToken({
    storeId,
    staffId: result.staff.id,
    staffNo: result.staff.staffNo,
    name: result.staff.name,
    role: result.staff.role,
    permissions: result.staff.permissions,
  });

  if (!issued) {
    // 冇 secret = 簽唔到票 ⇒ fail closed（唔可以回「成功但冇 token」）
    return NextResponse.json(
      { ok: false, error: "伺服器未設定簽發憑證嘅密鑰，暫時無法簽到。" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    token: issued.token,
    expiresAt: issued.expiresAt,
    operator: {
      staffId: result.staff.id,
      staffNo: result.staff.staffNo,
      name: result.staff.name,
      role: result.staff.role,
      permissions: result.staff.permissions,
    },
  });
}
