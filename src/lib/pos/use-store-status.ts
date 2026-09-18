"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  DEFAULT_STORE_OPEN,
  fetchStoreStatus,
  saveStoreStatus,
  type StoreStatusSource,
} from "@/lib/pos/store-status";
import { posDeviceAuthHeadersFresh } from "@/lib/pos/pos-sync-auth";
import { getPosRealtimeConfig, getPosSupabaseClient } from "@/lib/pos/supabase-client";

/**
 * 「店內營業」開關 —— 收銀端狀態層（真源 = POS DB `pos_store_status`，migration 0039）。
 *
 * ── 點解係 module-level singleton ───────────────────────────────────────
 * 設置頁 header 嘅 pill（同日後任何 call site）要**同一份**值，而且只開
 * **一條** Realtime channel。各自 `useState` 會令「header 顯示營業中、
 * 另一個位顯示已暫停」呢類自相矛盾出現（同 `useMerchantOrderConfig` 同一理由）。
 *
 * ── 誠實回報「未讀到」（`null`）─────────────────────────────────────────
 * `isOpen === null` = 未讀到（未登入 / 讀取失敗 / 表未建立）。
 * UI **一定**要顯示「未接通」並停用，唔可以當 false（＝已暫停）——
 * 兩個方向都會講大話：當「營業中」會令收銀以為停咗業其實冇；
 * 當「已暫停」會令收銀以為停咗業而走去撳多一次。
 *
 * ── 離線 / 失敗 fail-open ───────────────────────────────────────────────
 * 讀取用 `fetchStoreStatus()`，佢失敗時回 `fromServer:false` + 營業中，
 * **唔會** throw。呢度亦唔 rollback 成 `false`（同「查唔到唔好當全部售罄」一致）。
 * 真正嘅硬閘喺 `/api/pos/sync`，客人端讀唔到唔等於落得到單。
 *
 * ── 禁 polling ─────────────────────────────────────────────────────────
 * 只有三個觸發點：mount 一次、Realtime 事件、`visibilitychange` 返前景補一次。
 * 冇 `setInterval`（全專案禁 polling，見 docs/52）。
 *
 * ── 跨機「即時」係有前提嘅 ──────────────────────────────────────────────
 * `getPosSupabaseClient()` 未設 `NEXT_PUBLIC_POS_SUPABASE_URL` / `_ANON_KEY` 時會
 * **退回 Ledger 專案**，而 `pos_store_status` 唔喺嗰度 → channel 照樣 SUBSCRIBED
 * 但永遠收唔到事件（Supabase 唔會報錯，係典型靜默失效）。
 * 所以先靠零網絡成本嘅 `getPosRealtimeConfig()?.source !== "pos"` 把關，
 * 唔通就唔訂，並出 `crossTerminalSync: "on-enter"` 講實話。
 */

export type StoreStatusState = {
  /** `null` = 未讀到（唔可以當 false）。 */
  isOpen: boolean | null;
  updatedAt: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** `false` = 冇登入記錄 / 唔可以寫（UI 收埋開關）。 */
  available: boolean;
  crossTerminalSync: "instant" | "on-enter";
  source: StoreStatusSource | null;
};

const INITIAL: StoreStatusState = {
  isOpen: null,
  updatedAt: null,
  loading: true,
  saving: false,
  error: null,
  available: true,
  crossTerminalSync: "on-enter",
  source: null,
};

let state: StoreStatusState = INITIAL;
const listeners = new Set<() => void>();

let activeStoreId: string | null = null;
let refCount = 0;
let channel: ReturnType<
  NonNullable<ReturnType<typeof getPosSupabaseClient>>["channel"]
> | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<StoreStatusState>) {
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

/** 讀一次 server（唯一權威）。 */
async function refresh(storeId: string) {
  const result = await fetchStoreStatus(storeId);
  setState({
    // ⚠️ 讀唔到（fromServer:false）**唔可以**蓋走已知值：維持「未讀到」或舊值，
    //    否則一次網絡抖動會令 pill 由「已暫停」跳去「營業中」。
    isOpen: result.fromServer ? result.isOpen : state.isOpen,
    updatedAt: result.updatedAt ?? state.updatedAt,
    loading: false,
    error: null,
    source: "server",
  });
}

/** 訂閱 Realtime：其他收銀機 toggle 完即時跟住變（唔 polling）。 */
function subscribeRealtime(storeId: string) {
  const supabase = getPosSupabaseClient();
  if (!supabase) {
    setState({ crossTerminalSync: "on-enter" });
    return;
  }

  // 🔴 先確認連線目標係 POS 專案（退回 Ledger 專案時表根本唔喺嗰邊 → 靜默失效）
  const target = getPosRealtimeConfig();
  if (!target || target.source !== "pos") {
    setState({ crossTerminalSync: "on-enter" });
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[store-status] 跨機即時同步未生效：POS Realtime 退回 Ledger 專案（source=" +
          `${target?.source ?? "none"}, host=${target?.url ?? "?"}）` +
          " → 需要設 NEXT_PUBLIC_POS_SUPABASE_URL / _ANON_KEY 並重新部署。",
      );
    }
    return;
  }

  channel = supabase
    .channel(`pos-store-status:${storeId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "pos_store_status",
        filter: `store_id=eq.${storeId}`,
      },
      (payload) => {
        const row = payload.new as { store_id?: string; is_open?: boolean; updated_at?: string } | null;
        if (!row || typeof row.is_open !== "boolean") return;
        setState({
          isOpen: row.is_open,
          updatedAt: typeof row.updated_at === "string" ? row.updated_at : state.updatedAt,
          loading: false,
          source: "realtime",
        });
      },
    )
    .subscribe();

  setState({ crossTerminalSync: "instant" });
}

function unsubscribeRealtime() {
  if (!channel) return;
  void channel.unsubscribe();
  channel = null;
}

/**
 * 開 / 關店內營業 —— **模組層實作**（hook 內嘅 `setStoreOpen` 直接轉呼叫呢個）。
 *
 * ── 點解要抽成模組層函式（2026-09-18）──────────────────────────────────
 * 「結數交班時一齊關店」呢個流程（`shift-page.tsx` 嘅 `closeShift()`）係一個
 * **普通 async function**，唔係 component render 期 —— 佢**唔可以**呼叫 hook
 * （違反 Hooks 規則）。但佢又一定要寫 `pos_store_status`。
 *
 * 兩條路都唔靚：① 喺 `ShiftPage` 掛 `useStoreStatus()` 再將 setter 塞入 ref →
 * 令交班頁白白多開一條 Realtime channel，而且係 stale closure 溫床；
 * ② 喺 `shift-page.tsx` 自己寫一份 fetch POST → 繞過 `available` 把關，
 * 亦係「兩處各自維護」嘅經典死角。
 *
 * 所以將邏輯擺喺**唯一真源嘅模組層**：hook 同非 React 呼叫端（交班）
 * 行同一段碼，唔會有第二份。
 *
 * ⚠️ 仍然**只改 `pos_store_status` 一欄**。「關店 → 連動暫停線上接單」嘅次序
 *    由 call site 決定（`use-store-open-toggle.ts` 側欄掣，或交班 `closeShift()`）。
 *
 * @returns `true` = 已寫入 DB（UI 可以用嚟決定要唔要出提示）。
 */
export async function applyStoreOpen(next: boolean): Promise<boolean> {
  const store = activeStoreId;
  const previous = state.isOpen;

  if (!store) {
    setState({ error: "尚未登入，無法切換營業狀態。" });
    return false;
  }

  // 樂觀更新：掣即刻有反應，失敗先 rollback（同 self-order-auto-accept 一致）
  setState({ isOpen: next, saving: true, error: null });

  try {
    // ⚠️ POST 要 POS 終端憑證（同 kiosk-settings）。先續期再取 header，
    //    否則過夜之後一撳就 401（GET 開放，所以「讀得到但存唔到」）。
    const headers = await posDeviceAuthHeadersFresh();
    const result = await saveStoreStatus(store, next, headers);
    setState({
      isOpen: result.isOpen,
      updatedAt: result.updatedAt ?? state.updatedAt,
      saving: false,
      error: null,
      source: "server",
    });
    return true;
  } catch (e) {
    setState({
      isOpen: previous,
      saving: false,
      error: e instanceof Error ? e.message : "儲存營業狀態失敗",
    });
    return false;
  }
}

/**
 * 店內營業狀態（讀 + 寫）。
 *
 * @param storeId 商家 id（`loadAuthSession()?.merchantId`，同 `pos_store_status.store_id` 同一套）
 * @param enabled 關掉就唔拉資料、唔訂閱
 */
export function useStoreStatus(storeId: string | null, enabled = true) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!enabled || !storeId) {
      // 唔會拉資料 → 但唔可以永遠顯示「讀取中…」；
      // `isOpen` 保持 `null`（＝未接通）：真係未讀到，唔可以假裝營業中或者已暫停。
      if (state.loading) setState({ loading: false });
      return;
    }

    refCount += 1;
    activeStoreId = storeId;
    setState({ loading: true, available: true });

    void refresh(storeId);
    if (refCount === 1) subscribeRealtime(storeId);

    // 後備：由背景切返前景補拉一次（Ledger / 其他機改完冇推播時最多一秒內收斂）
    function onVisibility() {
      if (document.visibilityState === "visible" && activeStoreId) {
        void refresh(activeStoreId);
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

  /**
   * 開 / 關店內營業。
   *
   * 實作喺 **模組層 `applyStoreOpen()`**（非 React 呼叫端，例如交班 `closeShift()`，
   * 亦可以 import 同一個函式）—— 詳見該函式嘅註釋。
   *
   * ⚠️ **只改 `pos_store_status` 一欄**。同「線上接單」嘅連動（關店時順手
   * 暫停線上接單）由 **call site**（`use-store-open-toggle.ts` / `app-sidebar.tsx`）負責 ——
   * 呢個 hook 唔應該認識 Ledger，否則將來換連動方向要改兩處。
   */
  const setStoreOpen = useCallback(async (next: boolean): Promise<boolean> => applyStoreOpen(next), []);

  /** 手動重新讀（設定頁「重新整理」掣 / 被拒後自我修正用）。 */
  const refreshNow = useCallback(async () => {
    const store = activeStoreId;
    if (!store) return;
    setState({ loading: true, error: null });
    await refresh(store);
  }, []);

  return {
    ...snapshot,
    /** 未讀到時嘅建議顯示值（fail-open，同 server 硬閘唔矛盾）。 */
    isOpenOrDefault: snapshot.isOpen ?? DEFAULT_STORE_OPEN,
    setStoreOpen,
    refreshNow,
  };
}
