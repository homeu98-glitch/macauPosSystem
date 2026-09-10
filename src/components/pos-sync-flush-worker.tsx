"use client";

import { useEffect } from "react";

import { installPosSyncQueueAutoFlush, uninstallPosSyncQueueAutoFlush } from "@/lib/pos/sync-flush";
import {
  installSyncReconcileDaemon,
  uninstallSyncReconcileDaemon,
} from "@/lib/pos/sync-reconcile-daemon";

/**
 * 後台 sync 背景 worker（餐飲：rejected / confirmed / settled 訂單上 DB）。
 *
 * 經 root layout 全域掛載，唔使個別 page 再 trigger。安裝兩個 worker：
 *
 * 1. **flush worker**（`installPosSyncQueueAutoFlush`）
 *    - mount 時一次性裝 listener + 立即 flush stale pending
 *    - 30s 兜底 interval + online / visibilitychange / pos-sync-queue-changed
 *
 * 2. **對賬守護**（`installSyncReconcileDaemon`，docs/112 L2，2026-09-10）
 *    - 唔止「推出去」，仲會**驗證真係上咗雲**：揀出本地已終態但雲端未確認嘅單，
 *      pull 雲端現況比對，分叉就自動補推完整快照、連續失敗就示警。
 *    - 冇待確認訂單時完全唔打網絡（只讀 localStorage）→ 穩定狀態零成本。
 *    - 呢個就係「唔需要教商家手動同步」嘅那一環。
 *
 * 對齊 print-flush-worker 嘅 pattern（統一背景 worker）。
 */
export function PosSyncFlushWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    installPosSyncQueueAutoFlush();
    installSyncReconcileDaemon();
    return () => {
      uninstallSyncReconcileDaemon();
      uninstallPosSyncQueueAutoFlush();
    };
  }, []);

  return null;
}