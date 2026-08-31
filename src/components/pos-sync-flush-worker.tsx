"use client";

import { useEffect } from "react";

import { installPosSyncQueueAutoFlush, uninstallPosSyncQueueAutoFlush } from "@/lib/pos/sync-flush";

/**
 * 後台 sync queue flush worker（餐飲：rejected / confirmed / settled 訂單上 DB）。
 *
 * 經 root layout 全域掛載，唔使個別 page 再 trigger：
 *   - mount 時 installPosSyncQueueAutoFlush 一次性裝 listener + 立即 flush stale pending
 *   - 30s 兜底 interval
 *   - online / visibilitychange / pos-sync-queue-changed 都會 trigger
 *
 * 對齊 print-flush-worker 嘅 pattern（統一背景 worker）。
 */
export function PosSyncFlushWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    installPosSyncQueueAutoFlush();
    return () => {
      uninstallPosSyncQueueAutoFlush();
    };
  }, []);

  return null;
}