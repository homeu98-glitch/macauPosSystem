-- ============================================================
-- Apply + Verify: pos_online_order_settings (mirrors migration 0019)
-- ------------------------------------------------------------
-- 點用：
--   1. 開 POS 項目嘅 Supabase → SQL Editor
--   2. 成段貼落去，撳 "Run"
--   3. 落咗之後如果個 API 仲 500（"schema cache"），喺最底
--      「5) 必要時 reload schema cache」跑一次
-- 全部 idempotent，可以重複跑，唔會炸。
-- ============================================================


-- ============================================================
-- 1) 表
-- ============================================================
CREATE TABLE IF NOT EXISTS pos_online_order_settings (
  store_id       text PRIMARY KEY,
  auto_accept    boolean     NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- 防同步迴圈（docs/92 §5）：'pos' = POS 改要推去 Ledger；'ledger' = 唔好推返去
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


-- ============================================================
-- 2) RLS（跟 0016 加固模式：anon 得 SELECT；寫入經 service_role）
-- ============================================================
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


-- ============================================================
-- 3) Realtime publication（瀏覽器 anon 訂閱 postgres_changes 用）
-- ============================================================
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


-- ============================================================
-- 4) 驗收（apply 完跑呢段）
-- ============================================================

-- 4.1 表真係喺度？
select to_regclass('public.pos_online_order_settings') as table_oid;
--   ✅ expect：一個真 oid（唔係 NULL）

-- 4.2 5 欄都在？
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_name = 'pos_online_order_settings' order by ordinal_position;
--   ✅ expect：store_id / auto_accept / updated_at / updated_source / updated_by

-- 4.3 RLS 開咗？
select relname, relrowsecurity from pg_class
where relname = 'pos_online_order_settings';
--   ✅ expect：relrowsecurity = true

-- 4.4 anon 得 SELECT，冇 INSERT / UPDATE / DELETE？
select has_table_privilege('anon', 'pos_online_order_settings', 'SELECT') as sel,
       has_table_privilege('anon', 'pos_online_order_settings', 'INSERT') as ins,
       has_table_privilege('anon', 'pos_online_order_settings', 'UPDATE') as upd,
       has_table_privilege('anon', 'pos_online_order_settings', 'DELETE') as del;
--   ✅ expect：sel = t，ins/upd/del = f

-- 4.5 入咗 realtime publication？
select tablename from pg_publication_tables
where pubname = 'supabase_realtime' and tablename = 'pos_online_order_settings';
--   ✅ expect：一行

-- 4.6 最後實測：未設定過嘅 store 應返 ok:true（用 curl / 瀏覽器，唔係 SQL）
--   curl -s "https://macau-pos-system.vercel.app/api/online-order-settings?storeId=<你個merchant UUID>"
--   ✅ expect：{"ok":true,"autoAccept":null,"updatedAt":null,"updatedSource":null}


-- ============================================================
-- 5) 必要時 reload schema cache
--    （如果 4.6 仲係 500「Could not find the table ... in the schema cache」，
--     代表 PostgREST 仲未 refresh。跑一次呢句；唔使就唔使跑。）
-- ============================================================
-- select pg_notify('pgrst', 'reload schema');
