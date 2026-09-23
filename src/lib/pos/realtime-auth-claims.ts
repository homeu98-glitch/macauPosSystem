/**
 * 《Realtime per-store 憑證 —— 純決策模組》（2026-09-23，per-store token 第 2 階段）
 *
 * ## 為何要抽一個零依賴模組
 *
 * 決策邏輯一旦寫落 `"use client"` 嘅 hook 或者 client 執行層，就冇得用
 * `node --test` 測（`npm test` ＝ `node --test`：唔認 `@/` 別名、唔支援 `.tsx`）。
 * 而呢幾條判斷嘅後果係「**列印失去即時喚醒 / 訂單唔再自動彈出**」而且**零 error**
 * ——正是本專案最常中嘅靜默失效型，所以一定要可以逐條測。
 *
 * ## 背景（完整評估見 docs/reviews/per-store-token-assessment-2026-09-23.md）
 *
 * Supabase 專案已用**非對稱簽名金鑰（ECC P-256）**，官方明文私鑰取唔出
 * ⇒ 唔可以自簽 JWT。所以改用 **Supabase Auth 簽發**：
 *   1. client `signInAnonymously()` 取得 `role:"authenticated"` 嘅 JWT；
 *   2. server 用 Admin API 把 `store_id` 寫入 **`app_metadata`**（只有 service_role 寫得入）；
 *   3. client **`refreshSession()`** 攞返帶 `store_id` 嘅**新** JWT；
 *   4. `realtime.setAuth(新 JWT)` → Realtime 嘅 RLS 檢查終於有 store claim 可用。
 *
 * 🔴 第 3 步唔可以省：JWT 係**簽發時嘅快照**，改 `app_metadata` 唔會令舊 token 變。
 *    舊 token 冇 `store_id` ⇒ RLS 全拒，但 channel 照樣 `SUBSCRIBED`、**零 error**。
 */

/** 呢個 module 唔可以 import 任何 runtime／`@/` 別名（要可以 node --test 直接載入）。 */

/** 距離到期少於呢個時間就當「要用新 token」——唔好等到最後一刻（時鐘漂移 + 網絡延遲）。 */
export const REALTIME_AUTH_SKEW_MS = 3 * 60 * 1000;

/** 綁店失敗之後嘅冷卻期：避免每次 subscribe 都再打一次註定失敗嘅請求。 */
export const REALTIME_AUTH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

/** base64url → 字串（瀏覽器 `atob` 需要補 padding 同換返標準 base64 字母）。 */
export function base64UrlDecode(input: string): string | null {
  try {
    const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    // 瀏覽器有 atob；Node 有 Buffer。兩者都試，純函式唔 throw。
    if (typeof atob === "function") {
      // atob 出 binary string；JWT payload 係 UTF-8 JSON ⇒ 要再解一次。
      const bin = atob(padded);
      try {
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
      } catch {
        return bin;
      }
    }
    const B = (globalThis as { Buffer?: { from: (s: string, e: string) => { toString: (e: string) => string } } }).Buffer;
    if (B) return B.from(padded, "base64").toString("utf8");
    return null;
  } catch {
    return null;
  }
}

/** 解 JWT payload（**唔驗簽名** —— 只係用嚟讀 claim；授權仍由 server + RLS 負責）。 */
export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const json = base64UrlDecode(parts[1]);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 由 claims 讀「呢張 token 代表邊間店」。
 *
 * 次序（同 0052 migration 嘅政策口徑**完全一致**，唔可以漂移）：
 *   1. `app_metadata.store_id` —— Supabase Auth 簽發路徑
 *   2. 頂層 `store_id` —— 自簽路徑（保留兼容）
 *
 * ⚠️ 兩邊一漂移就會出現「政策認得、client 唔認得」（或者相反）⇒ 永遠綁唔到店。
 */
export function readStoreIdFromClaims(claims: Record<string, unknown> | null): string | null {
  if (!claims) return null;
  const appMeta = claims["app_metadata"];
  if (appMeta && typeof appMeta === "object") {
    const v = (appMeta as Record<string, unknown>)["store_id"];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const top = claims["store_id"];
  if (typeof top === "string" && top.trim()) return top.trim();
  return null;
}

/** 由 claims 讀到期時間（epoch ms）；讀唔到回 null（＝唔可以判斷，要當「需要換」）。 */
export function readExpiryMs(claims: Record<string, unknown> | null): number | null {
  if (!claims) return null;
  const exp = claims["exp"];
  if (typeof exp === "number" && Number.isFinite(exp)) return exp * 1000;
  if (typeof exp === "string" && exp.trim() && Number.isFinite(Number(exp))) return Number(exp) * 1000;
  return null;
}

/** 是否 Supabase Auth 嘅匿名用戶（`is_anonymous === true`）。 */
export function isAnonymousClaims(claims: Record<string, unknown> | null): boolean {
  return claims?.["is_anonymous"] === true;
}

export type RealtimeAuthDecision =
  | { action: "unavailable"; reason: RealtimeAuthUnavailableReason }
  | { action: "reuse"; token: string }
  | { action: "sign-in" }
  | { action: "bind"; accessToken: string };

export type RealtimeAuthUnavailableReason =
  | "no-store"          // 未登入／未有 store（kiosk、掃碼客人）
  | "no-client"         // env 未設，冇 POS Supabase client
  | "no-device-token"   // 冇 POS 終端憑證 ⇒ 綁唔到店（fail-safe：照用 anon）
  | "cooling-down";     // 上次失敗，冷卻中

export interface RealtimeAuthSessionInput {
  accessToken: string;
  claims: Record<string, unknown> | null;
}

export interface DecideRealtimeAuthInput {
  storeId: string | null;
  hasClient: boolean;
  hasDeviceToken: boolean;
  /** 上次失敗之後係咪仍然喺冷卻期。 */
  coolingDown: boolean;
  /** 目前嘅 Supabase Auth session（冇就 null）。 */
  session: RealtimeAuthSessionInput | null;
  nowMs: number;
}

/**
 * 唯一決策入口。**唔會 throw**，任何唔肯定嘅情況一律回 `unavailable`
 * ⇒ 上層保持 anon 行為（＝最壞情況同今日一樣，唔會更差）。
 */
export function decideRealtimeAuth(input: DecideRealtimeAuthInput): RealtimeAuthDecision {
  const storeId = (input.storeId ?? "").trim();
  if (!storeId) return { action: "unavailable", reason: "no-store" };
  if (!input.hasClient) return { action: "unavailable", reason: "no-client" };
  if (!input.hasDeviceToken) return { action: "unavailable", reason: "no-device-token" };
  if (input.coolingDown) return { action: "unavailable", reason: "cooling-down" };

  const session = input.session;
  if (!session || !session.accessToken) return { action: "sign-in" };

  const boundStore = readStoreIdFromClaims(session.claims);
  const expiry = readExpiryMs(session.claims);

  // 到期時間讀唔到 ⇒ 當「唔夠新」，寧願 refresh 一次都唔好博。
  const freshEnough = expiry !== null && expiry - input.nowMs > REALTIME_AUTH_SKEW_MS;

  if (boundStore === storeId && freshEnough) {
    return { action: "reuse", token: session.accessToken };
  }

  // 已綁對店但 token 快到期 → 交返上層 refresh（唔需要再綁）。
  // 未綁／綁錯店 → 要綁（綁完上層一定會 refreshSession 攞新 token）。
  return { action: "bind", accessToken: session.accessToken };
}

/**
 * 綁店成功／refresh 之後，判斷「新 token 係咪真係帶咗正確嘅 store」。
 *
 * 🔴 呢個係防「靜默失效」嘅最後一道閘：refresh 之後 claim 仲未出現
 * （例如 Admin API 寫入失敗、或者 claim 位置同政策唔一致），
 * 就**唔應該**把 token 交去 `setAuth` —— 因為咁樣會令 channel 連得上但永遠冇事件。
 * 寧願回 false → 上層保持 anon（今日行為），至少唔會靜默壞。
 */
export function isUsableBoundToken(token: string, storeId: string): boolean {
  const claims = decodeJwtPayload(token);
  if (!claims) return false;
  return readStoreIdFromClaims(claims) === storeId;
}
