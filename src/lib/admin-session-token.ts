import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { UserRole } from "@/lib/types";

/**
 * 管理員操作用嘅短效憑證（HMAC-signed token）。
 *
 * 【背景 · 2026-08-31 資安修復，見 docs/89 §2】
 * 之前 `/api/admin/accounts` 四個 method（GET/POST/PUT/DELETE）全部**零授權**：
 * 任何人打過去就可以拎晒所有員工帳號（**連 4 位 PIN 明文一齊出**），
 * 亦可以任意新增 / 改權限 / 停用 / 刪除管理員帳號。
 * 前端嘅 role 判斷只係 localStorage 入面嘅一個值，server 完全唔認。
 *
 * 【點解唔直接喺每個 request 傳 PIN】
 *   PIN 係長期憑證，每次 request 都喺網絡上傳一次會大幅增加曝光面，
 *   而且會落喺 proxy / access log。所以用 PIN **換一張 12 小時嘅短效 token**，
 *   之後淨係傳 token，token 唔可以反推出 PIN，到期自動失效。
 *
 * 【點解唔使新增 DB table】
 *   token 係 stateless：payload（account / role / exp）+ HMAC-SHA256 簽名。
 *   簽名 key 用 server-only 嘅 secret，冇 key 就偽造唔到。
 *   代價係冇得中途「登出作廢」單一 token（要作廢就 rotate secret），
 *   對一個內部後台嚟講係合理取捨。
 */

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 小時
const TOKEN_VERSION = "v1";

export type AdminSessionClaims = {
  /** 8 位員工帳號 */
  account: string;
  /** 簽發當刻嘅角色（只作記錄／顯示用，權限以 `permissions` 為準） */
  role: UserRole;
  /** 到期時間 epoch ms */
  exp: number;
};

/** 簽名密鑰：優先用專屬 secret，冇就借用 service role key（一樣係 server-only）。 */
function resolveSecret(): string | null {
  const dedicated = process.env.ADMIN_SESSION_SECRET?.trim();
  if (dedicated) return dedicated;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  return serviceKey?.trim() || null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** 常數時間比對，防 timing attack。 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 簽發一張 admin token。
 * @returns `null` 代表 server 冇設定任何 secret → **fail closed**（唔簽、唔放行）。
 */
export function issueAdminSessionToken(claims: Omit<AdminSessionClaims, "exp">): string | null {
  const secret = resolveSecret();
  if (!secret) return null;

  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = base64url(JSON.stringify({ v: TOKEN_VERSION, account: claims.account, role: claims.role, exp }));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * 驗證 token。通過就返 claims，否則返 null（原因只落 log，唔對外講）。
 */
export function verifyAdminSessionToken(token: string | null | undefined): AdminSessionClaims | null {
  if (!token) return null;
  const secret = resolveSecret();
  if (!secret) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(payload, secret))) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AdminSessionClaims & {
      v?: string;
    };
    if (decoded?.v !== TOKEN_VERSION) return null;
    if (typeof decoded.account !== "string" || !decoded.account) return null;
    if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return null;
    if (Date.now() > decoded.exp) return null;
    return { account: decoded.account, role: decoded.role, exp: decoded.exp };
  } catch {
    return null;
  }
}

/**
 * 由 Request 抽出 `Authorization: Bearer <token>` 並驗證。
 */
export function readAdminSessionFromRequest(request: Request): AdminSessionClaims | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return verifyAdminSessionToken(header.slice(7).trim());
}
