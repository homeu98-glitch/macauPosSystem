-- 0056_pos_orders_platform_fees.sql
--
-- 目的：讓外賣平台單可以帶住**非菜品費用明細**（餐盒費／膠袋費／服務費），
--       收據就可以逐項印出，同平台單一模一樣。
--
-- ── 為什麼需要（由真實單據反推）──────────────────────────────────────
--   「菜品加總」同「營業額」唔會相等，差額來自：
--     菜品原價合計 + 餐盒費 + 膠袋費 + 服務費 − 商家自己出嘅優惠 = 營業額
--   兩個平台都符合：
--     澳覓 172 + 5 + 1 − 21 = 157 ✓
--     mfood 118 + 3 + 1 − 4 = 118 ✓
--   ⇒ 唔逐項列出費用，收據就會出現「原價合計 172 / 總金額 157」而中間冇解釋。
--
-- ── 🔴 零影響原則 ────────────────────────────────────────────────────
--   · ADD COLUMN nullable、**冇 DEFAULT** → 現有寫入路徑（/api/pos/sync）唔使改，
--     INSERT 亦唔會因為新欄位而失敗（唔傳就係 NULL）
--   · 店內單永遠 NULL → `mapPosOrderRow` 映射成 `undefined`
--     → 收據嗰邊完全跳過，輸出逐個 byte 一樣
--   · 純加法，可重複執行

alter table pos_orders add column if not exists platform_fees jsonb;

comment on column pos_orders.platform_fees is
  '外賣平台嘅非菜品費用明細：[{"label":"餐盒費","amount":5}, …]。只包含計入營業額嘅費用（配送費唔計入）。店內單為 NULL。見 migration 0056。';
