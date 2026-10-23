"use client";

import { loadAuthSession, saveAuthSession, clearAuthSession as clearStoredAuthSession } from "@/lib/storage";

import { readClientBuildInfo } from "@/lib/build-info";
import { reportPosClientPresence } from "@/lib/ledger/client-presence";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";
import { decideLedgerSessionAction } from "@/lib/ledger/ledger-session-decision";
import { syncDeviceBindingRefreshToken, markDeviceSignedOut } from "@/lib/pos/device-binding";
import { decodeJwtPayload, readExpiryMs } from "@/lib/pos/realtime-auth-claims";

/**
 * 「每個分頁載入最多上報一次商戶端活躍」（2026-09-24，Ledger 契約 §4.6）。
 *
 * ## 為何要有呢個閂
 *
 * `ensureLedgerSession()` 被**十幾處**呼叫（訂單、會員、報表、券、Realtime…）。
 * 冇閘嘅話，每次查詢都會多打一支 Ledger RPC ⇒ 一個收銀分頁開一日就多幾千個請求
 * （同 §8「唔可以加請求」嘅紀律衝突）。
 *
 * ## 為何唔用 localStorage
 *
 * 用 localStorage 記「報過」＝一部機報一次就**永遠**唔再報 ——
 * 之後每次返工、每次重開分頁都唔會更新活躍時間，而且冇任何方法察覺。
 * 記憶體閂＝每次重開分頁報一次，正好對應契約要求嘅「恢復 session 時上報」。
 *
 * ⚠️ 唔需要自己計 6 小時：Ledger DB 端同一 `(merchant_id, 'pos')` 6 小時內
 *    重複呼叫通常唔更新 `last_login_at`。
 */
let presenceReportedThisPageLoad = false;

/** 只供測試。 */
export function resetPresenceLatchForTest(): void {
  presenceReportedThisPageLoad = false;
}

/**
 * single-flight 閘（2026-10-16，Ledger PR#40）。
 *
 * ## 為咩要合併併發
 *
 * ① 開頁時 **7 個 mount**一齊跑 `restoreLedgerSession()`（auth-guard／device-settings／
 *    online-orders／quick-online-orders-panel／restaurant-daily-report ×2／shift-page），
 *    加上兩條 Realtime hook 嘅 subscribe —— 冇閂就會同時打 N 次。
 * ② 🔴 refresh token **會輪換**：兩個併發呼叫一個行 `refreshSession()`、一個用 storage
 *    舊票行 `setSession()`，舊 refresh token 已死 ⇒ 失敗彈登入。serialize 之後
 *    先刷新嗰個會 sync 返 storage，第二个見到嘅已經係新票。
 */
let sessionInFlight: Promise<string | null> | null = null;

/** Restore Supabase Auth session from POS auth cache after page load. */
export async function restoreLedgerSession(): Promise<boolean> {
  return (await ensureLedgerSession()) !== null;
}

/**
 * Ensure Supabase RPC/Realtime auth is ready; sync refreshed tokens back to storage.
 *
 * 🔴 2026-10-16（Ledger PR#40）：**唔可以再每次呼叫都 `setSession()`** ——
 * supabase-js 2.112 喺 token 未過期時固定打 `GET /auth/v1/user` 驗證
 * （auth-js `_setSession()` → `_getUser()`，node_modules 實測）。
 * 十幾處呼叫端 ⇒ 晚市一台 iPad 實測 154 次／時。
 *
 * 改為 single-flight + 分流（決策邏輯見 `ledger-session-decision.ts`）：
 *   ① 記憶體已有未過期 session → `getSession()`（純本地，零網路）
 *   ② ≤5 分鐘到期 → `refreshSession()`，新票寫返 POS storage
 *   ③ client 未接管過／換身份 → `setSession()`（每頁最多一次）
 *
 * TOKEN_REFRESHED → `realtime.setAuth` 由兩路保證：supabase-js 內置
 * `_handleTokenChanged`（bundle 實測會自動做）＋ `supabase-client.ts` 顯式 listener。
 */
export function ensureLedgerSession(): Promise<string | null> {
  if (!sessionInFlight) {
    sessionInFlight = resolveLedgerSession().finally(() => {
      sessionInFlight = null;
    });
  }
  return sessionInFlight;
}

async function resolveLedgerSession(): Promise<string | null> {
  const stored = loadAuthSession();
  const client = getLedgerSupabaseClient();
  if (!client || !stored?.ledgerAccessToken || !stored?.ledgerRefreshToken) {
    return null;
  }

  // 本地讀取：persistSession:false ⇒ session 存記憶體，`getSession()` 唔打網路。
  // （只有到期前 90s 內先會自動 refresh —— 嗰次 refresh 會觸發 TOKEN_REFRESHED，
  //   realtime 換票由 supabase-js 內置 + 顯式 listener 雙重保證。）
  const { data, error } = await client.auth.getSession();
  const clientSession = error ? null : data.session;

  const decision = decideLedgerSessionAction({
    storedAccessToken: stored.ledgerAccessToken,
    storedExpiresAtMs: readExpiryMs(decodeJwtPayload(stored.ledgerAccessToken)),
    clientAccessToken: clientSession?.access_token ?? null,
    clientExpiresAtMs: clientSession?.expires_at ? clientSession.expires_at * 1000 : null,
    nowMs: Date.now(),
  });

  if (decision.action === "unauthorized") return null;

  if (decision.action === "bootstrap") {
    // 每頁最多一次嘅網路驗證（登入嗰次 `setSession` 由 login-screen 自己做，唔經過呢度）。
    const { error: setError } = await client.auth.setSession({
      access_token: stored.ledgerAccessToken,
      refresh_token: stored.ledgerRefreshToken,
    });
    if (setError) return null;
  } else if (decision.action === "refresh") {
    // 用 client 而家嘅 session 去 refresh —— **唔可以**攰 storage 舊票：
    // 舊 refresh token 可能已被輪換（另一分頁／auto-ticker 醒先刷新）。
    if (!clientSession) return null;
    const { error: refreshError } = await client.auth.refreshSession(clientSession);
    if (refreshError) return null;
  }

  // 任何路径成功後都要 sync 返 POS storage（client persistSession:false，唔會幫我哋寫；
  // 而 `ensure-customer.ts` 等直接 fetch 嘅路径要用最新票）。
  let active = clientSession;
  if (decision.action !== "reuse") {
    const { data: after } = await client.auth.getSession();
    active = after.session;
  }
  if (!active?.access_token) return stored.ledgerAccessToken;

  if (
    active.access_token !== stored.ledgerAccessToken ||
    (active.refresh_token && active.refresh_token !== stored.ledgerRefreshToken)
  ) {
    const nextRefreshToken = active.refresh_token ?? stored.ledgerRefreshToken;
    saveAuthSession({
      ...stored,
      ledgerAccessToken: active.access_token,
      ledgerRefreshToken: nextRefreshToken,
    });
    // 🔴 裝置授權（docs/160 §10）：refresh token 一輪換，server 嗰張副本就即刻變廢票。
    // 唔同步返去，第二日「免店主帳密開機」會靜靜失敗（授權已失效）。
    if (nextRefreshToken && nextRefreshToken !== stored.ledgerRefreshToken) {
      syncDeviceBindingRefreshToken(nextRefreshToken);
    }
  }

  // 恢復 session 成功（＝店員重開分頁／PWA 重入）⇒ 補上「POS 端活躍」。
  // 🔴 唔 await：呢個係純 telemetry，唔可以阻任何業務（Realtime 連線、訂單讀取…）。
  //    client 端冇 serverless 凍結問題，所以 fire-and-forget 係安全嘅。
  // 🔴 失敗／超時由 `reportPosClientPresence()` 內部吞掉，呢度唔可以有 unhandled rejection。
  if (!presenceReportedThisPageLoad) {
    presenceReportedThisPageLoad = true;
    void reportPosClientPresence({
      client,
      merchantId: stored.merchantId,
      appVersion: readClientBuildInfo().id,
      source: "restore",
    });
  }

  return active.access_token;
}

export function getLedgerMerchantId(): string | null {
  return loadAuthSession()?.merchantId ?? null;
}

export function getLedgerAccessToken(): string | null {
  return loadAuthSession()?.ledgerAccessToken ?? null;
}

export async function signOutLedgerSession(): Promise<void> {
  // 裝置授權（docs/160 §10）：店主主動「登出」= 唔再自動開機。
  // 冇呢個標記，頁面一 reload 就會用裝置憑證靜靜登入返，睇落似 bug。
  // 要真正取消呢部機嘅授權，去「權限控制 › 裝置授權 › 撤銷」。
  markDeviceSignedOut();
  const client = getLedgerSupabaseClient();
  if (client) {
    try {
      const channels = client.getChannels();
      await Promise.all(channels.map((channel) => client.removeChannel(channel)));
      await client.auth.signOut({ scope: "local" });
    } catch {
      // ignore
    }
  }
  clearStoredAuthSession();
}
