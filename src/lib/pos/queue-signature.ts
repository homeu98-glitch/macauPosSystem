/**
 * 同步隊列「內容簽名」（2026-09-21 全量拉取自激迴圈修復）。
 *
 * ## 為咩需要呢支函式
 *
 * `pos-app.tsx` 有一個 effect：
 *
 * ```ts
 * useEffect(() => {
 *   if (offlineMode) return;
 *   if (queue.some((e) => e.status === "pending")) return;
 *   void loadRuntimeState();          // 一次 ＝ 6 條 PostgREST 查詢、424 KB
 * }, [offlineMode, runtimeRefreshTick, queue]);   // 🔴 queue 係 dependency
 * ```
 *
 * `queue` 係 **React state array**，effect 認嘅係 **array 身分（identity）**，
 * 唔係內容。所以只要有任何一段碼做 `setQueue(loadQueue())`（重新由 localStorage
 * 讀一份，就算內容一個字都冇變），effect 就會重跑 → 再一次全量拉取。
 *
 * 實測（2026-09-21，營業中）：`/api/pos/state` 每 **4.49 秒** 一次、每次 **424,181 B**
 * ⇒ 5.5 分鐘 **62 次 ≈ 25 MB**。上游只要有一個秒級事件源（`pos-print-jobs-changed`
 * 每 2.5 秒、`sync-acks` 每 15 秒、`POS_SYNC_QUEUE_CHANGED_EVENT` 每 30 秒），
 * 就會形成**穩定嘅 4~5 秒循環**。
 *
 * ## 修法
 *
 * 用同一個簽名去問「內容到底有冇變」：冇變就**唔換 array 身分** ⇒ effect 唔重跑。
 * `saveQueue()`（寫 localStorage）照樣每次都做，磁碟一致性完全保留。
 *
 * ## 設計約束
 *
 * - **零 import**：`node --test` 唔認 `@/` 別名、唔行 bundler（見 MEMORY §6），
 *   所以呢個模組唔可以依賴任何外部型別，只用結構化 duck typing。
 * - 排序後再 join ⇒ **同內容、唔同次序 ⇒ 同一個簽名**（隊列次序唔應該觸發全量拉取）。
 * - 🔴 每一筆用 `JSON.stringify([id, status])` 編碼，再用 `"\n"` 分隔。
 *   **唔可以**用 `id:status` 直接串（舊版內聯寫法）—— 因為 `id` 同 `status` 都係自由字串，
 *   `{id:"a:b", status:"c"}` 同 `{id:"a", status:"b:c"}` 會撞成同一個簽名
 *   ⇒ 真嘅隊列變更被判成「冇變」⇒ UI 靜默唔更新。
 *   `JSON.stringify` 會把字串內嘅 `"` 同 `\` 轉義，而 `\n` 唔可能未轉義咁出現
 *   ⇒ 串接結果係**單射**（唔會撞簽名）。
 *   現實中 `id` 係 `evt-<uuid>`、`status` 係枚舉，本來撞唔到；但呢度唔想靠「本來」。
 */

/** 簽名只關心呢兩個欄位。 */
export interface QueueSignatureRow {
  id: string;
  status: string;
}

/**
 * 計算隊列內容簽名。
 *
 * @returns 空隊列 → `""`；否則係排序後嘅 `["<id>","<status>"]` 串（`\n` 分隔）。
 */
export function queueSignature(
  events: readonly QueueSignatureRow[] | null | undefined,
): string {
  if (!events || events.length === 0) return "";
  return events
    .map((event) => JSON.stringify([event.id, event.status]))
    .sort()
    .join("\n");
}
