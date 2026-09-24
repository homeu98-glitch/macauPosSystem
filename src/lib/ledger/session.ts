"use client";

import { loadAuthSession, saveAuthSession, clearAuthSession as clearStoredAuthSession } from "@/lib/storage";

import { readClientBuildInfo } from "@/lib/build-info";
import { reportPosClientPresence } from "@/lib/ledger/client-presence";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

/**
 * 「每個分頁載入最多上報一次商戶端活躍」（2026-09-24，Ledger 契約 §4.6）。
 *
 * ## 為何要有呢個閂
 *
 * `ensureLedgerSession()` 被**十幾處**呼叫（訂單、會員、報表、券、Realtime…），
 * 每次都會 `setSession()`。冇閂嘅話，每次查詢都會多打一支 Ledger RPC
 * ⇒ 一個收銀分頁開一日就多幾千個請求（同 §8「唔可以加請求」嘅紀律衝突）。
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

/** Restore Supabase Auth session from POS auth cache after page load. */
export async function restoreLedgerSession(): Promise<boolean> {
  return (await ensureLedgerSession()) !== null;
}

/** Ensure Supabase RPC/Realtime auth is ready; sync refreshed tokens back to storage. */
export async function ensureLedgerSession(): Promise<string | null> {
  const session = loadAuthSession();
  const client = getLedgerSupabaseClient();
  if (!client || !session?.ledgerAccessToken || !session?.ledgerRefreshToken) {
    return null;
  }

  const { error } = await client.auth.setSession({
    access_token: session.ledgerAccessToken,
    refresh_token: session.ledgerRefreshToken,
  });
  if (error) return null;

  // 恢復 session 成功（＝店員重開分頁／PWA 重入）⇒ 補上「POS 端活躍」。
  // 🔴 唔 await：呢個係純 telemetry，唔可以阻任何業務（Realtime 連線、訂單讀取…）。
  //    client 端冇 serverless 凍結問題，所以 fire-and-forget 係安全嘅。
  // 🔴 失敗／超時由 `reportPosClientPresence()` 內部吞掉，呢度唔可以有 unhandled rejection。
  if (!presenceReportedThisPageLoad) {
    presenceReportedThisPageLoad = true;
    void reportPosClientPresence({
      client,
      merchantId: session.merchantId,
      appVersion: readClientBuildInfo().id,
      source: "restore",
    });
  }

  const { data } = await client.auth.getSession();
  const active = data.session;
  if (!active?.access_token) return session.ledgerAccessToken;

  if (
    active.access_token !== session.ledgerAccessToken ||
    (active.refresh_token && active.refresh_token !== session.ledgerRefreshToken)
  ) {
    saveAuthSession({
      ...session,
      ledgerAccessToken: active.access_token,
      ledgerRefreshToken: active.refresh_token ?? session.ledgerRefreshToken,
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
