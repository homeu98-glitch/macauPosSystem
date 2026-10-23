import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { resolvePosTokenSecret } from "@/lib/pos/pos-device-token";
import {
  normalizePosStaffPermissions,
  type PosStaffPermissions,
  type PosStaffRole,
} from "@/lib/pos/staff-core";

/**
 * 操作員憑證（`sv1`）—— 店員簽到後由伺服器簽發。
 *
 * ## 為何要一張簽名 token，而唔係「前端存個 role 就算」
 *
 * 權限如果只係 localStorage 一個 boolean，任何人改 devtools 就穿。
 * 真正邊界一定喺伺服器；但「每個請求都查 DB」會令每次落單多一次 read
 * （本專案對 egress 極敏感）。折衷：
 *
 *   · 簽到時**一次** DB 查詢 → 簽一張 12 小時 HMAC token（payload 已含權限）；
 *   · UI 用 token 內嘅權限畫掣（唔使再查）；
 *   · 高風險操作（Phase 2）可以驗同一張 token，零額外 DB 成本。
 *
 * ## 與 `pv1`（posDeviceToken）嘅關係
 *
 * - `pv1` 證明「呢部機屬於邊間店」；`sv1` 證明「而家係邊個店員、可做咩」。
 * - 兩者**獨立 kind**，互不通用（`verifyOperatorToken()` 只認 `sv1`）。
 * - secret 共用同一條解析次序（`resolvePosTokenSecret()`）——
 *   唔可以各自用唔同 secret，否則會出現「一邊簽到、另一邊驗唔到」。
 */

const TOKEN_VERSION = "sv1";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export type PosOperatorClaims = {
  /** 店（merchants.id）。所有權限只對呢間店有效。 */
  storeId: string;
  staffId: string;
  staffNo: string;
  name: string;
  role: PosStaffRole;
  permissions: PosStaffPermissions;
  /** 到期時間 epoch ms */
  exp: number;
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 簽發操作員 token。`null` = server 冇 secret / 參數不合法（fail closed）。 */
export function issueOperatorToken(
  claims: Omit<PosOperatorClaims, "exp">,
): { token: string; expiresAt: string } | null {
  const secret = resolvePosTokenSecret();
  if (!secret) return null;
  if (!claims?.storeId || !claims?.staffId || !claims?.staffNo) return null;

  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = base64url(
    JSON.stringify({
      v: TOKEN_VERSION,
      storeId: claims.storeId,
      staffId: claims.staffId,
      staffNo: claims.staffNo,
      name: claims.name,
      role: claims.role,
      permissions: claims.permissions,
      exp,
    }),
  );
  return { token: `${payload}.${sign(payload, secret)}`, expiresAt: new Date(exp).toISOString() };
}

/** 驗證操作員 token。失敗一律 `null`（原因唔對外洩漏）。 */
export function verifyOperatorToken(token: string | null | undefined): PosOperatorClaims | null {
  if (!token) return null;
  const secret = resolvePosTokenSecret();
  if (!secret) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(payload, secret))) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: string;
      storeId?: unknown;
      staffId?: unknown;
      staffNo?: unknown;
      name?: unknown;
      role?: unknown;
      permissions?: unknown;
      exp?: unknown;
    };
    if (decoded?.v !== TOKEN_VERSION) return null;
    if (typeof decoded.storeId !== "string" || !decoded.storeId) return null;
    if (typeof decoded.staffId !== "string" || !decoded.staffId) return null;
    if (typeof decoded.staffNo !== "string" || !decoded.staffNo) return null;
    if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return null;
    if (Date.now() > decoded.exp) return null;
    const role = decoded.role === "manager" ? "manager" : "cashier";
    return {
      storeId: decoded.storeId,
      staffId: decoded.staffId,
      staffNo: decoded.staffNo,
      name: typeof decoded.name === "string" ? decoded.name : "",
      role,
      // 簽名已保證未被篡改；呢度再正規化一次，防止舊版 token 缺欄
      permissions: normalizePosStaffPermissions(decoded.permissions, role),
      exp: decoded.exp,
    };
  } catch {
    return null;
  }
}

/** 由 Request 抽出 `x-pos-staff-token` 並驗證。 */
export function readOperatorTokenFromRequest(request: Request): PosOperatorClaims | null {
  return verifyOperatorToken(request.headers.get("x-pos-staff-token"));
}
