-- 0063 · 訂單返結「原枱」快照 `reopen_original_table_id` / `reopen_original_table_name`
--
-- 背景（2026-10-05 跨機返結失聯實案 · 表嫂美食 訂單02）：
--   `reopenPosOrder()`（`src/lib/pos-orders.ts`）反結帳時會做兩件事：
--     ① 訂單狀態 → `reopened`，寫返結審計欄；
--     ② 建立一張 **temp 枱**（`temp-reopen-<orderId>`，名「返結 A01」），
--        將 `tableId` / `tableName` 搬去呢張 temp 枱，並把**原枱**記低喺
--        `reopenOriginalTableId` / `reopenOriginalTableName`（供重結後還原）。
--
--   🔴 問題：temp 枱**刻意唔上雲**（`device-settings.tsx` 推上 server 前會
--      `stripReopenTempTables()` 剝走 —— 寫入 `pos_bootstrap_config.tables`
--      會令假枱**永久升級做真實枱**）。於是：
--        · `table_id` 上雲嘅值 = `temp-reopen-xxx`（另一部機根本冇呢張枱）；
--        · `reopenOriginalTableId` **只存在下單機嘅 localStorage**，
--          由 `0043` 起 `pos_orders` 從來冇對應欄位（0043 只有 reopen_count/at/reason）。
--      ⇒ **另一部機重結時 `reopenOriginalTableId` 係 undefined**
--        ⇒ `pos-app.tsx` 嘅 `isReopenRestore = Boolean(reopenOriginalTableId)` 為 false
--        ⇒ `confirmPayment` **唔會還原原枱**
--        ⇒ 張單永久卡喺 `temp-reopen-xxx`，該機冇呢張枱
--        ⇒ **枱面總覽永久空枱、單懸空**（商家喺另一部機完全冇重結後嘅原枱）。
--
-- 解法（補齊「跨機」最後一塊）：
--   把「原枱」當**返結審計事實**上雲，同 `reopen_count` / `reopened_at` 同級：
--     ① 本欄 nullable text，只記返結嗰一刻嘅原枱 id / 名（**一次性快照**）；
--     ② sync route 採「**有值才寫**」（同 0038 member_* / 0057 settled_at 同款語義）
--        —— 舊 client 唔識呢兩欄 ⇒ 唔寫 ⇒ 唔會抹走另一部機已寫嘅值；
--     ③ 四條讀取路徑（`pos-order-row` 型別 + 投影清單 + `mapOrderRow`／
--        `pos-order-mapper` realtime／`api/pos/orders` 內聯 mapper）都要 map 返，
--        否則 = 寫得入、讀唔出（同 0034 / 0043 / 0056 / 0060 一模一樣嘅漏抄型 bug）。
--
-- ⚠️ 為何唔加 NOT NULL / DEFAULT / index：
--    · 大部分單從未返結 ⇒ 冇原枱可言，必須容許 NULL；
--    · server 唔會用自己嘅值填充（否則會錯寫成 temp 枱 id），一律等 client 帶；
--    · 查詢靠既有 `pos_orders` 索引（`store_id`）綽綽有餘，reopen 單數量極少。
--
-- ⚠️ additive + idempotent：舊行唔會壞、舊 client 照跑、寫入路徑不變。
--    未跑之前：
--      · client 投影（`POS_ORDER_DB_COLUMNS`）會撞 42703 → `state` route 有
--        「42703 → `select("*")`」自動降級（`pos-orders-range.ts` 三級降級），
--        所以**唔會**令報表／交班讀唔到單；
--      · 寫入路徑採「獨立第二次 update」，新欄失敗**唔會**令整張單上唔到雲
--        （唔可以因為新欄拖冧落單主流程）。
--      ⇒ 未跑 migration 時嘅唯一代價：**跨機重結唔會還原原枱**（＝現時行為），
--        單嘅金額／items／狀態一切正常。
--
-- 🔴 俾商家跑嘅 SQL **唔好用 begin;…commit;**（2026-09-24 教訓：商家會將 commit
--    理解成 git commit ⇒ transaction rollback ⇒ 靜默冇改）。本檔全部語句即時生效。

-- ── pos_orders：返結「原枱」快照 ──
alter table public.pos_orders
  add column if not exists reopen_original_table_id text;

alter table public.pos_orders
  add column if not exists reopen_original_table_name text;

comment on column public.pos_orders.reopen_original_table_id is
  '返結當刻嘅原枱 id（一次性快照）。返結時 client 由 temp 枱還原記低，經 ORDER_UPDATED 上雲；重結（confirmPayment）時據此還原原枱，寫完即清 NULL。舊 client / 未返結單 = NULL（重結唔會還原原枱，行為同現時一致）。';

comment on column public.pos_orders.reopen_original_table_name is
  '返結當刻嘅原枱名（一次性快照，只為 UI 顯示「返結 A01」呢類字樣；重結後清 NULL）。未返結單 = NULL。';
