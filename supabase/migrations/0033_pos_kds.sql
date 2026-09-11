-- 0033 · 後廚屏 / 出餐台屏（KDS）單品完成狀態 · docs/116
--
-- 背景：現時只有「整張單」嘅狀態（pos_orders.fulfillment_status），
-- 冇「一碟一碟」嘅完成狀態。後廚屏要逐項撳「✓」，所以一定要有單品級狀態。
--
-- ⚠️ 為什麼一定要開**獨立表**，而唔係塞入 pos_orders.items（JSONB）：
--   JSONB 逐行更新要**整行覆寫**。收銀台加單會覆寫整張 order，
--   就會冚走後廚屏啱啱標記嘅完成狀態；反過來後廚屏寫一次亦會冚走收銀台嘅改動。
--   開獨立表 = 兩個寫入者寫**唔同嘅行**，天然冇衝突（docs/116 §5.2 第三行）。
--
-- ⚠️ 為什麼用 done_qty（整數）而唔係 done（boolean）（docs/116 §3.2）：
--   叉燒飯 x1 標記完成 → 客人加單變 x3。若用 boolean，完成狀態仍然係 true，
--   新加嘅 2 碟**永遠唔會喺屏上重新亮起 → 靜默漏單**。
--   用 done_qty = 1 < 3 → 自動變返「未完成，仲欠 2」。
--
-- 呢張表**唔係第二個訂單真源**：唔存菜名、唔存單價、唔存 order 快照，
-- 只係「貼喺訂單旁邊嘅便條」。讀屏時 join 雲端 pos_orders 拎菜名。
--
-- 全部 idempotent，可重複執行。
-- ============================================================================


-- ============================================================================
-- 1) 表
-- ============================================================================
CREATE TABLE IF NOT EXISTS pos_kds_item_state (
  store_id   text        NOT NULL,
  order_id   text        NOT NULL,
  -- ⚠️ 必須同 orderItemKey()（src/lib/pos/order-item-diff.ts）完全同口徑：
  --    `${menuItemId}|${groupId:optionId 排序後以 | 連接}|${price}|${note ?? ""}`
  --    唔一致 = 屏上撳完對唔返訂單嘅行 = 靜默失效。
  item_key   text        NOT NULL,
  -- 工位來自 OrderItem.printerGroup（複用，唔另設一套工位概念）。
  -- 冗餘存一份，係為咗 Realtime 按 station 過濾 / 索引查詢時唔使回查訂單 JSONB。
  station    text        NOT NULL DEFAULT '',
  done_qty   integer     NOT NULL DEFAULT 0,
  cooking_at timestamptz,
  done_at    timestamptz,
  -- 操作人帳號（輕度可識別）→ anon 唔會直接讀到呢張表嘅內容，
  -- 一律經 /api/pos/kds/board（server 端會遮走本欄）。見 §3。
  done_by    text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, order_id, item_key)
);

-- 冇 CHECK (done_qty >= 0)：clamp 喺 server 端做（要對照實際 quantity），
-- DB 加死約束反而會令「減件」路徑喺邊界情況直接 500。

-- 讀屏查詢：某店某工位、最近更新嘅行
CREATE INDEX IF NOT EXISTS pos_kds_item_state_board_idx
  ON pos_kds_item_state (store_id, station, updated_at DESC);

-- 收單時要一次清走某張單全部行（recall / 結帳清理）
CREATE INDEX IF NOT EXISTS pos_kds_item_state_order_idx
  ON pos_kds_item_state (store_id, order_id);


-- ============================================================================
-- 2) RLS：跟 0019 / 0016 加固模式
--    - anon 只留 SELECT（Realtime 以 anon role 跑 RLS，唔留就訂閱唔到）
--    - 寫入一律經 server service_role（/api/pos/kds/*）
--    - 呢張表冇 PII（得 key / 工位 / 份數），所以 anon SELECT 用 using(true)，
--      同 0016 §3c pos_soldout 嘅處理一致。
--      ⚠️ done_by 係帳號（輕度可識別）→ 靠 server 端點遮走，唔靠 RLS 逐欄擋
--         （Postgres RLS 做唔到 column-level，要用 view 或 RPC，唔值）。
-- ============================================================================
ALTER TABLE pos_kds_item_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pos_kds_item_state anon read" ON pos_kds_item_state;
CREATE POLICY "pos_kds_item_state anon read"
  ON pos_kds_item_state
  FOR SELECT TO anon
  USING (true);

DROP POLICY IF EXISTS "pos_kds_item_state service only" ON pos_kds_item_state;
CREATE POLICY "pos_kds_item_state service only"
  ON pos_kds_item_state
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.pos_kds_item_state FROM anon, authenticated;
GRANT SELECT ON TABLE public.pos_kds_item_state TO anon;
GRANT ALL    ON TABLE public.pos_kds_item_state TO service_role;


-- ============================================================================
-- 3) Realtime publication
--    出餐台屏 / 第二部後廚屏要即時見到「另一部機撳咗 ✓」，唔使 polling
--    （全專案禁 polling，見 docs/52 / docs/113）。
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'pos_kds_item_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE pos_kds_item_state;
  END IF;
END $$;


-- ============================================================================
-- 4) 驗收（喺 Supabase SQL Editor 跑）
-- ============================================================================
-- 4.1 表同欄位喺度
--   select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--   where table_name = 'pos_kds_item_state' order by ordinal_position;
--   → 9 欄：store_id / order_id / item_key / station / done_qty /
--           cooking_at / done_at / done_by / updated_at
--
-- 4.2 PK 喺度（重複撳 = upsert 冪等）
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'pos_kds_item_state'::regclass and contype = 'p';
--   → PRIMARY KEY (store_id, order_id, item_key)
--
-- 4.3 RLS 已開
--   select relname, relrowsecurity from pg_class where relname = 'pos_kds_item_state';
--   → relrowsecurity = true
--
-- 4.4 anon 得 SELECT，無 INSERT / UPDATE / DELETE
--   select has_table_privilege('anon', 'pos_kds_item_state', 'SELECT') as sel,
--          has_table_privilege('anon', 'pos_kds_item_state', 'INSERT') as ins,
--          has_table_privilege('anon', 'pos_kds_item_state', 'UPDATE') as upd,
--          has_table_privilege('anon', 'pos_kds_item_state', 'DELETE') as del;
--   → sel = true，其餘全部 false
--
-- 4.5 已入 realtime publication
--   select tablename from pg_publication_tables
--   where pubname = 'supabase_realtime' order by tablename;
--   → 應該見到 pos_kds_item_state
--     （同 pos_orders / pos_print_jobs / pos_soldout / pos_online_order_settings 一齊）
--
-- 4.6 用 anon key 打 PostgREST 寫入必須失敗（RLS 擋）
--   curl -X POST "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/pos_kds_item_state" \
--        -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
--        -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
--        -H "Content-Type: application/json" \
--        -d '{"store_id":"hack","order_id":"x","item_key":"y","done_qty":1}'
--   → 必須失敗（401/403/42501）
--
-- 4.7 upsert 冪等（service_role）
--   insert into pos_kds_item_state (store_id, order_id, item_key, station, done_qty)
--   values ('t','o','k','kitchen',1)
--   on conflict (store_id, order_id, item_key) do update set done_qty = excluded.done_qty;
--   → 跑兩次只得 1 行，done_qty = 1
-- ============================================================================
