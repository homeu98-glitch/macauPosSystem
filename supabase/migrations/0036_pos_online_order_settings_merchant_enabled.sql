-- 0036 · 「開啟接單」（merchant_enabled）POS 鏡像欄 · 開關店
--
-- 背景：Ledger 側「開啟／關閉接單」由店員 JWT 直連 RPC `merchant_set_order_enabled`
-- 寫入 `merchants.merchant_enabled`（Ledger 真源）。但 Ledger **冇 MQTT／webhook 推播**，
-- 一部收銀機關咗店，另一部開住畫面嘅收銀機完全唔知（docs/92 §1.2 同一個「冇渠道知」問題）。
--
-- 做法：POS 每次 RPC 成功之後，將**回傳嘅 config** 鏡像寫入 `pos_online_order_settings`
-- （經 server service_role，見 src/app/api/online-order-settings/route.ts），
-- 靠 0019 已經加好嘅 Realtime publication 廣播 → 其他收銀機即時跟住變。
--
-- ⚠️ 真源仍然係 Ledger：
--   - 呢欄係**鏡像**，唔可以當權威。進頁面／回前景一律以 RPC 回傳為準覆蓋。
--   - Ledger 嗰邊（Ledger Web / 另一部 Android）改動**唔會**即時傳過嚟
--     （要等 POS 下次讀 RPC）—— 呢個係 Ledger 唔推播嘅固有代價。
--
-- 全部 idempotent，可重複執行。
-- ============================================================================


-- ============================================================================
-- 1) 加欄
--    DEFAULT true = 「營業中」。刻意同 auto_accept（DEFAULT false）相反：
--    未寫過 row 嘅新店，Ledger 側 merchant_enabled 預設就係開嘅
--    （平台核可之後即可接單），鏡像用 false 會令收銀機誤顯示「已暫停」。
-- ============================================================================
ALTER TABLE pos_online_order_settings
  ADD COLUMN IF NOT EXISTS merchant_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN pos_online_order_settings.merchant_enabled IS
  '鏡像自 Ledger merchants.merchant_enabled（真源在 Ledger，見 0036 檔頭）。只供跨機 Realtime 顯示，讀寫一律經 /api/online-order-settings。';


-- ============================================================================
-- 2) RLS / GRANT / publication
--    0019 已經設好，加欄唔會影響。呢度只係重申一次，防止有人照抄 0019 之前嘅狀態。
--    （anon 淨係 SELECT，寫入一律 service_role。）
-- ============================================================================
ALTER TABLE pos_online_order_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'pos_online_order_settings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE pos_online_order_settings;
  END IF;
END $$;


-- ============================================================================
-- 3) 驗收（喺 Supabase SQL Editor 跑）
-- ============================================================================
-- 3.1 欄位存在（應該見到 6 欄，最後一欄 merchant_enabled）
--   select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--   where table_name = 'pos_online_order_settings' order by ordinal_position;
--
-- 3.2 未寫過 row 嘅店讀出嚟係 true
--   select store_id, auto_accept, merchant_enabled from pos_online_order_settings;
--
-- 3.3 anon 仍然寫唔到（加欄之後冇意外放權）
--   select has_table_privilege('anon', 'pos_online_order_settings', 'UPDATE') as upd,
--          has_table_privilege('anon', 'pos_online_order_settings', 'INSERT') as ins;
--   → 兩個都要 false
-- ============================================================================
