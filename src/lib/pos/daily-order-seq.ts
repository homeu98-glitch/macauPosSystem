/**
 * 每日單號序號 —— **零依賴純函式**（刻意唔 import 任何嘢）。
 *
 * ## 點解要獨立成一個檔
 *
 * 單號重複（2026-09-10 事故：`訂單03` 出現兩條 row，一 cancelled 一 settled）係
 * 一個**沉默**嘅 bug —— 唔會 throw、唔會報錯，只會令兩張唔同嘅單共用同一個號，
 * 之後對數、退款、查單全部亂。呢類 bug 一定要有回歸測試鎖住。
 *
 * 而 `storage.ts` 內部用 `@/` path alias（`node --test` 嘅內建 type-stripping 唔識），
 * 所以單測唔可以直接 import `storage.ts`。呢個檔完全冇 import（連 `macauDateKey`
 * 都由 caller 注入），因此可以直接被 `node --test` 加載。
 *
 * `storage.ts` 嘅 `maxUsedDailyOrderSeq` / `nextLocalDailyOrderNo` 就係呢度嘅薄包裝。
 */

/** 推導序號只需要呢三個欄位 —— 唔收窄成 `PosOrder` 係為咗單測唔使砌齊整張單。 */
export type DailySeqOrderLike = {
  localOrderNo?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

/**
 * 由現有訂單推導「同一日、同一單號抬頭已用過嘅最大序號」。
 *
 * 單號有**兩個獨立計數器**：server 嘅 `next_daily_sequence`（按 store/kind/Macau 日
 * 原子遞增）同本機 fallback `localDailySeq`。兩者互不知情 —— 只要連線取得序號失敗
 * （或本機 localStorage 被 iOS ITP 清過、計數器歸零），fallback 就會由細號重新數起，
 * 撞返早已由 server 派出去嘅號。
 *
 * 呢個閘用「眼前睇得到嘅訂單」做下限，令 fallback 永遠唔會重用已經出現過嘅號。
 *
 * ⚠️ 只計「同一日」嘅單：單號按日歸零，尋日嘅 `訂單12` 唔應該推高今日嘅下限。
 * 冇時間戳嘅單（`ts` 解析失敗）**會被計入**（寧可跳號，唔好撞號）。
 *
 * @param orders     任何來源嘅訂單（本機 state + localStorage 一齊餵最穩）
 * @param prefix     單號抬頭（訂單 / 自取 / 外賣 / 堂食）
 * @param todayKey   目標日期 key（Macau `YYYY-MM-DD`）
 * @param dateKeyOf  由 Date 取日期 key 嘅函式（由 caller 注入 `macauDateKey`，
 *                   令呢個檔保持零依賴）
 */
export function maxDailySeqFromOrders(
  orders: readonly DailySeqOrderLike[],
  prefix: string,
  todayKey: string,
  dateKeyOf: (date: Date) => string,
): number {
  // 抬頭係 Literal 拼接（訂單/自取/…），唔含 regex 特殊字元；仍然 escape 一次免得日後中招。
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)$`);
  let max = 0;
  for (const order of orders) {
    const no = order.localOrderNo;
    if (!no) continue;
    const m = re.exec(no);
    if (!m) continue;
    const ts = Date.parse(order.createdAt ?? order.updatedAt ?? "");
    // 解析唔到（NaN）→ 保守計入，避免因為一個壞時間戳而撞號。
    if (Number.isFinite(ts) && dateKeyOf(new Date(ts)) !== todayKey) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * 算出下一個序號。取「本機計數器」同「眼前已用最大號」兩者較大者 + 1。
 *
 * 只取本機計數器會撞號（計數器可能被清 / 落後）；只取眼前訂單又會被已刪單欺騙。
 * 兩者取 max 係最保守嘅做法。
 */
export function computeNextDailySeq(localCounter: number, alreadyUsedMax: number): number {
  const a = Number.isFinite(localCounter) ? Math.max(0, Math.floor(localCounter)) : 0;
  const b = Number.isFinite(alreadyUsedMax) ? Math.max(0, Math.floor(alreadyUsedMax)) : 0;
  return Math.max(a, b) + 1;
}

/** 兩位數補零（`訂單08`）。超過 99 就自然變三位（`訂單100`），唔會截斷。 */
export function padDailySeq(value: number): string {
  return String(value).padStart(2, "0");
}
