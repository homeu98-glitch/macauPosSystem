/**
 * 「呢張單屬於邊個時間範圍」——**全站唯一收口點**（2026-09-19）。
 *
 * ## 為咩要有呢個檔案
 *
 * 2026-09-19 實案：報表顯示 10 單 / 營業額 512 / 客單價 51，但實際只有 9 單 / 474 / 52.67。
 * 差額係**同一張單（`001`，MOP 38）被計咗兩次** —— 因為：
 *
 * | 清單 | predicate | 讀嘅欄位 |
 * |---|---|---|
 * | 線上接單 / 店內線下訂單（`/orders`） | `orderMatchesDateFilter` | **`createdAt`**（下單） |
 * | 報表 / 交班 | `orderMatchesReportRange` | **`updatedAt`**（結帳／最後更新） |
 *
 * 該單 `createdAt` = 10:57、`updatedAt` = 11:17。兩個清單各自用唔同欄位篩「今天」，
 * 於是同一筆 38 元兩邊都收 ⇒ 報表多算一張單。
 *
 * ## 口徑（唯一真源）
 *
 * **`orderEventInstant(order)`** —— 一張單「屬於邊個時刻」：
 *
 *   1. `settledAt`（最近一次結帳，**裝置鐘、server 永不覆蓋**；0057，2026-09-24）
 *      —— 唯一唔會被重推／離線補傳／補建改變嘅時間，日歸屬嘅可信真源
 *   2. `reopenedAt`（最近一次返結）——現行口徑，見 `settledAt`（`shift-page.tsx` /
 *      `restaurant-daily-report.tsx` / `pos-app.tsx` 三處一致）
 *   3. `originalSettledAt`（首次結帳，永不改）
 *   4. `updatedAt`（最後更新，兜底）
 *
 * 🔴 點解 `settledAt` 排最前（2026-09-24 「補完更錯」事故）：
 *    雲端 `updated_at` 係 **server 蓋章**（收件時間）—— 任何重推舊單都會把佢推成
 *    重推當刻 ⇒ 舊鏈（reopenedAt → originalSettledAt → updatedAt）喺雲端冇一個
 *    唔會郁嘅錨（`originalSettledAt` 從未上雲）。`settledAt` 由裝置喺結帳嗰刻寫入、
 *    server 只接受 client 值 ⇒ 重推 N 次日歸屬都唔漂。
 *    舊單／舊 client 冇 `settledAt` → 自動落返 2–4，行為同之前**逐位元一樣**。
 *
 * 即係話：**「呢張單計落邊日」＝ 佢最後一次成為「生意」嗰刻**，唔係下單嗰刻。
 * 理由：對帳要對「今日收到幾多錢」，唔係「今日開咗幾多張單」。
 * 一張 23:58 落單、00:02 結帳嘅單，屬於**第二日**嘅營業額。
 *
 * ⚠️ 唔可以改回讀 `createdAt`：落單未收款唔算生意（`draft` / `sent_to_kitchen` 唔入帳），
 * 而「跨午夜結帳」正正係最常出錯嘅邊界。
 *
 * ## 點解獨立成檔（唔放喺 `report-period.ts`）
 *
 * 🔴 `npm test` ＝ `node --test`，**唔認 `@/` 別名、唔行 bundler、唔支援 `.tsx`**。
 * 呢個模組要可以被單元測試直接載入，所以：
 *   1. 檔名 `.ts`（唔係 `.tsx`）；
 *   2. import 一律**相對 + 顯式 `.ts` 副檔名**；
 *   3. **零 `@/` 依賴**。
 *
 * @see docs/113-agent-gotchas.md
 */

/**
 * 訂單身上同「時間」有關嘅欄位（structural typing —— 唔綁死 `PosOrder`，
 * 因為 Ledger 線上單同 POS 單都有呢幾欄但型別唔同）。
 */
export type TimeStampableOrder = {
  /** 最近一次結帳時間（**裝置鐘、server 永不覆蓋**；0057）—— 最高優先。 */
  settledAt?: string | null;
  /** 最近一次返結時間（返結後覆寫）。 */
  reopenedAt?: string | null;
  /** 首次結帳時間；一經寫入**永不改**（審計用，唔可以當「最後結帳」）。 */
  originalSettledAt?: string | null;
  /** 最後更新時間（任何改動都會刷新）—— 兜底。 */
  updatedAt?: string | null;
  /** 下單時間。**只用作最後兜底**（連 `updatedAt` 都冇嘅髒資料）。 */
  createdAt?: string | null;
};

/**
 * 一張單「屬於邊個時刻」—— **全站計數／篩選嘅唯一時間口徑**。
 *
 * 優先序：`settledAt` → `reopenedAt` → `originalSettledAt` → `updatedAt` → `createdAt`。
 *
 * ⚠️ `originalSettledAt` 係「首次結帳」且永不改，所以**唔可以**用嚟顯示「最後結帳時間」；
 * 但用嚟做「分日歸屬」係啱嘅 —— 佢嘅職責只係「呢張單有冇結過帳、幾時第一次結」。
 *
 * @returns epoch ms；完全無法解析 → `0`（呼叫方應視為「唔知時間」）。
 */
export function orderEventInstant(order: TimeStampableOrder | null | undefined): number {
  if (!order) return 0;
  for (const raw of [order.settledAt, order.reopenedAt, order.originalSettledAt, order.updatedAt, order.createdAt]) {
    const ts = parseInstant(raw);
    if (ts > 0) return ts;
  }
  return 0;
}

/**
 * 一張單嘅「事件時間」ISO 字串（同上口徑）。冇 → `""`。
 * 供需要字串（例如排序 key、顯示）嘅地方使用，避免各自解讀。
 */
export function orderEventISO(order: TimeStampableOrder | null | undefined): string {
  if (!order) return "";
  for (const raw of [order.settledAt, order.reopenedAt, order.originalSettledAt, order.updatedAt, order.createdAt]) {
    if (parseInstant(raw) > 0) return raw as string;
  }
  return "";
}

/**
 * 內部：把一個候選欄位解析成 epoch ms；唔可信 → `0`。
 *
 * 🔴 必須自己設閘，唔可以淨靠 `Date.parse` —— 實測佢好寬鬆：
 *   - `Date.parse(12345)` → 唔會 error，會**當字串**解成一個離譜嘅日期
 *   - `Date.parse("0")`  → 同樣當成有效日期（唔係「無值」）
 * 兩者都會令「冇時間嘅單」靜靜地獲得一個假時間，繼而被計入某日營業額。
 */
function parseInstant(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const s = raw.trim();
  if (!s || s === "0") return 0;
  const ts = Date.parse(s);
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}
