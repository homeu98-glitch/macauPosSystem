-- 0019 · 線上訂單「自動接單」設定（按店）· docs/92
--
-- 背景：舊嘅 `online_order_settings` 有三個問題（docs/92 §3.2）：
--   1. 呢個 repo **從來冇 migration 建立過**佢（0011 有齊 pos_* 全套但冇呢張），schema 無版本控制；
--   2. 讀取用 `.order("updated_at", desc).limit(1)` 而唔係按 PK 搵 —— 對一張 per-store 設定表係錯寫法，
--      同 `pos_device_configs` 嗰個「全店最新一條（任何 terminal）」bug 同一個坑（見 docs/52）；
--   3. 冇 `updated_source` 欄 → 做 POS ↔ Ledger 雙向同步嗰陣冇辦法防迴圈
--      （Ledger 推過嚟嘅改動唔可以再推返去）。
-- 所以起過一張，同 `pos_kiosk_settings`（0015）同名風格對齊。
--
-- 舊表 `online_order_settings` **唔 drop**（可能有其他嘢讀緊），只係 `/api/online-order-settings`
-- 之後一律讀寫呢張新表。
--
-- 全部 idempotent，可重複執行。
-- ============================================================================


-- ============================================================================
-- 1) 表
-- ============================================================================
CREATE TABLE IF NOT EXISTS pos_online_order_settings (
  store_id       text PRIMARY KEY,
  auto_accept    boolean     NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- 防同步迴圈（docs/92 §5）：
  --   'pos'    = POS 端（收銀機）改 → 要推去 Ledger
  --   'ledger' = Ledger 推過嚟 → **唔好**再推返去
  updated_source text        NOT NULL DEFAULT 'pos',
  updated_by     text                            -- 審計：店員 id / 'ledger:<user>'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_online_order_settings_source_check'
  ) THEN
    ALTER TABLE pos_online_order_settings
      ADD CONSTRAINT pos_online_order_settings_source_check
      CHECK (updated_source IN ('pos', 'ledger'));
  END IF;
END $$;


-- ============================================================================
-- 2) RLS：跟 0016 加固模式
--    - anon 只留 SELECT（Realtime 會以 anon role 跑 RLS 檢查，唔留就訂閱唔到，
--      見 src/lib/pos/use-pos-realtime.ts）
--    - 寫入一律經 server service_role（/api/online-order-settings）
--    - 呢張表得 store_id + 一個 boolean + 審計欄，**無 PII** → anon SELECT 用 using(true)
--      （同 0016 §3c pos_soldout 嘅處理一致）
-- ============================================================================
ALTER TABLE pos_online_order_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pos_online_order_settings anon read" ON pos_online_order_settings;
CREATE POLICY "pos_online_order_settings anon read"
  ON pos_online_order_settings
  FOR SELECT TO anon
  USING (true);

DROP POLICY IF EXISTS "pos_online_order_settings service only" ON pos_online_order_settings;
CREATE POLICY "pos_online_order_settings service only"
  ON pos_online_order_settings
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.pos_online_order_settings FROM anon, authenticated;
GRANT SELECT ON TABLE public.pos_online_order_settings TO anon;
GRANT ALL    ON TABLE public.pos_online_order_settings TO service_role;


-- ============================================================================
-- 3) Realtime publication
--    瀏覽器端 anon client 訂閱 postgres_changes（filter store_id=eq.<storeId>），
--    Ledger 改完 → 所有收銀機**即時**跟住變，唔使 polling（全專案禁 polling，見 docs/52）。
-- ============================================================================
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
-- 4) 驗收（喺 Supabase SQL Editor 跑）
-- ============================================================================
-- 4.1 表同約束喺度
--   select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--   where table_name = 'pos_online_order_settings' order by ordinal_position;
--   → 5 欄：store_id / auto_accept / updated_at / updated_source / updated_by
--
-- 4.2 RLS 已開
--   select relname, relrowsecurity from pg_class
--   where relname = 'pos_online_order_settings';
--   → relrowsecurity = true
--
-- 4.3 anon 得 SELECT，無 INSERT / UPDATE / DELETE
--   select has_table_privilege('anon', 'pos_online_order_settings', 'SELECT') as sel,
--          has_table_privilege('anon', 'pos_online_order_settings', 'INSERT') as ins,
--          has_table_privilege('anon', 'pos_online_order_settings', 'UPDATE') as upd,
--          has_table_privilege('anon', 'pos_online_order_settings', 'DELETE') as del;
--   → sel = true，其餘全部 false
--
-- 4.4 已入 realtime publication
--   select tablename from pg_publication_tables
--   where pubname = 'supabase_realtime' order by tablename;
--   → 應該見到 pos_online_order_settings（同 pos_orders / pos_print_jobs / pos_soldout 一齊）
--
-- 4.5 用 anon key 打 PostgREST 寫入必須失敗（RLS 擋）
--   curl -X POST "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/pos_online_order_settings" \
--        -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
--        -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
--        -H "Content-Type: application/json" -d '{"store_id":"hack","auto_accept":true}'
--   → 必須失敗（401/403/42501）
-- ============================================================================
