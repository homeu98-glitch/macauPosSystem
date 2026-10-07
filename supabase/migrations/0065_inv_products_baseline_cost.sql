-- 0065_inv_products_baseline_cost.sql
--
-- 目的：支援「庫存 › 品項分析」嘅**上漲金額 / 漲幅**。
--
-- 🔴 為何一定要新欄（唔可以直接用 avg_unit_cost）：
--    `inv_products.avg_unit_cost` 每次 `syncFromReceipts` 都會被覆寫成
--    「體加權平均進價」，舊價**唔會留低喺任何地方**。所以：
--      · 現時可以計「相鄰兩次採購嘅漲幅 %」（buildItemRows 靠 receipt_items 重算）
--      · 但**計唔到**「相對首次進貨價嘅上漲金額」——需要一個穩定不變嘅基準。
--
-- J 2026-10-07 拍板口徑：
--    基準 ＝ **該品項首次進貨紀錄嘅單價**（歷史最早一筆 receipt_items.unit_price）
--    · 一旦寫入就**永不覆寫**（後續批次／更新後嘅價格一律唔用）
--    · 冇首次進貨紀錄 ⇒ baseline 留 NULL，UI 標「首次記錄」並排除喺漲跌統計外
--
-- 注意：本檔**唔做 backfill**。因為 migration 行喺 macau 專案，
-- 而 `receipt_items` 喺 expenseRecorder 專案，SQL 跨唔到。
-- 改由 `syncFromReceipts()` 喺下次同步時自動鎖定
-- （佢本身已經讀晒 expense 專案嘅全部 receipt_items）。

alter table inv_products
  add column if not exists baseline_unit_cost numeric(12,2),
  add column if not exists baseline_at date;

comment on column inv_products.baseline_unit_cost is
  '首次進貨單價（基準價）。由 syncFromReceipts 於「歷史最早一筆收據」鎖定，一經寫入永不覆寫。NULL ＝ 未有基準。';
comment on column inv_products.baseline_at is
  '基準價生效日（該筆首次進貨收據的 receipt_date）。只供顯示，唔參與計算。';

-- 查詢端會按 store_id 拉全表 + 讀 baseline；呢個索引支援「只拉有基準嘅品項」嘅分頁查詢。
create index if not exists inv_products_baseline_idx
  on inv_products (store_id, lower(name))
  where baseline_unit_cost is not null;
