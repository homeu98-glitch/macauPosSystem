"use client";

import { useEffect, useRef } from "react";

import { ensureLedgerSession } from "@/lib/ledger/session";
import { ensureLedgerRealtimeAuth, getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

export type ProductRealtimeChange = {
  record: unknown;
  eventType: "INSERT" | "UPDATE" | "DELETE";
};

type RealtimeHandlers = {
  onChange: (change: ProductRealtimeChange) => void;
  onStatusChange?: (status: string) => void;
};

const RECONNECT_DELAY_MS = 3000;
/** 指數退避上限（2026-09-15）：3s → 6s → 12s → 24s → 30s 封頂。 */
const MAX_RECONNECT_DELAY_MS = 30_000;
const SESSION_RETRY_DELAY_MS = 1500;

/**
 * M7 — 訂閱 Ledger `public.products`（同一 client，filter `merchant_id=eq.<uuid>`）。
 * 收到變更只交返 caller 做本地 patch/upsert（見 menu-import.ts patchMenuFromRealtimeRecord），
 * 唔做全 `list_merchant_order_menu` re-fetch。`wallets` 唔 subscribe（契約禁項）。
 *
 * ## 訂單 hook 有 `onResubscribed`，呢個冇
 *
 * 餐牌嘅重連補拉係由 caller 自己決定（menu-import 有自己嘅節流），所以呢個 hook
 * 收少一個 handler、亦冇 `RESUBSCRIBE_DEBOUNCE_MS`；餐牌 Realtime 只係「即時 patch」，
 * 漏一兩個變更可以由下一次全量／其他觸發補返。
 */
export function useLedgerProductsRealtime(merchantId: string | null, enabled: boolean, handlers: RealtimeHandlers) {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled || !merchantId) return;

    const supabase = getLedgerSupabaseClient();
    if (!supabase) return;

    let cancelled = false;
    let reconnectTimer: number | null = null;
    let sessionRetryTimer: number | null = null;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    /** 連續重連次數（算指數退避）；成功 SUBSCRIBED 歸零。 */
    let reconnectAttempt = 0;
    /** 防重入（2026-09-15 加固）：見 use-pos-realtime.ts 同名註解。 */
    let subscribeInFlight = false;

    async function subscribe() {
      if (cancelled || !supabase) return;
      // 防重入：已有一次 subscribe 喺 in-flight 就唔好再開。
      // ⚠️ 一定要**先**判重入才清 reconnectTimer（見 use-ledger-orders-realtime.ts 同名詳解）：
      //    清咗 timer 之後才 return，就會殺死一個仍然有效嘅重連排程。
      if (subscribeInFlight) return;
      // 🔴 清走未觸發嘅重連 timer（2026-09-27）：斷線重連排咗 3 秒，呢 3 秒內若掉頭
      // 回前景又觸發一次 `subscribe()`，兩個排程會撞埋 ⇒ 白白多建一次 channel、
      // 多打一次增量（餐牌會多拉一次）。手動嚟到就唔需要嗰個 timer 了。
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      subscribeInFlight = true;
      try {
      const accessToken = await ensureLedgerSession();
      if (!accessToken) {
        if (sessionRetryTimer) window.clearTimeout(sessionRetryTimer);
        sessionRetryTimer = window.setTimeout(() => {
          void subscribe();
        }, SESSION_RETRY_DELAY_MS);
        handlersRef.current.onStatusChange?.("WAITING_FOR_SESSION");
        return;
      }

      await ensureLedgerRealtimeAuth(accessToken);
      if (cancelled) return;

      if (channel) {
        // 🔴 先清空變數再 await（2026-09-27）：見 `use-ledger-orders-realtime.ts` 同名詳解
        // ——`removeChannel` 會令舊 channel 收 `CLOSED`，要喺 callback 靠 `channel !== ch` 忽略。
        const stale = channel;
        channel = null;
        await supabase.removeChannel(stale);
        // 🔴 一定要有（同 use-pos-realtime／use-kds-realtime 一致）：
        // `removeChannel` 係 async，期間頁面可能已經 unmount（`cancelled = true`）。
        // 冇呢句就會照樣建一條**冇人清**嘅新 channel —— cleanup 讀 `channel` 係 null，
        // 唔會去 remove ⇒ 訂閱連線洩漏。
        if (cancelled) return;
      }

      const filter = `merchant_id=eq.${merchantId}`;
      const ch = supabase
        .channel(`pos-ledger-products:${merchantId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "products", filter },
          (payload) => {
            const eventType = payload.eventType === "DELETE" ? "DELETE" : payload.eventType === "UPDATE" ? "UPDATE" : "INSERT";
            const record = eventType === "DELETE" ? payload.old : payload.new;
            handlersRef.current.onChange({ record, eventType });
          },
        );
      channel = ch;
      ch.subscribe((status) => {
        /**
         * 🔴🔴 2026-09-27 修正（Ledger 配額事故）：**只處理「現用」channel 嘅狀態**。
         * 自己 `removeChannel` 換走嘅舊 channel 回 `CLOSED` ⇒ 忽略，唔可以當斷線排重連
         * （否則形成「回前景 → 移除 → CLOSED → 3 秒後再移除健康 channel」嘅死循環）。
         */
        if (cancelled || channel !== ch) return;
        handlersRef.current.onStatusChange?.(status);
        if (status === "SUBSCRIBED") {
          // 連上就重置退避。
          reconnectAttempt = 0;
          return;
        }
        // 2026-09-15 加固：加埋 `CLOSED`（以前一入 CLOSED 就永久靜默，餐牌改動收唔到）。
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          if (reconnectTimer) window.clearTimeout(reconnectTimer);
          // 指數退避（3s → 6s → 12s → 24s → 30s 封頂）。
          const delay = Math.min(RECONNECT_DELAY_MS * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
          reconnectAttempt += 1;
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            void subscribe();
          }, delay);
        }
      });
      } finally {
        subscribeInFlight = false;
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void subscribe();
      }
    }

    void subscribe();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (sessionRetryTimer) window.clearTimeout(sessionRetryTimer);
      if (channel) {
        void supabase.removeChannel(channel);
      }
    };
  }, [enabled, merchantId]);
}
