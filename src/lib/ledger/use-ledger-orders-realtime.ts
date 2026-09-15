"use client";

import { useEffect, useRef } from "react";

import { LedgerOrderRow, mapLedgerOrderRow } from "@/lib/ledger/order-mapper";
import { ensureLedgerSession } from "@/lib/ledger/session";
import { ensureLedgerRealtimeAuth, getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

type RealtimeHandlers = {
  onInsert: (row: ReturnType<typeof mapLedgerOrderRow>) => void;
  onUpdate: (row: ReturnType<typeof mapLedgerOrderRow>) => void;
  onResubscribed: () => void;
  onStatusChange?: (status: string) => void;
};

const RESUBSCRIBE_DEBOUNCE_MS = 3000;
const RECONNECT_DELAY_MS = 3000;
/** 指數退避上限（2026-09-15）：3s → 6s → 12s → 24s → 30s 封頂。 */
const MAX_RECONNECT_DELAY_MS = 30_000;
const SESSION_RETRY_DELAY_MS = 1500;

let didReportOrderRowKeys = false;

/**
 * 🔍 臨時診斷：第一次收到 Realtime 推送就 log 一次 `orders` 表列嘅**欄位名**。
 *
 * **為咩要 log**：Realtime 推嘅係 Ledger `public.orders` 嘅**表列**（見契約 §6.2）。
 * 若嗰張表本身有 `items`（jsonb）欄，就代表**唔使打多一次 RPC**都有齊明細＋規格，
 * 連舊單都一樣拎得到 —— 呢個係比 `get_order_detail` 更好嘅來源。相反若冇，
 * 就確認規格一定只可以經 RPC 拎。
 *
 * ⚠️ 只出**欄位名**，唔出值（表列含 `customer_phone` 等 PII）。
 * 每次 session 只報一次；確認完可以整段刪走。
 */
function reportOrderRowKeysOnce(row: unknown): void {
  if (didReportOrderRowKeys) return;
  if (!row || typeof row !== "object" || Array.isArray(row)) return;
  didReportOrderRowKeys = true;
  const keys = Object.keys(row as Record<string, unknown>);
  console.info(
    "[ledger→pos] Realtime orders 表列欄位：" +
      `${keys.join(", ")}${keys.includes("items") ? "　← 有 items！" : ""}`,
  );
}

export function useLedgerOrdersRealtime(merchantId: string | null, enabled: boolean, handlers: RealtimeHandlers) {
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
    let resubscribeTimer: number | null = null;
    let sessionRetryTimer: number | null = null;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    /** 連續重連次數（算指數退避）；成功 SUBSCRIBED 歸零。 */
    let reconnectAttempt = 0;
    /** 防重入（2026-09-15 加固）：見 use-pos-realtime.ts 同名註解。 */
    let subscribeInFlight = false;

    function scheduleResubscribedSync() {
      if (resubscribeTimer) window.clearTimeout(resubscribeTimer);
      resubscribeTimer = window.setTimeout(() => {
        if (!cancelled) handlersRef.current.onResubscribed();
      }, RESUBSCRIBE_DEBOUNCE_MS);
    }

    async function subscribe() {
      if (cancelled || !supabase) return;
      // 防重入：已有一次 subscribe 喺 in-flight 就唔好再開（見 subscribeInFlight 註解）。
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
        .channel(`pos-ledger-orders:${merchantId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "orders", filter },
          (payload) => {
            const row = payload.new as LedgerOrderRow;
            reportOrderRowKeysOnce(row);
            handlersRef.current.onInsert(mapLedgerOrderRow(row));
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "orders", filter },
          (payload) => {
            const row = payload.new as LedgerOrderRow;
            reportOrderRowKeysOnce(row);
            handlersRef.current.onUpdate(mapLedgerOrderRow(row));
          },
        )
        .subscribe((status) => {
          handlersRef.current.onStatusChange?.(status);
          if (status === "SUBSCRIBED") {
            // 連上就重置退避。
            reconnectAttempt = 0;
            scheduleResubscribedSync();
            return;
          }
          // 2026-09-15 加固：加埋 `CLOSED`（以前一入 CLOSED 就永久靜默收唔到新單）。
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
      if (resubscribeTimer) window.clearTimeout(resubscribeTimer);
      if (sessionRetryTimer) window.clearTimeout(sessionRetryTimer);
      if (channel) {
        void supabase.removeChannel(channel);
      }
    };
  }, [enabled, merchantId]);
}
