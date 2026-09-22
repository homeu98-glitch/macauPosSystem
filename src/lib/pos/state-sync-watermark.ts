/**
 * 《增量同步水位》——「今次拉 state 要唔要傳 `since=`」嘅**純決策**（2026-09-22 P1）。
 *
 * ── 為咩要（取證）────────────────────────────────────────────────────────
 *
 * 2026-09-22 實測（Vercel `[egress]` 行，7.4 分鐘窗口）：
 *
 * | 來源 | 每次 | 頻率 | 結果 |
 * |---|---|---|---|
 * | 舊 bundle 全量拉取 | **903 KB** | 每 4.6 秒（92 秒 20 次） | **690 MB/小時** |
 * | 新 bundle 全量拉取 | 412 KB | 開頁 / 重連 | 單店 ~1.9 GB/日 |
 * | **同一支 API 嘅增量拉取（本模組）** | **~30 KB** | 開頁 / 重連 | **~15–20 MB/日** |
 *
 * 全量拉取每次把「200 張訂單 ＋ 200 個打印任務 ＋ 6 張表」全部拉落嚟，
 * 但 POS 本身**已經有齊**呢啲資料（localStorage 就係本機真源）——
 * 開頁真正需要嘅只係「**上次同步之後有咩變咗**」。
 *
 * ── 三條安全規則（缺一都會靜默漏資料）───────────────────────────────────
 *
 * 1. **冇水位 / 水位唔合法 → 全量**（第一次用、清過 cache、換機）。
 * 2. **水位太舊（> 6 小時）→ 全量** —— 防止「隔夜之後 `updated_at > 水位`
 *    仍然係一大堆單」而撞穿 `limit=200`（撞穿就會靜默漏單）。
 * 3. **本機冇資料 → 全量** —— 空機冇任何基底，增量 merge 落去會係空盤。
 *
 * ⚠️ 另外每次 `since` 都會**回帶一個安全邊際**（`safetyMs`，預設 10 秒）：
 * 覆蓋「client／server 時鐘偏差」同「請求進行中嘅新寫入」。多拉幾行**無害**
 * （merge 係按 id LWW），漏一行就可能係漏一張單。
 *
 * ── 本模組刻意零 import ──────────────────────────────────────────────────
 * 專案 `npm test` ＝ `node --test`：**唔行 bundler、唔認 `@/` 別名**。
 * 測試用相對路徑＋顯式 `.ts`（見 `state-sync-watermark.test.ts`）。
 */

/** 每次 `since` 回帶嘅安全邊際（ms）。 */
export const STATE_SYNC_SAFETY_MS = 10_000;

/** 水位最長有效期（ms）：超過就寧願全量，避免撞穿 `limit` 而漏單。 */
export const STATE_SYNC_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type SinceReason =
  /** 有可用水位 → 傳 `since`，只拉差量。 */
  | "incremental"
  /** 呼叫端明確要求全量（手動「更新」／換機／修復）。 */
  | "force-full"
  /** 從未成功拉過（新機 / 清過 cache）。 */
  | "no-watermark"
  /** 水位字串解析唔到（被人改壞 / 舊格式）。 */
  | "bad-watermark"
  /** 水位太舊（> `maxAgeMs`）。 */
  | "stale-watermark"
  /** 本機完全冇 orders / printJobs（空盤），增量無意義。 */
  | "no-local-data";

export interface SinceDecision {
  /** `null` ＝ 唔傳 `since`（走全量，語義同未加呢個功能之前一樣）。 */
  since: string | null;
  reason: SinceReason;
  /**
   * 今次係咪全量拉取。
   *
   * 🔴 **只有全量先可以跑「孤兒單對賬」**（`pos-app.tsx` 嘅 `computeOrphanLocalOrders()`）——
   * 佢嘅判準係「雲端 `payload.orders` 冇呢張單 + 本機冇 pending 事件 + 單齡 ≥10 分鐘
   * ⇒ 隔離」。增量回傳嘅只係**變更過嘅子集**，攞去做「雲端有冇呢張單」嘅判準
   * ＝ 會把成店未變更過嘅單全部當孤兒隔離（災難級誤判）。
   */
  fullPull: boolean;
}

function parseIso(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * 決定今次拉取要唔要傳 `since`。
 *
 * @param input.lastSyncedAt 本機記低嘅「上次成功同步水位」（ISO 字串）。
 * @param input.hasLocalData  本機有冇 orders / printJobs（空盤一定要全量）。
 * @param input.nowMs         現在時間（`Date.now()`）。
 * @param input.forceFull     呼叫端明確要求全量（手動更新 / 修復）。
 */
export function resolveSince(input: {
  lastSyncedAt?: string | null;
  hasLocalData: boolean;
  nowMs: number;
  forceFull?: boolean;
  maxAgeMs?: number;
  safetyMs?: number;
}): SinceDecision {
  if (input.forceFull) return { since: null, reason: "force-full", fullPull: true };
  if (!input.hasLocalData) return { since: null, reason: "no-local-data", fullPull: true };

  const raw = input.lastSyncedAt ?? null;
  if (raw === null || raw === "") return { since: null, reason: "no-watermark", fullPull: true };

  const parsed = parseIso(raw);
  if (parsed === null) return { since: null, reason: "bad-watermark", fullPull: true };

  const maxAgeMs = Number.isFinite(input.maxAgeMs) ? Number(input.maxAgeMs) : STATE_SYNC_MAX_AGE_MS;
  const ageMs = input.nowMs - parsed;
  // 未來時間（時鐘回撥 / 水位被人改大）→ 當唔可用，寧願全量。
  if (ageMs < 0 || ageMs > maxAgeMs) {
    return { since: null, reason: "stale-watermark", fullPull: true };
  }

  const safetyMs = Number.isFinite(input.safetyMs) ? Number(input.safetyMs) : STATE_SYNC_SAFETY_MS;
  return {
    since: new Date(parsed - Math.max(0, safetyMs)).toISOString(),
    reason: "incremental",
    fullPull: false,
  };
}

/**
 * 拉取成功之後要記低嘅**新水位**。
 *
 * 用「請求開始嘅時間」而唔用「回應到達嘅時間」：請求期間 server 可能有新寫入，
 * 用回應時間會漏咗嗰批。配合 `resolveSince()` 每次回帶 `safetyMs`，
 * 有效重疊 ＝ 請求耗時 ＋ 安全邊際，足夠覆蓋。
 */
export function watermarkAfterPull(requestStartedAtMs: number, nowMs = requestStartedAtMs): string {
  const t = Number.isFinite(requestStartedAtMs) ? requestStartedAtMs : nowMs;
  return new Date(t).toISOString();
}

/**
 * 增量結果被 `limit` 截斷 → **唔可以信呢個水位**（有單未拉到）。
 *
 * 呼叫端見到 `true` 要即刻清水位（或標記 `forceFull`），令下一次走全量；
 * 同時今次收到嘅資料照 merge（subset merge 係安全嘅）。
 */
export function isIncrementalTruncated(rowCount: number, limit: number): boolean {
  if (!Number.isFinite(rowCount) || !Number.isFinite(limit)) return false;
  if (limit <= 0) return false;
  return rowCount >= limit;
}
