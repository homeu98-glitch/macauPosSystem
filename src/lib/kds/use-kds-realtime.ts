"use client";

import { useEffect, useRef } from "react";

import { getPosSupabaseClient } from "@/lib/pos/supabase-client";
import { mapPosOrderRow, type PosOrderRow } from "@/lib/pos/pos-order-mapper";
import type { PosOrder } from "@/lib/types";

/**
 * 後廚屏專用嘅 Realtime 訂閱（docs/116 §4.5）。
 *
 * ## 為什麼要另寫一個，唔直接改 `usePosRealtime()`
 *
 * 後廚屏要多訂一張表：`pos_kds_item_state`（單品完成狀態）。
 * `usePosRealtime()` 係**收銀台嘅命脈**（docs/113 有幾條記錄都同佢有關），
 * 為咗一個新頁面去改佢風險唔對稱。專案本身亦係「mirror 而唔係 generalize」
 * （`use-ledger-orders-realtime.ts` → `use-pos-realtime.ts` 就係咁做）。
 *
 * ## ⚠️ 呢個 hook **唔會**幫你補資料
 *
 * Realtime 只係「增量通知」。iPad 休眠 / 轉 Wi-Fi / 鎖屏之後，channel 會重新
 * `SUBSCRIBED`，但**唔會補發睡眠期間嘅事件** —— 唔補拉就會永遠少幾單，
 * 直到有人手動 reload。所以 `onResubscribed` 一定要接住，
 * 喺入面重新 `GET /api/pos/kds/board`（見 `use-kds-board.ts`）。
 *
 * ## 🔴 訂錯專案 = 靜默失效
 *
 * 呢個 hook 用 `getPosSupabaseClient()`，佢讀 `NEXT_PUBLIC_POS_SUPABASE_URL`
 * （未設會退回 `NEXT_PUBLIC_SUPABASE_URL`）。若果指咗去 Ledger 專案，
 * 訂一張唔存在嘅表 Supabase **唔會報錯**，channel 照 `SUBSCRIBED` —— 但永遠冇事件。
 * 所以 `use-kds-board.ts` 會額外做一次性 REST 探測（`probePosRealtimeTarget`）。
 */

/** `pos_kds_item_state` 需要嘅欄（Realtime payload 直接俾晒成行）。 */
export interface KdsRealtimeItemStateRow {
  order_id?: unknown;
  item_key?: unknown;
  done_qty?: unknown;
}

type KdsRealtimeHandlers = {
  /** `pos_orders` 有新增 / 更新。 */
  onOrderUpsert?: (order: PosOrder) => void;
  /** `pos_kds_item_state` 有新增 / 更新。 */
  onItemStateUpsert?: (row: KdsRealtimeItemStateRow) => void;
  /** `pos_kds_item_state` 被刪（`recall` 走 `delete` 嘅話）。 */
  onItemStateDelete?: (row: KdsRealtimeItemStateRow) => void;
  onStatusChange?: (status: string) => void;
  /** 重新訂閱成功（debounce 3 秒）→ **一定要喺呢度補拉一次**。 */
  onResubscribed?: () => void;
};

const RECONNECT_DELAY_MS = 3000;
const RESUBSCRIBE_DEBOUNCE_MS = 3000;

export function useKdsRealtime(
  storeId: string | null,
  enabled: boolean,
  handlers: KdsRealtimeHandlers,
): void {
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
        .channel(`pos-kds:${storeId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "pos_orders", filter },
          (payload) => {
            const row = payload.new as PosOrderRow;
            if (row && row.id) handlersRef.current.onOrderUpsert?.(mapPosOrderRow(row));
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "pos_kds_item_state", filter },
          (payload) => {
            if (payload.eventType === "DELETE") {
              handlersRef.current.onItemStateDelete?.(payload.old as KdsRealtimeItemStateRow);
              return;
            }
            handlersRef.current.onItemStateUpsert?.(payload.new as KdsRealtimeItemStateRow);
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
