"use client";

import { getPosSupabaseClient } from "@/lib/pos/supabase-client";
import { posDeviceAuthHeadersFresh } from "@/lib/pos/pos-sync-auth";
import {
  REALTIME_AUTH_FAILURE_COOLDOWN_MS,
  decideRealtimeAuth,
  decodeJwtPayload,
  isUsableBoundToken,
} from "@/lib/pos/realtime-auth-claims";

/**
 * 《Realtime per-store 憑證 —— 客戶端執行層》（2026-09-23，第 2 階段）
 *
 * ## 一句話
 * 令 POS 收銀台／後廚屏嘅 Realtime 連線由 `anon` 身份升級做
 * **帶 `app_metadata.store_id` 嘅 `authenticated` 身份**，同時**任何一步失敗都保持
 * 現狀（anon）** —— 所以佢永遠唔會令情況比今日差。
 *
 * ## 完整次序（每一步都唔可以省，順序都唔可以換）
 *
 * ```
 * decideRealtimeAuth()                      ← 純決策，見 realtime-auth-claims.ts
 *   ├─ 冇 store／冇 client／冇終端憑證／冷卻中 → 回 null（＝保持 anon）
 *   ├─ 已有可用 session（已綁對店 + 未到期） → 直接用
 *   ├─ 冇 session                            → signInAnonymously()
 *   └─ 有 session 但未綁／綁錯店              → 直接去綁
 *        ↓
 *   POST /api/pos/realtime-bind             ← server 用 Admin API 寫 app_metadata
 *        ↓
 *   refreshSession()                        ← 🔴 一定要！JWT 係簽發時快照，
 *        ↓                                     改 app_metadata 唔會令舊 token 變
 *   isUsableBoundToken() 驗一次              ← 唔帶 store_id 就唔交出去
 *        ↓
 *   supabase.realtime.setAuth(token)        ← 整條 WebSocket 連線嘅身份
 * ```
 *
 * ## 🔴 為何 `setAuth` 一定要喺「建立 channel 之前」
 * Supabase 官方要求：`setAuth` 要在 instantiate client 之後、**connect channel 之前**。
 * 而且 Realtime 嘅身份係**每條連線**（唔係每個 channel）——
 * 所以只要有一個 hook 遲咗 `setAuth`，同一個 client 上**所有** channel
 * （`pos_orders` / `pos_print_jobs` / `pos_soldout` / `pos_kds_item_state` /
 * `pos_store_status` / `pos_online_order_settings`）都會用錯身份。
 * ⇒ 四個 realtime hook 一律喺 `subscribe()` 開頭 `await` 呢個函式。
 *
 * ## 🔴 為何失敗要「冷卻」而唔係即刻重試
 * 綁店要打 Admin API。如果係設定問題（例如冇 `SUPABASE_SERVICE_ROLE_KEY`），
 * 每次 subscribe／visibilitychange 都重試就等於每次重連都多打一輪註定失敗嘅請求。
 * 冷卻 5 分鐘：期間一律回 null（保持 anon，功能正常），唔會吵住 server。
 */

/** 綁店 endpoint（同 server 側 route 對應）。 */
const BIND_PATH = "/api/pos/realtime-bind";

interface CachedAuth {
  token: string;
  storeId: string;
}

let cached: CachedAuth | null = null;
let inFlight: Promise<string | null> | null = null;
let failedUntil = 0;
/** 只註冊一次 auth state listener。 */
let listenerBound = false;

type RealtimeAuthListener = (token: string | null) => void;
const listeners = new Set<RealtimeAuthListener>();

/**
 * 訂閱「Realtime 憑證改變」（包含 Supabase 自動續期 → 新 token）。
 *
 * 用途：hook 收到之後要**重新 subscribe**，否則連線仍然用住舊 token
 * ⇒ 舊 token 一過期，RLS 就開始全拒而**零 error**（靜默失效）。
 * 回傳 unsubscribe。
 */
export function onRealtimeAuthChanged(cb: RealtimeAuthListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(token: string | null): void {
  for (const cb of listeners) {
    try {
      cb(token);
    } catch {
      /* listener 出錯唔可以影響其他人 */
    }
  }
}

/**
 * 令 `supabase.realtime` 用呢個 token。
 * 抽成獨立函式方便測試同集中註解；失敗一律靜默（唔可以因為 setAuth 而炸個 hook）。
 */
function applyToRealtime(token: string | null): void {
  const supabase = getPosSupabaseClient();
  if (!supabase) return;
  try {
    supabase.realtime.setAuth(token);
  } catch {
    /* 保持現狀（連線會自己用返舊 token／anon），唔好 throw */
  }
}

/**
 * 確保 Realtime 有一個帶正確 store 嘅憑證。
 *
 * @returns 可直接餵 `setAuth` 嘅 access token；**任何唔肯定嘅情況回 `null`**
 *          （＝上層保持 anon，即今日行為）。
 *
 * 🔴 永不 throw、永不 reject —— 呼叫端全部都係 realtime hook，
 *    拋錯會令訂閱鏈斷，比「用返 anon」嚴重得多。
 */
export async function ensureRealtimeAuth(storeId: string | null): Promise<string | null> {
  const store = (storeId ?? "").trim();
  if (!store) return null;

  // 已經有同一間店嘅可用 token（module 層快取）→ 直接回，零請求。
  if (cached && cached.storeId === store) {
    const claims = decodeJwtPayload(cached.token);
    const exp = claims && typeof claims["exp"] === "number" ? (claims["exp"] as number) * 1000 : null;
    if (exp === null || exp - Date.now() > 60_000) {
      applyToRealtime(cached.token);
      return cached.token;
    }
    cached = null;
  }

  if (inFlight) return inFlight;

  inFlight = run(store)
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function run(storeId: string): Promise<string | null> {
  const supabase = getPosSupabaseClient();
  if (!supabase) return null;

  const deviceHeaders = await posDeviceAuthHeadersFresh().catch(() => null);
  const hasDeviceToken = Boolean(deviceHeaders?.Authorization);

  // 讀現有 session（失敗當冇）
  let session: { accessToken: string } | null = null;
  try {
    const res = await supabase.auth.getSession();
    const s = res.data?.session;
    if (s?.access_token) session = { accessToken: s.access_token };
  } catch {
    session = null;
  }

  const decision = decideRealtimeAuth({
    storeId,
    hasClient: true,
    hasDeviceToken,
    coolingDown: Date.now() < failedUntil,
    session: session ? { accessToken: session.accessToken, claims: decodeJwtPayload(session.accessToken) } : null,
    nowMs: Date.now(),
  });

  if (decision.action === "unavailable") return null;

  if (decision.action === "reuse") {
    cached = { token: decision.token, storeId };
    applyToRealtime(decision.token);
    bindAuthListener();
    return decision.token;
  }

  // ── 需要登入（未有 session）───────────────────────────────────────────────
  if (decision.action === "sign-in") {
    const res = await supabase.auth.signInAnonymously();
    const token = res.data?.session?.access_token;
    if (!token) {
      failedUntil = Date.now() + REALTIME_AUTH_FAILURE_COOLDOWN_MS;
      return null;
    }
    // 落到下面同一條綁店流程
  }

  // ── 綁店（server 用 Admin API 寫 app_metadata）────────────────────────────
  const bound = await bindStore(storeId);
  if (!bound) {
    failedUntil = Date.now() + REALTIME_AUTH_FAILURE_COOLDOWN_MS;
    return null;
  }

  // ── 🔴 refresh：攞返帶 store_id 嘅新 token ────────────────────────────────
  let newToken: string | null = null;
  try {
    const res = await supabase.auth.refreshSession();
    newToken = res.data?.session?.access_token ?? null;
  } catch {
    newToken = null;
  }

  if (!newToken || !isUsableBoundToken(newToken, storeId)) {
    // refresh 完仲係冇 store_id ⇒ **唔可以交出去**（交出去 = channel 連得上但永遠冇事件）
    failedUntil = Date.now() + REALTIME_AUTH_FAILURE_COOLDOWN_MS;
    return null;
  }

  cached = { token: newToken, storeId };
  applyToRealtime(newToken);
  bindAuthListener();
  return newToken;
}

/** 叫 server 綁店。失敗回 `false`（唔 throw）。 */
async function bindStore(storeId: string): Promise<boolean> {
  try {
    const supabase = getPosSupabaseClient();
    const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
    const accessToken = data?.session?.access_token;
    if (!accessToken) return false;

    const headers = await posDeviceAuthHeadersFresh();
    const res = await fetch(BIND_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ accessToken }),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const json = (await res.json().catch(() => null)) as { ok?: boolean; storeId?: string } | null;
    // server 回嘅 storeId 一定要係同一間（server 係權威，用嚟對帳）
    return Boolean(json?.ok) && json?.storeId === storeId;
  } catch {
    return false;
  }
}

/**
 * Supabase 自動續期（`autoRefreshToken: true`）會換新 token，
 * 但 **Realtime 連線唔會自己跟** ⇒ 要在呢度接住並通知 hook 重新 subscribe。
 */
function bindAuthListener(): void {
  if (listenerBound) return;
  const supabase = getPosSupabaseClient();
  if (!supabase) return;
  listenerBound = true;
  try {
    supabase.auth.onAuthStateChange((event, session) => {
      if (event !== "TOKEN_REFRESHED" && event !== "SIGNED_IN") return;
      const token = session?.access_token ?? null;
      if (!token) return;
      if (cached) cached = { token, storeId: cached.storeId };
      applyToRealtime(token);
      emit(token);
    });
  } catch {
    /* 冇事件通知都唔會壞：下次 subscribe 會再 ensure 一次 */
  }
}

/** 測試／除錯用：清空 module 狀態。 */
export function __resetRealtimeAuthForTests(): void {
  cached = null;
  inFlight = null;
  failedUntil = 0;
  listeners.clear();
}
