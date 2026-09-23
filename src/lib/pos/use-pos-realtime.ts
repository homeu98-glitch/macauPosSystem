"use client";

import { useEffect, useRef } from "react";

import { ensureRealtimeAuth, onRealtimeAuthChanged } from "@/lib/pos/realtime-auth";
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
  onOrderUpsert?: (order: PosOrder) => void;
  onPrintJobUpsert?: (job: PrintJob) => void;
  onSoldoutUpsert?: (row: PosSoldoutRow) => void;
  onStatusChange?: (status: string) => void;
  onResubscribed?: () => void;
};

const RECONNECT_DELAY_MS = 3000;
/** 指數退避上限（2026-09-15）：3s → 6s → 12s → 24s → 30s 封頂。 */
const MAX_RECONNECT_DELAY_MS = 30_000;
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
    /** 連續重連次數，用嚟算指數退避；成功 SUBSCRIBED 就歸零。 */
    let reconnectAttempt = 0;
    /**
     * 防重入（2026-09-15 加固）。
     *
     * `subscribe()` 內 `await supabase.removeChannel(channel)` 係 async，
     * 而 `visibilitychange`（每次回到前景）同重連 timer **可以同時觸發**。
     * 以前兩條並發鏈會各自建一條同名 channel，但只有後建嗰條會被寫入 `channel`
     * → 先建嗰條**永遠唔會被 remove**，channel 逐次累積洩漏。
     */
    let subscribeInFlight = false;

    function scheduleResubscribedSync() {
      if (resubscribeTimer) window.clearTimeout(resubscribeTimer);
      resubscribeTimer = window.setTimeout(() => {
        if (!cancelled) handlersRef.current.onResubscribed?.();
      }, RESUBSCRIBE_DEBOUNCE_MS);
    }

    async function subscribe() {
      if (cancelled || !supabase) return;
        // 防重入：已有一次 subscribe 喺 in-flight 就唔好再開（見 subscribeInFlight 註解）。
        if (subscribeInFlight) return;
        subscribeInFlight = true;
        try {
        /**
         * 🆕 per-store token（2026-09-23，第 2 階段）：喺建立 channel **之前**把
         * Realtime 連線嘅身份升級做「帶 `app_metadata.store_id` 嘅 JWT」。
         *
         * 🔴 一定要喺建立 channel 之前（Supabase 官方要求），而且一定要**等**：
         *    Realtime 嘅身份係**每條 WebSocket 連線**（唔係每個 channel），
         *    同一 client 上六條 channel 全部共用；遲咗 `setAuth` 就全部用錯身份。
         *
         * 🔴 失敗／未綁店 → 回 `null` ⇒ **保持 anon**（＝今日行為）。
         *    所以呢一步永遠唔會令事情變差；最壞情況只係「未升級」。
         *    四個 realtime hook 都係同一寫法，而 `ensureRealtimeAuth` 內部
         *    single-flight，所以佢哋會共用同一個 promise、唔會重複登入。
         */
        await ensureRealtimeAuth(storeId);
        if (cancelled || !supabase) return;
      if (channel) {
        // 先清空變數再 await —— 避免 await 期間其他人讀到一條「即將被移除」嘅 channel。
        const stale = channel;
        channel = null;
        await supabase.removeChannel(stale);
      }
      if (cancelled || !supabase) return;
      const filter = `store_id=eq.${storeId}`;
      channel = supabase
        .channel(`pos-realtime:${storeId}`)
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
          if (status === "SUBSCRIBED") {
            // 連上就重置退避，下次斷線由 3 秒重新開始。
            reconnectAttempt = 0;
            scheduleResubscribedSync();
            return;
          }
          // 2026-09-15 加固：**加埋 `CLOSED`**。
          //
          // 以前只判 CHANNEL_ERROR / TIMED_OUT → channel 一旦入 `CLOSED`
          // （socket 被伺服器關閉 / join 失敗）就**永遠唔會再訂閱**：
          // 畫面照樣顯示已連線，但**永遠唔會再有事件** —— 同 docs/113
          // 「Realtime 訂錯 Supabase 專案 = 靜默失效」同一型，只有 reload 或切前景才復原。
          // （KDS 屏有 60 秒看門狗兜底，收銀台 `/` 冇有。）
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            if (reconnectTimer) window.clearTimeout(reconnectTimer);
            // 指數退避（3s → 6s → 12s → 24s → 30s 封頂）。
            // 舊行為係固定 3 秒無限重試：斷網時燒電、燒流量，而且冇任何 backoff 禮讓。
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
      if (document.visibilityState === "visible") void subscribe();
    }

    void subscribe();
    document.addEventListener("visibilitychange", onVisibilityChange);
    /**
     * 🆕 per-store token（2026-09-23）：Realtime 憑證改變（綁店完成／Supabase 自動續期）
     * ⇒ **重新 subscribe**。
     *
     * 為何一定要做：JWT 有有效期（預設 1 小時）。若果連線一直用住舊 token，
     * 舊 token 一過期，Realtime 嘅 RLS 就開始**全拒**，而 channel 照樣 `SUBSCRIBED`、
     * **零 error** ⇒ 就係 docs/113「靜默失效」：收銀台永遠收唔到新單、
     * 出紙失去即時喚醒（退化成最長 180 秒嘅兜底輪詢）。
     * 頻率有上界（每次成功綁店 + 每小時續期一次），成本可接受。
     */
    const offAuthChanged = onRealtimeAuthChanged(() => {
      if (!cancelled) void subscribe();
    });

    return () => {
      cancelled = true;
      offAuthChanged();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (resubscribeTimer) window.clearTimeout(resubscribeTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [enabled, storeId]);
}
