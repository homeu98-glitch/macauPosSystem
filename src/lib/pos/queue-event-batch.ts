/**
 * `pos_queue_events` **批次寫入**嘅純邏輯（2026-09-21 egress 優化）。
 *
 * ## 背景
 *
 * 舊版 `/api/pos/sync` 係「逐個事件 upsert」⇒ N 個事件 ＝ N 個 PostgREST POST。
 * 實測（Supabase log 2026-09-21）：單一表 `pos_queue_events` 26 分鐘內 **150 次 POST**，
 * 係全專案請求數第一位 —— 而 client 其實只發咗**一個** `/api/pos/sync` 請求。
 * 改成「收集成一批再一次過 upsert」⇒ 常見情況由 N 次變 1 次。
 *
 * ## 為咩要抽一個零 import 模組
 *
 * 批次寫入有兩個**靜默**失效模式，一定要有回歸保護（見 `queue-event-batch.test.ts`）：
 *
 * ① **同一批內重複 id** → Postgres 回 `21000`
 *    （`ON CONFLICT DO UPDATE command cannot affect row a second time`）
 *    ⇒ **整批一齊失敗**，所有審計行都冇寫入（唔會 throw、只係 `warning`）。
 *    所以寫入前一定要按 id 去重。
 *
 * ② **分批大小**：`payload` 係完整訂單快照（≈1.7 KB／行），一次過塞 200 行會到 ~340 KB。
 *    切片可以令每個請求 body 保持細，對 PostgREST 嘅 body 上限留餘量。
 */

/** 任何有 `id` 嘅 row（`pos_queue_events` row 嘅最小契約）。 */
export interface IdentifiedQueueRow {
  id: string;
}

/**
 * 按 `id` 去重（**後者勝**）。
 *
 * 為何「後者勝」：舊版逐個 upsert 時，同一 id 出現兩次就係「寫兩次、第二次覆蓋」——
 * 呢度必須保持同一語義，否則會靜默改變最終寫入嘅內容。
 *
 * 冇 id / id 為空 / 非物件嘅 row 一律丟棄（`pos_queue_events.id` 係主鍵，
 * 冇 id 根本寫唔入；舊版會令成個 upsert 失敗）。
 */
export function uniqueRowsById<T extends IdentifiedQueueRow>(rows: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") continue;
    byId.set(id, row);
  }
  return [...byId.values()];
}

/**
 * 切成每批最多 `size` 行。
 *
 * @param size ≤ 0 / NaN / 非整數 → 當 1（保證唔會出現無限迴圈或空批次）
 */
export function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  const per = Number.isFinite(size) && Math.floor(size) > 0 ? Math.floor(size) : 1;
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += per) {
    out.push(rows.slice(i, i + per));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 寫入（client 由外部注入 ⇒ 可以用假 client 做行為測試）
// ─────────────────────────────────────────────────────────────

export interface QueueUpsertError {
  message?: string | null;
}

/** 只需要 `upsert(rows, { onConflict })` 呢一個能力（唔想綁死 supabase-js 嘅巨大型別）。 */
export interface QueueEventsUpsertBuilder<T> {
  upsert(rows: T[], options: { onConflict: string }): PromiseLike<{ error: QueueUpsertError | null }>;
}

export interface QueueEventsUpsertClient<T> {
  from(table: string): QueueEventsUpsertBuilder<T>;
}

export interface FlushQueueEventRowsResult {
  /** 去重之後實際打算寫幾多行。 */
  requested: number;
  /** 成功寫入幾多行（失敗批次之前嘅都算）。 */
  written: number;
  /** 發咗幾個 PostgREST 請求（**呢個就係優化指標：N → batches**）。 */
  batches: number;
  error: string | null;
}

/**
 * 去重 → 分批 → 逐批 upsert。
 *
 * 🔴 呢個函式就係「N 個事件 ＝ N 個 POST」嘅修正點：**同一次 flush 只會發
 * `ceil(unique/size)` 個請求**（日常幾個事件＝**1 個**）。
 *
 * client 刻意用參數注入（而唔係喺 module 內 import supabase）：
 * 咁樣就可以用假 client 直接斷言「25 行只發 1 個 upsert」—— 唔使連 DB。
 *
 * @param onError 每個失敗批次叫一次（caller 負責 log + push `warnings`）。
 *                失敗後**即刻停**（同一種錯誤重試其餘批次冇意義），
 *                但**唔會 throw** —— 審計表寫入失敗唔可以令成批業務事件回 500。
 */
export async function flushQueueEventRows<T extends IdentifiedQueueRow>(params: {
  client: QueueEventsUpsertClient<T>;
  rows: readonly T[];
  chunkSize: number;
  onError?: (info: { message: string; batchSize: number }) => void;
}): Promise<FlushQueueEventRowsResult> {
  const unique = uniqueRowsById(params.rows);
  if (unique.length === 0) {
    return { requested: 0, written: 0, batches: 0, error: null };
  }

  let written = 0;
  let batches = 0;
  for (const chunk of chunkRows(unique, params.chunkSize)) {
    batches += 1;
    const { error } = await params.client
      .from("pos_queue_events")
      .upsert(chunk, { onConflict: "id" });
    if (error) {
      const message = String(error.message ?? "unknown error");
      params.onError?.({ message, batchSize: chunk.length });
      return { requested: unique.length, written, batches, error: message };
    }
    written += chunk.length;
  }
  return { requested: unique.length, written, batches, error: null };
}
