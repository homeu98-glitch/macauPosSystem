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

/**
 * 簽名密鑰：**只准**用專屬 `ADMIN_SESSION_SECRET`。
 *
 * 🔴 2026-10-21（多店控制台 P0-1）：**移除** fallback 到 `SUPABASE_SERVICE_ROLE_KEY`。
 *
 * 舊行為（fallback 到 service key）有兩個實質風險：
 *   ① **提權**：service role key 一旦洩漏（例如誤貼、log、第三方），攻擊者唔止可以讀寫 DB，
 *      仲可以直接用同一條 key **偽造 admin token** ⇒ 整個管理後台失守。
 *   ② **靜默失效**：rotate service key 會令所有 admin token 即刻驗唔過（但冇任何提示），
 *      兩件事本來唔應該綁在同一把鎖上。
 *
 * 代價（已同 J 確認）：冇設 `ADMIN_SESSION_SECRET` = 簽唔到／驗唔到 = 登入回 503（fail closed）。
 * 呢個係刻意嘅：寧願後台用唔到，都唔好靜靜用一把過強嘅 key 頂上。
 *
 * ⚠️ 輪換呢支 secret 會令**現有 admin token 全部失效**（所有人要重新登入）。
 *    另外 `pos/pos-device-token.ts` 的第二順位都係呢支 secret —— 如果生產未設
 *    `POS_DEVICE_TOKEN_SECRET`，POS 終端憑證亦會一齊失效（終端要重新登入）。
 *    建議兩支 secret 分開設，唔好互相依賴。
 */
function resolveSecret(): string | null {
  const dedicated = process.env.ADMIN_SESSION_SECRET?.trim();
  return dedicated || null;
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
