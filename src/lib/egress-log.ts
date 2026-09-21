/**
 * Egress 審計日誌（2026-09-21）。
 *
 * ## 為咩要有
 *
 * Supabase 嘅 **PostgREST egress** 係按「Supabase → Vercel Function」嗰段 bytes 計費，
 * 但 Supabase Dashboard 只會俾你一個總數／按服務分項，**唔會**話你知邊條 route 食咗幾多。
 * 結果一超額就要靠推測（2026-09-21 就係咁查咗一輪）。
 *
 * 呢個模組令每條重 route 喺 Vercel log 直接印出 response bytes
 * → 之後任何一日超額，`grep '[egress]'` 加總就即刻知邊條路徑係元兇。
 *
 * ## 設計約束
 *
 * · **零 import**（純函式）→ 可以直接用 `node --test` 覆蓋（見 `egress-log.test.ts`）。
 * · **唔用 `Buffer`**：edge runtime 冇；改用 `TextEncoder`（Node / Edge 都有）。
 * · **只 serialize 一次**：caller 應該用回傳嘅 `body` 做 response，唔好再 `JSON.stringify` 多次
 *   （大 payload 例如 5 000 行訂單，重複序列化會白燒 Fluid Active CPU）。
 * · 生產環境**預設開啟**；要靜音可以設 `POS_EGRESS_LOG=0`
 *   （設 1 之外嘅值都當關，方便應急）。
 */

/** `POS_EGRESS_LOG` 環境變數：`"0"` / `"false"` / `"off"` = 靜音。 */
export function isEgressLogEnabled(
  raw: string | undefined = typeof process === "undefined" ? undefined : process.env.POS_EGRESS_LOG,
): boolean {
  if (raw === undefined) return true;
  const value = String(raw).trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "");
}

/** 額外維度（全部會 append 落同一行，方便 grep / 加總）。 */
export type EgressLogExtra = Record<string, string | number | boolean | null | undefined>;

/**
 * 序列化 payload 並記錄 bytes。
 *
 * @returns `.body` ＝ 序列化後嘅 JSON 字串（**caller 必須用它做 response**，保證只 serialize 一次）；
 *          `.bytes` ＝ UTF-8 位元組數。
 */
export function serializeWithEgressLog(
  tag: string,
  payload: unknown,
  extra: EgressLogExtra = {},
): { body: string; bytes: number } {
  // ⚠️ `JSON.stringify(undefined)` 回 `undefined`（唔係字串），直接餵畀 NextResponse 會出錯。
  //    呢度統一兜成 `"null"` —— 維持回傳型別誠實（`.body: string`），而呼叫端一律傳 object。
  const body = JSON.stringify(payload) ?? "null";
  const bytes = new TextEncoder().encode(body).length;
  if (isEgressLogEnabled()) {
    const detail = Object.entries(extra)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    // 唔用 console.log：呢條係「量度」用途，info 級唔會混入錯誤告警。
    console.info(`[egress] ${tag} bytes=${bytes}${detail ? ` ${detail}` : ""}`);
  }
  return { body, bytes };
}
