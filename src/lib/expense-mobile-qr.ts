/**
 * 手機版庫存表 QR —— SSO token 簽發 + 短碼映射（2026-10-22 · J 要求）。
 *
 * ## 功能
 * 庫存頁右上角「手機版庫存表」掣 → 彈窗顯示二維碼 → 手機一掃即登入
 * `https://expense-recorder-sigma.vercel.app` 並直接使用。
 *
 * ## 點解要「短碼」而唔直接將 JWT 入 QR
 * 本 repo 嘅 QR 編碼器（`lib/qrcode.ts`）最大只到 version 6（136 bytes），
 * 而 HS256 JWT（含 UUID shopId）約 400-700 字元 ⇒ 直接編會「太長，無法生成 QR」。
 * 所以 QR 只載一個 **10 位短碼**：
 *
 * ```
 * QR: https://expense-recorder-sigma.vercel.app/api/auth/sso-qr?code=<10位>
 *   → expenseRecorder 查 mobile_qr_sessions 拎返真‧JWT（delete-on-read）
 *   → 302 /sso#ssoToken=<JWT> → 現有 SSO 流程（驗簽／防重放／開戶／落 session）
 * ```
 *
 * ## 安全模型
 * - JWT：HS256、`expenseRecorder/lib/sso.ts` 嘅 `verifyMacauLedgerSsoToken()` 規格
 *   （iss=macau-ledger / aud=expense-recorder / role=owner / shop.shopId / jti…）。
 * - 短效：預設 5 分鐘（`POS_MOBILE_QR_TTL_SECONDS`，clamp 60..900）。
 * - 一次性：expenseRecorder 讀完即刪；重放另有 `sso_token_logins.jti` 擋。
 * - 短碼：Crockford base32（免 I/L/O/U）10 位 ≈ 50 bit，暴力枚举唔現實。
 *
 * ## ⚠️ 只准 server 端 import
 * 本檔用 `node:crypto`（HMAC）。**刻意唔加 `import "server-only"`** ——
 * `node --test` 解析唔到嗰個 alias（見 `src/lib/pos/session-identity-guard.test.ts`
 * 頂部註解），加咗單測就跑唔到；改由「只有 API route import 佢」＋ 頂部註解守護。
 * 若被 client component import，`next build` 會因 node:crypto 直接報錯（fail loud）。
 */

import crypto from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

/** 短碼長度（Crockford base32）。10 位 = 32^10 ≈ 1.1e15 組合。 */
export const MOBILE_QR_CODE_LENGTH = 10;

/** Crockford base32 字母表（去掉容易睇錯嘅 I / L / O / U）。 */
export const MOBILE_QR_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 短碼格式（expenseRecorder `sso-qr` route 用同一條 regex 校驗）。 */
export const MOBILE_QR_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** 預設 TTL（秒）。 */
export const MOBILE_QR_DEFAULT_TTL_SECONDS = 300;

/** TTL 下限／上限（秒）。 */
export const MOBILE_QR_MIN_TTL_SECONDS = 60;
export const MOBILE_QR_MAX_TTL_SECONDS = 900;

/** expenseRecorder 網址預設值（可用 `EXPENSE_RECORDER_WEB_URL` 覆蓋）。 */
export const EXPENSE_RECORDER_WEB_URL_DEFAULT = "https://expense-recorder-sigma.vercel.app";

/**
 * JWT claims —— 對齊 `expenseRecorder/lib/sso.ts` 嘅 `MacauLedgerSsoClaims`
 * （只列我方簽發嘅部分；對方 verify 時要求嘅必填項見 `buildMobileQrClaims`）。
 */
export type MobileQrClaims = {
  iss: string;
  aud: string;
  /** `owner:<merchantId>`（Ledger 穩定店舖 ID）。 */
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  role: "owner";
  shop: { shopId: string; shopName: string | null };
  owner: { ownerId: string; phone: string };
  redirect: { path: string };
};

export type BuildClaimsResult = { claims: MobileQrClaims };

/**
 * 組出 SSO claims（純函式，單測直接覆蓋）。
 *
 * 必填項由 `verifyMacauLedgerSsoToken()` 規定：
 *   iss / aud / sub / jti / iat / exp / role=owner / shop.shopId
 * 可選但有意義：shop.shopName（顯示名，UPDATE 路徑會覆寫 shop_name）、
 *   owner.phone（8 位 → login_id fallback 配對）、redirect.path（登入後著落）。
 */
export function buildMobileQrClaims(opts: {
  storeId: string;
  storeName: string;
  account: string;
  ttlSeconds?: number;
  nowMs?: number;
  issuer?: string;
  audience?: string;
}): BuildClaimsResult {
  const nowMs = opts.nowMs ?? Date.now();
  const ttl = clampTtlSeconds(opts.ttlSeconds);
  const iat = Math.floor(nowMs / 1000);
  const storeId = opts.storeId.trim();
  const claims: MobileQrClaims = {
    iss: (opts.issuer ?? "").trim() || "macau-ledger",
    aud: (opts.audience ?? "").trim() || "expense-recorder",
    sub: `owner:${storeId}`,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + ttl,
    role: "owner",
    shop: {
      shopId: storeId,
      shopName: sanitizeShopName(opts.storeName, opts.account),
    },
    owner: {
      ownerId: storeId,
      phone: opts.account,
    },
    redirect: { path: "/" },
  };
  return { claims };
}

/** 店名清洗：空／過長 → 回退 `店號 <account>`（expenseRecorder INSERT 路徑要非空）。 */
export function sanitizeShopName(raw: string, account: string): string {
  const t = (raw ?? "").trim().slice(0, 60);
  return t || `店號 ${account}`;
}

/** TTL clamp：非數字／超出範圍 → 預設值；只收 60..900 秒。 */
export function clampTtlSeconds(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return MOBILE_QR_DEFAULT_TTL_SECONDS;
  const v = Math.floor(raw);
  if (v < MOBILE_QR_MIN_TTL_SECONDS) return MOBILE_QR_MIN_TTL_SECONDS;
  if (v > MOBILE_QR_MAX_TTL_SECONDS) return MOBILE_QR_MAX_TTL_SECONDS;
  return v;
}

export function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input as Buffer).toString("base64url");
}

/**
 * HS256 簽 JWT（純函式；單測用同一條 HMAC 反驗簽名）。
 *
 * ⚠️ header 固定 `{"alg":"HS256","typ":"JWT"}` —— expenseRecorder 只接受 HS256
 * （`parsed.header?.alg !== "HS256"` → 拋錯），唔可以加 `kid` 之類。
 */
export function signHs256Jwt(claims: Record<string, unknown>, secret: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/** 產生一個 10 位 Crockford base32 短碼。 */
export function generateMobileQrCode(): string {
  const bytes = crypto.randomBytes(MOBILE_QR_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < MOBILE_QR_CODE_LENGTH; i++) {
    out += MOBILE_QR_CODE_ALPHABET[bytes[i] % MOBILE_QR_CODE_ALPHABET.length];
  }
  return out;
}

/** 短碼 ↔ JWT 映射列（expenseRecorder DB `mobile_qr_sessions`）。 */
export type MobileQrCodeRow = {
  code: string;
  sso_token: string;
  external_shop_id: string;
  /** ISO 時間（= JWT exp，兩者必須一致）。 */
  expires_at: string;
};

/** 假 store 可實作呢個 interface 做單測；真實實作見 `createExpenseMobileQrStore`。 */
export type MobileQrCodeStore = {
  insert(row: MobileQrCodeRow): Promise<unknown>;
};

export type IssueMobileQrResult =
  | {
      ok: true;
      code: string;
      ssoToken: string;
      expiresAtIso: string;
      ttlSeconds: number;
      claims: MobileQrClaims;
    }
  | { ok: false; status: 400 | 500; error: string; code?: string };

/**
 * 簽發一次手機版庫存表 QR session：組 claims → 簽 JWT → 寫短碼映射。
 *
 * 輸入校驗（400）：`storeId` 非空、`account` 必須 8 位數字、`secret` 非空。
 * 缺表（`mobile_qr_sessions` 未跑 migration）→ `{ code: "QR_TABLE_MISSING" }`，
 * 由 route 轉成「功能未啟用」提示，唔好當成 500 黑洞。
 */
export async function issueMobileQrSession(
  store: MobileQrCodeStore,
  opts: {
    storeId: string;
    storeName: string;
    account: string;
    secret: string;
    ttlSeconds?: number;
    nowMs?: number;
    issuer?: string;
    audience?: string;
  },
): Promise<IssueMobileQrResult> {
  const storeId = (opts.storeId ?? "").trim();
  if (!storeId) return { ok: false, status: 400, error: "缺少 storeId（店舖）" };
  if (!/^\d{8}$/.test(opts.account ?? "")) {
    return { ok: false, status: 400, error: "account 必須為 8 位數字" };
  }
  const secret = (opts.secret ?? "").trim();
  if (!secret) return { ok: false, status: 500, error: "SSO secret 未設定", code: "SSO_SECRET_MISSING" };

  const ttl = clampTtlSeconds(opts.ttlSeconds);
  const { claims } = buildMobileQrClaims({
    storeId,
    storeName: opts.storeName,
    account: opts.account,
    ttlSeconds: ttl,
    nowMs: opts.nowMs,
    issuer: opts.issuer,
    audience: opts.audience,
  });

  const ssoToken = signHs256Jwt(claims as unknown as Record<string, unknown>, secret);
  const code = generateMobileQrCode();
  const expiresAtIso = new Date(claims.exp * 1000).toISOString();

  try {
    await store.insert({
      code,
      sso_token: ssoToken,
      external_shop_id: storeId,
      expires_at: expiresAtIso,
    });
  } catch (err) {
    const db = toDbError(err);
    if (isMissingTableError(err)) {
      return {
        ok: false,
        status: 500,
        error: "mobile_qr_sessions 資料表未建立（請先在 expenseRecorder Supabase 執行 migration）",
        code: "QR_TABLE_MISSING",
      };
    }
    return { ok: false, status: 500, error: db?.message ?? "建立手機版庫存表 session 失敗" };
  }

  return { ok: true, code, ssoToken, expiresAtIso, ttlSeconds: ttl, claims };
}

/**
 * 真實 supabase 實作（server 端用；service_role，bypass RLS）。
 *
 * 寫入 `mobile_qr_sessions`（expenseRecorder DB）。刻意**唔做** 42703 欄位降級 ——
 * 張表係今次一手建立嘅，所有欄都由我哋嘅 migration 定義；缺表（42P01）先至係
 * 現實故障模式，交由 `issueMobileQrSession` 轉成 QR_TABLE_MISSING。
 */
export function createExpenseMobileQrStore(client: SupabaseClient): MobileQrCodeStore {
  return {
    async insert(row: MobileQrCodeRow) {
      const { error } = await client.from("mobile_qr_sessions").insert(row);
      if (error) throw error;
    },
  };
}

function toDbError(err: unknown): { code?: string; message?: string } | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; message?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
  };
}

/**
 * 「表不存在」判斷（同 `api/inventory/receipts` 嘅 `isMissingTable()` 同思路）。
 * PostgREST 對不存在嘅 table：`42P01`（Postgres）或 `PGRST205`（schema cache）。
 */
function isMissingTableError(err: unknown): boolean {
  const db = toDbError(err);
  if (!db) return false;
  if (db.code === "42P01" || db.code === "PGRST205") return true;
  const m = db.message ?? "";
  return /relation .* does not exist/i.test(m) || /Could not find the table/i.test(m);
}
