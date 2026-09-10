import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { UserRole } from "@/lib/types";

/**
 * POS 終端憑證（HMAC-signed，stateless）。
 *
 * 【背景 · 2026-09-10 掃碼點餐審查 P0-3】
 * `/api/pos/sync` 用 service_role 寫入，但**完全冇身份驗證** —— 而枱 QR 內容
 * `/menu?tableId=…&store=<merchantId>` 已經公開 storeId。任何掃過碼嘅人理論上
 * 可以偽造訂單、改金額、甚至 `ORDER_DELETED` 刪單。
 *
 * 【設計】
 * 同 `admin-session-token.ts` 同一套路（payload + HMAC-SHA256），但：
 *   1. **獨立 token kind（`pv1`）** —— admin token 唔可以當 POS token 用，反之亦然
 *      （`verifyPosDeviceToken()` 只認 `pv1`，跨用途即拒）。
 *   2. payload 帶 `storeId` —— server 可以驗「呢張 token 係咪真係有權寫呢間店」。
 *   3. 簽發點係 `/api/ledger/login`（server 端唯一權威知道 `merchantId` 嘅地方），
 *      唔使新增任何 credential 交換 / DB table。
 *
 * 【匿名通道】
 * 客人掃碼（`source="scan"`）本質上係匿名，唔可能帶 token。所以 server 對
 * **未帶憑證** 嘅請求只放行 `ORDER_CREATED` / `ORDER_UPDATED`，而且要求
 * payload `source ∈ {scan, kiosk}`；其餘（結帳 / 刪單 / 打印任務 / 設定）一律拒。
 * 見 `src/app/api/pos/sync/route.ts`。
 */

const TOKEN_VERSION = "pv1";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 小時（同 POS 一個班次級別）

export type PosDeviceClaims = {
  /** 呢張 token 有權寫入嘅店（merchantId / merchants.id） */
  storeId: string;
  /** 簽發時嘅 8 位員工帳號（審計用） */
  account: string;
  role: UserRole;
  /** 到期時間 epoch ms */
  exp: number;
};

/**
 * 簽名密鑰。優先專屬 secret，其次 admin secret，最後借用 service role key
 * （一樣 server-only、唔會入 client bundle）。
 *
 * 關鍵性質：寫入路徑本身**必須**有 service role key 先寫得入 DB，所以
 * 「能寫 ⇒ 有 secret ⇒ 簽得出 / 驗得到」三者一致，唔會出現「簽唔到但又要驗」。
 */
function resolveSecret(): string | null {
  const dedicated = process.env.POS_DEVICE_TOKEN_SECRET?.trim();
  if (dedicated) return dedicated;
  const adminSecret = process.env.ADMIN_SESSION_SECRET?.trim();
  if (adminSecret) return adminSecret;
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
 * 簽發一張 POS 終端 token。
 * @returns `null` = server 冇任何 secret → fail closed（唔簽、唔放行）。
 */
export function issuePosDeviceToken(claims: Omit<PosDeviceClaims, "exp">): string | null {
  const secret = resolveSecret();
  if (!secret) return null;
  if (!claims?.storeId) return null;

  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = base64url(
    JSON.stringify({ v: TOKEN_VERSION, storeId: claims.storeId, account: claims.account, role: claims.role, exp }),
  );
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * 驗證 token。通過就返 claims，否則返 `null`。
 * 失敗原因只落 server log（呼叫端自己決定要唔要 log），唔對外洩漏。
 */
export function verifyPosDeviceToken(token: string | null | undefined): PosDeviceClaims | null {
  if (!token) return null;
  const secret = resolveSecret();
  if (!secret) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(payload, secret))) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PosDeviceClaims & {
      v?: string;
    };
    if (decoded?.v !== TOKEN_VERSION) return null;
    if (typeof decoded.storeId !== "string" || !decoded.storeId) return null;
    if (typeof decoded.account !== "string" || !decoded.account) return null;
    if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return null;
    if (Date.now() > decoded.exp) return null;
    return { storeId: decoded.storeId, account: decoded.account, role: decoded.role, exp: decoded.exp };
  } catch {
    return null;
  }
}

/** 由 Request 抽出 `Authorization: Bearer <token>` 並驗證。 */
export function readPosDeviceTokenFromRequest(request: Request): PosDeviceClaims | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return verifyPosDeviceToken(header.slice(7).trim());
}

/**
 * 應唔應該強制驗證？
 *
 * 預設 **true（fail closed）**。設定 `POS_REQUIRE_DEVICE_AUTH=0` 可以暫時關閉
 * （應急回滾用：萬一客戶端未更新 / token 簽發環節出事，唔會令整間店收唔到單）。
 * 關閉時 server 會寫 warning log，方便事後審計。
 */
export function isPosDeviceAuthRequired(): boolean {
  const raw = process.env.POS_REQUIRE_DEVICE_AUTH?.trim();
  if (raw === undefined || raw === "") return true;
  return !(raw === "0" || raw.toLowerCase() === "false" || raw.toLowerCase() === "off");
}
