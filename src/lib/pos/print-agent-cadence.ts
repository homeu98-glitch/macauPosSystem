/**
 * 《打印中繼 claim 節奏》—— 純決策（2026-09-22 第三次覆核）。
 *
 * ── 為咩要（用戶 2026-09-22 17:39 追問）─────────────────────────────────
 *
 * 「店基本上都係關店狀態，唔應該 call 任何嘢」—— claim 之前係**固定間隔**，
 * 關店之後照樣每 30 秒打一次（實測 152 次 / 192 分鐘 ＝ 每 76 秒，24/7）。
 *
 * ── 🔴 但**唔可以 block**（一定要記住）─────────────────────────────────
 *
 * · 出紙通道**只有**「雲端 `pos_print_jobs` → 中繼 APK claim」一條。
 *   block 咗 ⇒ **關店後嘅結尾結帳收據、補打帳單永遠印唔出**。
 * · 實測成本：claim ＝ 1 個 `PATCH pos_print_agents` ＋ 1 個 RPC（0 行）
 *   ≈ 300 B（未壓縮）⇒ 0.79 次/分鐘 ≈ **0.17 MB/日**，
 *   相對舊分頁迴圈（1.4 GB/日）係 **0.01%**。
 *   ⇒ **唔會**靠呢個解決超額；呢個係「衞生／原則」修正，唔係流量修正。
 *
 * ── 設計：三檔 ＋ 空閒退避 ────────────────────────────────────────────
 *
 * | 情境 | 間隔 | 理由 |
 * |---|---|---|
 * | 今次取滿 `limit`（仲有積壓） | **5 秒** | 連續消化，唔使等一輪 |
 * | 今次有取得 job | **15 秒** | 高峰期貼近即時 |
 * | 連續冇 job（第 1 次） | 30 秒 | 基礎兜底節奏 |
 * | 連續冇 job（第 2 次） | 60 秒 | |
 * | 連續冇 job（第 3 次） | 120 秒 | |
 * | 連續冇 job（第 4 次或以上） | **180 秒（上限）** | 關店／深夜 |
 *
 * 🔴 **上限 180 秒唔可以再放寬**：POS 網頁 `print-center.tsx` 寫死
 * 「`last_seen_at` ≥5 分鐘 → 疑似離線」，超過就會出假警報。
 * （要再放寬就必須同時改嗰個 UI 閾值。）
 *
 * 🔴 **空閒退避唔會令「關店後要印嘅單」遲到**：APK 有 Realtime 訂閱
 * （`pos_print_jobs` INSERT → 即刻 claim）—— 退避只係放慢**兜底輪詢**。
 * 最壞情況（Realtime 又唔通）＝ 3 分鐘，而嗰個情境本來就冇人企喺櫃檯等。
 *
 * ── 零 import ─────────────────────────────────────────────────────────
 * `node --test` 唔行 bundler、唔認 `@/` 別名 ⇒ 呢個檔（同測試）一律零 import。
 */

/** 積壓（今次取滿 limit）→ 幾乎即刻再嚟。 */
export const CLAIM_BACKLOG_MS = 5_000;
/** 今次有取得 job → 高峰期節奏。 */
export const CLAIM_ACTIVE_MS = 15_000;
/** 空閒退避階梯（連續冇 job 嘅第 1、2、3、4+ 次）。 */
export const CLAIM_IDLE_LADDER_MS = [30_000, 60_000, 120_000, 180_000] as const;
/** 任何情況都唔可以超過（＝ POS 網頁「疑似離線」閾值 5 分鐘嘅安全線）。 */
export const CLAIM_MAX_MS = 180_000;
/** 任何情況都唔可以低過（＝ APK `takeIf { it in 5_000..180_000 }` 嘅下限）。 */
export const CLAIM_MIN_MS = 5_000;

/**
 * 更新「連續冇 job」計數。
 *
 * @param current 目前連續次數
 * @param claimed 今次 claim 取到幾多張 job
 */
export function nextEmptyStreak(current: number, claimed: number): number {
  const streak = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;
  if (Number.isFinite(claimed) && claimed > 0) return 0; // 有 job ⇒ 即刻回復正常節奏
  // 防溢位（長開幾日都唔會爆）
  return Math.min(streak + 1, 9999);
}

/**
 * 決定下一次 claim 嘅建議間隔。
 *
 * ⚠️ 回傳值**保證**落喺 `[CLAIM_MIN_MS, CLAIM_MAX_MS]` —— 呢個係同 APK 嘅硬性合約
 * （APK 側：`optInt("nextPollMs", 0).takeIf { it in 5_000..180_000 }`，超出範圍會
 * **靜默 fallback 30 秒**，即係「以為調快咗其實冇」）。
 */
export function nextClaimPollMs(input: {
  claimed: number;
  limit: number;
  emptyStreak?: number;
}): number {
  const claimed = Number.isFinite(input.claimed) && input.claimed > 0 ? Math.floor(input.claimed) : 0;
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? Math.floor(input.limit) : 5;
  const streak = Number.isFinite(input.emptyStreak) && (input.emptyStreak ?? 0) > 0
    ? Math.floor(input.emptyStreak as number)
    : 0;

  let ms: number;
  if (claimed >= limit) ms = CLAIM_BACKLOG_MS;
  else if (claimed > 0) ms = CLAIM_ACTIVE_MS;
  else {
    const idx = Math.min(Math.max(streak, 1), CLAIM_IDLE_LADDER_MS.length) - 1;
    ms = CLAIM_IDLE_LADDER_MS[idx];
  }
  return Math.min(Math.max(ms, CLAIM_MIN_MS), CLAIM_MAX_MS);
}

/** 診斷標籤（寫入回應，方便下次由 log 分辨「點解係呢個間隔」）。 */
export function claimCadenceLabel(claimed: number, limit: number): "backlog" | "active" | "idle" {
  const c = Number.isFinite(claimed) && claimed > 0 ? Math.floor(claimed) : 0;
  const l = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
  if (c >= l) return "backlog";
  if (c > 0) return "active";
  return "idle";
}
