"use client";

import { useEffect, useRef } from "react";

import { LedgerOrderRow, mapLedgerOrderRow } from "@/lib/ledger/order-mapper";
import { ensureLedgerRealtimeAuth, getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";
import { getLedgerAccessToken } from "@/lib/ledger/session";

type RealtimeHandlers = {
  onInsert: (row: ReturnType<typeof mapLedgerOrderRow>) => void;
  onUpdate: (row: ReturnType<typeof mapLedgerOrderRow>) => void;
  onResubscribed: () => void;
  onStatusChange?: (status: string) => void;
};

const RESUBSCRIBE_DEBOUNCE_MS = 3000;
const RECONNECT_DELAY_MS = 3000;

export function useLedgerOrdersRealtime(merchantId: string | null, enabled: boolean, handlers: RealtimeHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled || !merchantId) return;

    const client = getLedgerSupabaseClient();
    if (!client) return;

    let cancelled = false;
    let reconnectTimer: number | null = null;
    let resubscribeTimer: number | null = null;
    let channel: ReturnType<NonNullable<typeof client>["channel"]> | null = null;

    function scheduleResubscribedSync() {
      if (resubscribeTimer) window.clearTimeout(resubscribeTimer);
      resubscribeTimer = window.setTimeout(() => {
        if (!cancelled) handlersRef.current.onResubscribed();
      }, RESUBSCRIBE_DEBOUNCE_MS);
    }

    async function subscribe() {
      if (cancelled) return;

      const accessToken = getLedgerAccessToken();
      if (!accessToken) return;

      await ensureLedgerRealtimeAuth(accessToken);
      if (cancelled) return;

      if (channel) {
        await client.removeChannel(channel);
        channel = null;
      }

      const filter = `merchant_id=eq.${merchantId}`;
      channel = client
        .channel(`pos-ledger-orders:${merchantId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "orders", filter },
          (payload) => {
            const row = payload.new as LedgerOrderRow;
            handlersRef.current.onInsert(mapLedgerOrderRow(row));
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "orders", filter },
          (payload) => {
            const row = payload.new as LedgerOrderRow;
            handlersRef.current.onUpdate(mapLedgerOrderRow(row));
          },
        )
        .subscribe((status) => {
          handlersRef.current.onStatusChange?.(status);
          if (status === "SUBSCRIBED") {
            scheduleResubscribedSync();
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            if (reconnectTimer) window.clearTimeout(reconnectTimer);
            reconnectTimer = window.setTimeout(() => {
              void subscribe();
            }, RECONNECT_DELAY_MS);
          }
        });
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
      if (resubscribeTimer) window.clearTimeout(resubscribeTimer);
      if (channel) {
        void client.removeChannel(channel);
      }
    };
  }, [enabled, merchantId]);
}
