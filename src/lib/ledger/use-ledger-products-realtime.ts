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

const RESUBSCRIBE_DEBOUNCE_MS = 3000;
const RECONNECT_DELAY_MS = 3000;
/** 指數退避上限（2026-09-15）：3s → 6s → 12s → 24s → 30s 封頂。 */
const MAX_RECONNECT_DELAY_MS = 30_000;
const SESSION_RETRY_DELAY_MS = 1500;

/**
 * M7 — 訂閱 Ledger `public.products`（同一 client，filter `merchant_id=eq.<uuid>`）。
 * 收到變更只交返 caller 做本地 patch/upsert（見 menu-import.ts patchMenuFromRealtimeRecord），
 * 唔做全 `list_merchant_order_menu` re-fetch。`wallets` 唔 subscribe（契約禁項）。
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
      if (subscribeInFlight) return;
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
        await supabase.removeChannel(channel);
        channel = null;
      }

      const filter = `merchant_id=eq.${merchantId}`;
      channel = supabase
        .channel(`pos-ledger-products:${merchantId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "products", filter },
          (payload) => {
            const eventType = payload.eventType === "DELETE" ? "DELETE" : payload.eventType === "UPDATE" ? "UPDATE" : "INSERT";
            const record = eventType === "DELETE" ? payload.old : payload.new;
            handlersRef.current.onChange({ record, eventType });
          },
        )
        .subscribe((status) => {
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
