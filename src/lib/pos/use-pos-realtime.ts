"use client";

import { useEffect, useRef } from "react";

import { getPosSupabaseClient } from "@/lib/pos/supabase-client";
import {
  mapPosOrderRow,
  mapPosPrintJobRow,
  mapPosSoldoutRow,
  PosOrderRow,
  PosPrintJobRow,
  PosSoldoutRow,
} from "@/lib/pos/pos-order-mapper";
import { PosOrder, PrintJob } from "@/lib/types";

type PosRealtimeHandlers = {
  onOrderUpsert: (order: PosOrder) => void;
  onPrintJobUpsert?: (job: PrintJob) => void;
  onSoldoutUpsert?: (row: PosSoldoutRow) => void;
  onStatusChange?: (status: string) => void;
  onResubscribed?: () => void;
};

const RECONNECT_DELAY_MS = 3000;
const RESUBSCRIBE_DEBOUNCE_MS = 3000;

/**
 * 收銀側訂閱 POS 項目嘅 `pos_orders` / `pos_print_jobs` / `pos_soldout` Realtime 渠道。
 * 設計要求：Kiosk 落單後收銀要「即時」見單、出廚房單，禁用任何 polling
 * （與線上訂單渠道一致）。此 hook 係「即時」嘅實現；`/api/pos/state` 嘅週期拉取作為 fallback。
 *
 * 完全 mirror `src/lib/ledger/use-ledger-orders-realtime.ts`，但订阅本項目 `pos_*` 表，
 * 且用 anon client（唔使 session）。過濾條件 `store_id=eq.<storeId>` 保證只收自己店。
 */
export function usePosRealtime(storeId: string | null, enabled: boolean, handlers: PosRealtimeHandlers) {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled || !storeId) return;

    const supabase = getPosSupabaseClient();
    if (!supabase) return;

    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let reconnectTimer: number | null = null;
    let resubscribeTimer: number | null = null;

    function scheduleResubscribedSync() {
      if (resubscribeTimer) window.clearTimeout(resubscribeTimer);
      resubscribeTimer = window.setTimeout(() => {
        if (!cancelled) handlersRef.current.onResubscribed?.();
      }, RESUBSCRIBE_DEBOUNCE_MS);
    }

    async function subscribe() {
      if (cancelled || !supabase) return;
      if (channel) {
        await supabase.removeChannel(channel);
        channel = null;
      }

      const filter = `store_id=eq.${storeId}`;
      channel = supabase
        .channel(`pos-realtime:${storeId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "pos_orders", filter },
          (payload) => {
            const row = payload.new as PosOrderRow;
            if (row && row.id) handlersRef.current.onOrderUpsert(mapPosOrderRow(row));
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "pos_print_jobs", filter },
          (payload) => {
            const row = payload.new as PosPrintJobRow;
            if (row && row.id) handlersRef.current.onPrintJobUpsert?.(mapPosPrintJobRow(row));
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "pos_soldout", filter },
          (payload) => {
            const row = payload.new as PosSoldoutRow;
            if (row && row.menu_item_id) handlersRef.current.onSoldoutUpsert?.(mapPosSoldoutRow(row));
          },
        )
        .subscribe((status) => {
          handlersRef.current.onStatusChange?.(status);
          if (status === "SUBSCRIBED") scheduleResubscribedSync();
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            if (reconnectTimer) window.clearTimeout(reconnectTimer);
            reconnectTimer = window.setTimeout(() => {
              void subscribe();
            }, RECONNECT_DELAY_MS);
          }
        });
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") void subscribe();
    }

    void subscribe();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (resubscribeTimer) window.clearTimeout(resubscribeTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [enabled, storeId]);
}
