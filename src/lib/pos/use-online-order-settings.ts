"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { getPosSupabaseClient } from "@/lib/pos/supabase-client";
import { loadAuthSession, loadPosLocalSettings, savePosLocalSettings } from "@/lib/storage";

/**
 * 線上訂單「自動接單」設定 —— **server 係真源，全店共用**（docs/92）。
 *
 * ── 點解要呢個檔案 ────────────────────────────────────────────────────────
 * 舊做法：`localSettings.onlineOrderSettings.autoAccept`（localStorage，**per-terminal**）。
 * 三個死症：
 *   1. **Ledger 改咗 POS 唔會顯示**：唯一讀 server 嘅地方（`device-settings.tsx` GET）
 *      每個分支都 `return current`，server 值從來冇被採用過（死 code）。
 *   2. **機與機之間唔同步**：A 機撳咗，B 機完全唔知。
 *   3. **無渠道知**：全專案禁 polling，而 `online_order_settings` 冇 Realtime 訂閱。
 *
 * 新做法（docs/92 §6）：
 *   1. 初值 = localStorage 快取（離線優先，唔會白屏 / 唔會 hydration mismatch）
 *   2. mount → GET /api/online-order-settings?storeId=… → **server 值覆蓋快取**（server 權威）
 *   3. 訂閱 Supabase Realtime（`pos_online_order_settings`，filter store_id）→ 即時跟住變
 *   4. setter = 樂觀更新 → POST → 失敗 rollback + 報錯
 *
 * ⚠️ 點解係 module-level singleton store 而唔係普通 `useState` hook：
 *    `online-orders.tsx` 同 `pos-app.tsx` 會同時要呢個值。如果各自 `useState`，
 *    會開兩條 Realtime channel、兩次 GET，而且兩邊 state 會唔同步（一邊開一邊關）。
 *    用 `useSyncExternalStore` 包一個 module store，全部 call site 共享同一份狀態。
 */

export type AutoAcceptSource = "cache" | "server";

export type OnlineOrderSettingsState = {
  autoAccept: boolean;
  /** 第一次 server 讀取完成之前係 true（UI 可以用嚟 disable 個掣）。 */
  loading: boolean;
  /** 上一次 POST 嘅錯誤訊息；成功會清空。 */
  error: string | null;
  /** 而家顯示緊嘅值係快取定係 server 返嚟。 */
  source: AutoAcceptSource | null;
};

const INITIAL: OnlineOrderSettingsState = {
  autoAccept: false,
  loading: true,
  error: null,
  source: null,
};

let state: OnlineOrderSettingsState = INITIAL;
const listeners = new Set<() => void>();

let activeStoreId: string | null = null;
let refCount = 0;
let channel: ReturnType<
  NonNullable<ReturnType<typeof getPosSupabaseClient>>["channel"]
> | null = null;
let cacheHydrated = false;

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<OnlineOrderSettingsState>) {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

function getServerSnapshot() {
  return INITIAL;
}

/** 寫 localStorage 快取（離線時用家撳掣仍然有反應）。 */
function writeCache(autoAccept: boolean) {
  if (typeof window === "undefined") return;
  try {
    const current = loadPosLocalSettings();
    savePosLocalSettings({
      ...current,
      onlineOrderSettings: { ...current.onlineOrderSettings, autoAccept },
    });
  } catch {
    // 快取寫唔到唔好拖累主流程
  }
}

/** 第 1 步：用 localStorage 快取做初值（只做一次）。 */
function hydrateFromCache() {
  if (cacheHydrated || typeof window === "undefined") return;
  cacheHydrated = true;
  try {
    setState({
      autoAccept: loadPosLocalSettings().onlineOrderSettings.autoAccept,
      source: "cache",
    });
  } catch {
    // 讀唔到就用 default
  }
}

/** 第 2 步：由 server 拉最新值（server 權威）。 */
async function refreshFromServer(storeId: string) {
  try {
    const response = await fetch(
      `/api/online-order-settings?storeId=${encodeURIComponent(storeId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) {
      setState({ loading: false, error: null }); // server 讀唔到 → 繼續用快取，唔好彈 error
      return;
    }
    const payload = (await response.json()) as {
      ok?: boolean;
      /** null = server 冇呢間店嘅記錄（未設定過）→ 繼續用快取 */
      autoAccept?: boolean | null;
      fallback?: boolean;
    };
    if (payload.autoAccept === null || payload.autoAccept === undefined) {
      // 未設定過：保持快取值，但唔好再話 server 未返
      setState({ loading: false, error: null });
      return;
    }
    setState({
      autoAccept: payload.autoAccept,
      loading: false,
      error: null,
      source: payload.fallback ? "cache" : "server",
    });
    writeCache(payload.autoAccept);
  } catch {
    setState({ loading: false }); // 離線：維持快取值
  }
}

/** 第 3 步：訂閱 Realtime，任何終端 / Ledger 改咗即時跟住變（**唔 polling**）。 */
function subscribeRealtime(storeId: string) {
  const supabase = getPosSupabaseClient();
  if (!supabase) return;

  channel = supabase
    .channel(`pos-online-order-settings:${storeId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "pos_online_order_settings",
        filter: `store_id=eq.${storeId}`,
      },
      (payload) => {
        const row = payload.new as { store_id?: string; auto_accept?: boolean } | null;
        if (!row || typeof row.auto_accept !== "boolean") return;
        setState({ autoAccept: row.auto_accept, loading: false, error: null, source: "server" });
        writeCache(row.auto_accept);
      },
    )
    .subscribe();
}

function unsubscribeRealtime() {
  if (!channel) return;
  void channel.unsubscribe();
  channel = null;
}

/**
 * 線上訂單「自動接單」設定。
 *
 * @param storeId 商家 id（`loadAuthSession()?.merchantId` / `getLedgerMerchantId()`）；null 就唔會拉資料
 * @param enabled 關掉就唔拉資料、唔訂閱（例如離線模式）
 */
export function useOnlineOrderSettings(storeId: string | null, enabled = true) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!enabled || !storeId) return;

    refCount += 1;
    activeStoreId = storeId;
    hydrateFromCache();
    void refreshFromServer(storeId);
    if (refCount === 1) subscribeRealtime(storeId);

    // 後備：由背景切返前景時補拉一次。
    // 唔係 polling —— 淨係喺用家真係返嚟嗰陣先 call。
    // 點解要：如果 server 寫去嘅 Supabase 同前端 Realtime 訂閱嘅唔係同一個 project
    // （`SUPABASE_URL` vs `NEXT_PUBLIC_SUPABASE_URL`，見 docs/92 §1.3），Realtime 唔會著，
    // 呢條後備保證畫面最多「返嚟之後」先更新，而唔係永遠停喺舊值。
    function onVisibility() {
      if (document.visibilityState === "visible" && activeStoreId) {
        void refreshFromServer(activeStoreId);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      refCount -= 1;
      document.removeEventListener("visibilitychange", onVisibility);
      if (refCount <= 0) {
        refCount = 0;
        activeStoreId = null;
        unsubscribeRealtime();
      }
    };
  }, [enabled, storeId]);

  const setAutoAccept = useCallback(
    async (next: boolean) => {
      const previous = state.autoAccept;
      const store = activeStoreId;
      setState({ autoAccept: next, error: null }); // 樂觀更新：掣即刻有反應
      writeCache(next);

      if (!store) {
        // 冇 storeId（未登入 / 離線模式）：淨係落快取
        return;
      }

      try {
        const response = await fetch("/api/online-order-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            autoAccept: next,
            storeId: store,
            // 帶店員 token 等 server 可以代推去 Ledger（docs/92 §4）。
            // token 只係 POST 去自己嘅 server route，由 server 先至帶去 Ledger。
            ledgerAccessToken: readLedgerAccessToken(),
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as { autoAccept?: boolean; ledgerSynced?: boolean };
        if (typeof payload.autoAccept === "boolean") {
          setState({ autoAccept: payload.autoAccept, source: "server", error: null });
          writeCache(payload.autoAccept);
        }
        if (payload.ledgerSynced === false && process.env.NODE_ENV !== "production") {
          console.warn("[online-order-settings] 已儲存，但推去 Ledger 失敗（見 server log）");
        }
      } catch {
        setState({ autoAccept: previous, error: "儲存失敗，請稍後再試。" });
        writeCache(previous);
      }
    },
    [],
  );

  return {
    autoAccept: snapshot.autoAccept,
    loading: snapshot.loading,
    error: snapshot.error,
    source: snapshot.source,
    setAutoAccept,
  };
}

/** 由 localStorage session 讀店員 Ledger token（server 代推去 Ledger 用）。 */
function readLedgerAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    // 經 storage.ts 嘅 session reader，唔好自己拆 localStorage key（scope 係 per-store 嘅）。
    // token 只係 POST 去**自己**嘅 server route，再由 server 先至帶去 Ledger ——
    // browser 由頭到尾都冇直連 Ledger（同 ensure-customer 嘅約定一致）。
    return loadAuthSession()?.ledgerAccessToken ?? null;
  } catch {
    return null;
  }
}
