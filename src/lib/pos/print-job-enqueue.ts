"use client";

/**
 * 打印任務落本機 + 推上雲（PRINT_JOB_CREATED）—— 建單路徑嘅**唯一**共用入口。
 *
 * ── 為咩要獨立一個 module ─────────────────────────────────────────────
 * `print-jobs.ts` 同 `ledger-pos-bridge.ts` 互相 import：
 * `print-jobs.ts` 要向 `ledger-pos-bridge` 攞 `getBridgedPosOrder` /
 * `resolveLedgerPosOrderForReceipt`（見 `findPosOrderForLedger`），所以
 * `ledger-pos-bridge` **唔可以**直接 import `print-jobs.ts`（會循環依賴）。
 * 呢個 module 只依賴 storage / queue-outbox / sync-flush / print-job-merge，
 * 三方都可以安全 import。
 * （同 `@/lib/print-toggles` 當年由 `print-jobs` 抽出嚟係同一個理由。）
 *
 * ── 🔴 為咩一定要入隊（血淚教訓）───────────────────────────────────────
 * 店內實際出紙通道係「雲端 `pos_print_jobs` → 中繼 APK claim 出紙」
 * （見 `print-bridge/relay-transport.ts` 頂部註釋）。而雲端 `pos_print_jobs`
 * 嗰一行**只有** `PRINT_JOB_CREATED` 事件經 `/api/pos/sync` 先會寫。
 *
 * 所以：**淨係 `savePrintJobs()` 寫本機 = 一張紙都唔會出**。
 *   - 本機 flush（`print-bridge/dispatch.ts`）會見到 `status === "pending"`，
 *     行到 relay 分支時 `RelayTransport.send()` 本身係 no-op（只 flush sync
 *     queue），樂觀回 `{ ok: true }` → 本機被標成 `"sent"`；
 *   - 但雲端根本冇呢張單 → 中繼 APK 永遠 claim 唔到 → 零出紙；
 *   - 打印中心顯示綠色「已發送」，底部**冇**「列印失敗」紅標 → 完全誤導人。
 *
 * 2026-09-09 補打帳單印唔出、2026-09-11 線上單（Ledger）接單後唔出廚房單，
 * 都係同一條根因（當時 Ledger bridge 兩處漏配）。
 *
 * @see print-jobs.ts `appendPrintJobsWithSync` 嘅同源註釋
 * @see docs/113-agent-gotchas.md
 */

import {
  loadClearedPrintJobIds,
  loadPrintJobs,
  loadQueue,
  savePrintJobs,
  saveQueue,
} from "@/lib/storage";
import { mergePrintJobs } from "@/lib/pos/print-job-merge";
import { enqueueEvents } from "@/lib/pos/queue-outbox";
import { notifyQueueChanged, withStoreScope } from "@/lib/pos/sync-flush";
import type { PrintJob, QueueEvent } from "@/lib/types";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * 合併（去重 + tombstone 過濾 + 保留本機派發狀態）後寫入本機 localStorage，
 * 並 dispatch `pos-print-jobs-changed` 等打印中心即時刷新。
 *
 * ⚠️ **唔會**推上雲。要出紙請用 {@link appendPrintJobsWithSync}。
 * 只有「刻意本機限定」嘅場景（Kiosk 顧客小票，見 docs/87 §3.1）先用呢個。
 */
export function persistMergedPrintJobs(incoming: PrintJob[]): PrintJob[] {
  if (incoming.length === 0 || typeof window === "undefined") return loadPrintJobs();
  const existing = loadPrintJobs();
  const cleared = loadClearedPrintJobIds();
  const merged = mergePrintJobs(existing, [...incoming, ...existing], cleared);
  savePrintJobs(merged);
  window.dispatchEvent(
    new CustomEvent("pos-print-jobs-changed", { detail: { count: incoming.length } }),
  );
  return merged;
}

/**
 * 將 `PRINT_JOB_CREATED` 推入 sync queue（上雲寫 `pos_print_jobs`），
 * 並即時觸發 flush worker（唔使等 30s interval）。
 *
 * @returns 實際入隊嘅事件數
 */
export function enqueuePrintJobCreatedEvents(jobs: PrintJob[]): number {
  if (jobs.length === 0 || typeof window === "undefined") return 0;
  const timestamp = new Date().toISOString();
  const events = jobs.map<QueueEvent>((job) => ({
    id: uid("evt"),
    type: "PRINT_JOB_CREATED",
    entityId: job.id,
    payload: job,
    status: "pending",
    createdAt: timestamp,
  }));
  saveQueue(enqueueEvents(loadQueue(), withStoreScope(events)));
  notifyQueueChanged();
  return events.length;
}

/**
 * **建單路徑嘅標準做法**：落本機 + 推上雲，兩步都要做齊。
 *
 * 自動出紙（落單、加單、結帳、退菜、返結、線上單接單／取消、補打）一律用呢個。
 * 漏咗後半步 = 靜默唔出紙（見檔頭）。
 *
 * @returns 實際加入隊列嘅張數（0 = 冇嘢要加）
 */
export function appendPrintJobsWithSync(jobs: PrintJob[]): number {
  if (jobs.length === 0 || typeof window === "undefined") return 0;
  persistMergedPrintJobs(jobs);
  enqueuePrintJobCreatedEvents(jobs);
  return jobs.length;
}
