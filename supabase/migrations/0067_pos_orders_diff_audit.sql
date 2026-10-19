-- 0067 · 訂單結帳差額處理審計欄位（線上單到店改價）
--
-- 背景（2026-10-19 到店優惠改價，mockup v3 畫面 ⑤⑥）：
--   線上單搬落嚟之後改價（例：到店 9 折）→ **線上已付 > 新金額** → 應收 0，
--   但客人多付咗錢 → 結帳時一定要處理差額：
--     ① `topup` 充值返回原支付戶口（會員通餘額；Ledger 禁 POS 沖正餘額，
--        故用 `merchant_apply_pos_txn` p_type="topup" 語意補回）；
--     ② `cash`  櫃現金退款；
--     ③ `none`  唔退，店方保留（當其他收入記賬，必填原因）。
--
--   🔴 問題：差額憑證（txn id／方式／遮罩電話／原因）以前**只存 client
--      localStorage**，`pos_orders` 冇對應直欄 ⇒：
--       · 換機 / 清 cache 之後睇唔出「差額去咗邊」（對帳斷鏈）；
--       · 補打收據（`resolveLedgerPosOrderForReceipt` 由 Ledger 重建）走失
--         `diff_note` 註腳；
--       · 另一部機嘅訂單卡片唔會出「差額已處理」徽章。
--
-- 解法（同 0043 返結審計 / 0063 原枱快照一模一樣）：
--   加欄 + 落 `baseRecord`／ORDER_SETTLED patch + 四條讀取路徑 map 返
--   （`pos-order-row` 型別 + 投影清單 + `mapOrderRow`／`pos-order-mapper`
--   realtime／`api/pos/orders` 內聯 mapper）—— 否則 = 寫得入、讀唔出。
--
-- 🔴 為咩 `diff_phone_mask` 只存**遮罩版**（`6393****`）：
--   完整會員電話係個資紅線，從來唔落 `pos_orders`（見
--   `src/lib/ledger/online-customer-cache.ts`）。遮罩版唔可反推完整電話，
--   收據註腳／訂單徽章只需要「客人認得係自己個戶口」。
--
-- ⚠️ 為何唔加 NOT NULL / DEFAULT / index：
--   · 絕大部分單從來冇差額（未改價 / 加菜 / 純本地單）⇒ 必須容許 NULL；
--   · server 永不自己填值，一律等 client 帶（「有值先寫」語意）；
--   · 差額單數量極少，查詢靠既有 `store_id` 索引綽綽有餘。
--
-- ⚠️ additive + idempotent：舊行唔會壞、舊 client 照跑。
--    未跑 migration 時：
--      · 讀取路徑（`POS_ORDER_DB_COLUMNS`）撞 42703 → `state` route 有
--        「42703 → select("*")」自動降級 ⇒ 報表／交班照讀到單；
--      · 寫入路徑（baseRecord / settle patch）有 42703 降級清單拔走呢幾欄
--        ⇒ 主流程（落單／結帳／金額）完全不受影響。
--      ⇒ 未跑時唯一代價：徽章／收據註腳暫時唔顯示（＝現時行為）。
--
-- 🔴 俾商家跑嘅 SQL **唔好用 begin;…commit;**（2026-09-24 教訓：商家會將 commit
--    理解成 git commit ⇒ transaction rollback ⇒ 靜默冇改）。本檔全部語句即時生效。

-- ── pos_orders：結帳差額處理審計 ──
alter table public.pos_orders
  add column if not exists diff_handling text;

alter table public.pos_orders
  add column if not exists diff_amount numeric(12, 2);

alter table public.pos_orders
  add column if not exists diff_txn_id text;

alter table public.pos_orders
  add column if not exists diff_reason text;

alter table public.pos_orders
  add column if not exists diff_phone_mask text;

comment on column public.pos_orders.diff_handling is
  '結帳差額處理方式：topup = 充值返回原支付戶口（會員通餘額）／cash = 櫃現金退款／none = 唔退，店方保留（其他收入）。只有「線上已付 > 結帳總額」且處理過先有值，其餘單 = NULL。';
comment on column public.pos_orders.diff_amount is
  '客人多付差額（正數，兩位小數 ＝ 線上已付 − 結帳總額）。同 diff_handling 一齊有值。';
comment on column public.pos_orders.diff_txn_id is
  '充值返回嘅 Ledger merchant_apply_pos_txn txn id（對帳憑證；會員通後台可查）。只有 diff_handling = topup 先有值，cash / none = NULL。';
comment on column public.pos_orders.diff_reason is
  '店方保留（diff_handling = none）嘅必填原因（收銀人手填）。topup / cash = NULL。';
comment on column public.pos_orders.diff_phone_mask is
  '充值返回戶口嘅遮罩電話（例 6393****，收據註腳／訂單徽章用）。🔴 淨存遮罩版：完整會員電話係個資紅線，從來唔落 pos_orders。只有 diff_handling = topup 先有值。';

-- ── 驗證（手動跑） ──
-- 1) 欄位存在 + 型別
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'pos_orders'
--     and column_name like 'diff_%';
--   → diff_handling  / text                     / YES / NULL
--   → diff_amount    / numeric                   / YES / NULL
--   → diff_txn_id    / text                     / YES / NULL
--   → diff_reason    / text                     / YES / NULL
--   → diff_phone_mask/ text                     / YES / NULL
--
-- 2) 🔴 最關鍵嘅一步：跑完 migration **同**部署新程式碼之後，
--    對一張已改價嘅線上單做一次「結帳 + 差額處理」，再查雲端有冇真係寫到：
--   select local_order_no, status, total, diff_handling, diff_amount, diff_txn_id, diff_phone_mask
--   from pos_orders
--   where diff_handling is not null
--   order by updated_at desc
--   limit 20;
--   → 應該見到處理過差額嘅單帶住方式／金額／憑證。
--
-- 3) 對帳（今日差額總額 = 報表「其他收入」以外要人手認嘅錢）
--   select diff_handling,
--          count(*)          as orders,
--          sum(diff_amount)  as total_diff
--   from pos_orders
--   where diff_handling is not null
--     and updated_at >= current_date
--   group by diff_handling;
