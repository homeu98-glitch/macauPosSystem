-- 0039 · 「店內營業」開關（線下營業狀態，per-store）
--
-- 背景（J 2026-09-14 需求）：
--   現有「線上接單」（`merchant_enabled`，Ledger 真源）**只管會員通線上落單**，
--   關咗之後店內堂食、快餐、掃碼點餐、自助點餐機**照樣落得到單**
--   （見 0036 檔頭 + `merchant-open-pill.tsx` 嘅關店確認文案）。
--   收銀一直缺一個真正嘅「鋪頭開咗門未」開關 → 呢張表就係佢。
--
-- ── 同「線上接單」嘅關係（🔴 一定要分清）─────────────────────────────────
-- | 開關 | 真源 | 影響 |
-- |---|---|---|
-- | 線上接單（`merchant_enabled`） | **Ledger**（RPC，0036 鏡像） | 只擋會員通線上落單 |
-- | 店內營業（`pos_store_status.is_open`，本檔） | **POS DB（本表）** | 擋掃碼點餐（`/menu`、`/quick`）＋ kiosk（`/order`） |
--
--   兩者**單向連動**（2026-09-14 J 拍板）：
--   - 關「店內營業」→ 前端順手把「線上接單」一齊撳成暫停（＝Ledger RPC）；
--   - 但反過來**唔成立**：切換「線上接單」唔會影響「店內營業」，
--     而且**重開**「店內營業」**唔會**自動開返「線上接單」（原設定可能係店主刻意暫停）。
--   ⇒ 所以本表**唔可以**做成 `merchant_enabled` 嘅鏡像，兩者係獨立欄、獨立真源。
--
-- ── 點解唔放 `pos_kiosk_settings` ────────────────────────────────────────
--   嗰張表係「自助點餐設定」（免確認 / 掃碼模式 / kiosk 打印機），
--   營業狀態係**全店**概念（唔止 kiosk），混入去日後一定誤解。
--
-- ── 客人端點讀 ──────────────────────────────────────────────────────────
--   掃碼 / kiosk 客人端係**匿名**（冇 POS 憑證）：
--   ① 入頁讀一次 → `GET /api/pos/store-status?storeId=`（server service_role 讀，anon 唔直連）
--   ② 落單被拒（4xx `reason: "shop-closed"`）→ 即刻轉全屏「商家不在營業中」
--   硬閘一律喺 server（`/api/pos/sync`），客人端只係提前提示。
--
-- 全部 idempotent，可重複執行。
-- ============================================================================


-- ============================================================================
-- 1) 表
--    DEFAULT true = 「營業中」。⚠️ 刻意同 `auto_accept`（DEFAULT false）相反：
--    未寫過 row 嘅店（新店 / 未更新嘅舊店）**必須**當營業中，
--    否則一上線全店掃碼 + kiosk 即刻落唔到單 —— 等於誤停業。
-- ============================================================================
CREATE TABLE IF NOT EXISTS pos_store_status (
  store_id       text PRIMARY KEY,
  is_open        boolean     NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- 審計（同 0019 同一套口徑）：'pos' = 收銀機改；'ledger' = 平台／後台推過嚟
  updated_source text        NOT NULL DEFAULT 'pos',
  updated_by     text
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_store_status_source_check'
  ) THEN
    ALTER TABLE pos_store_status
      ADD CONSTRAINT pos_store_status_source_check
      CHECK (updated_source IN ('pos', 'ledger'));
  END IF;
END $$;

COMMENT ON TABLE pos_store_status IS
  '店內營業開關（線下）。只管掃碼點餐 / kiosk 落單，同 Ledger merchant_enabled（線上接單）係兩個獨立開關，見 0039 檔頭。';
COMMENT ON COLUMN pos_store_status.is_open IS
  'true = 營業中（可落單）；false = 已暫停（/api/pos/sync 拒絕匿名 scan/kiosk 訂單，reason=shop-closed）。';


-- ============================================================================
-- 2) RLS：跟 0016 加固模式（同 0019 一模一樣）
--    - anon 只留 SELECT：**收銀機**嘅 Realtime 訂閱以 anon role 跑 RLS 檢查，
--      唔留就訂唔到（其他收銀機 toggle 完唔會即刻跟住變）。
--    - 寫入一律 service_role（POST /api/pos/store-status）
--    - 呢張表得 store_id + 一個 boolean + 審計欄，**無 PII**
-- ============================================================================
ALTER TABLE pos_store_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pos_store_status anon read" ON pos_store_status;
CREATE POLICY "pos_store_status anon read"
  ON pos_store_status
  FOR SELECT TO anon
  USING (true);

DROP POLICY IF EXISTS "pos_store_status service only" ON pos_store_status;
CREATE POLICY "pos_store_status service only"
  ON pos_store_status
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.pos_store_status FROM anon, authenticated;
GRANT SELECT ON TABLE public.pos_store_status TO anon;
GRANT ALL    ON TABLE public.pos_store_status TO service_role;


-- ============================================================================
-- 3) Realtime publication
--    A 機關「店內營業」→ B 機（收銀台）嘅 pill 即時跟住變，唔使 polling
--    （全專案禁 polling，見 docs/52）。
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'pos_store_status'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE pos_store_status;
  END IF;
END $$;


-- ============================================================================
-- 4) 驗收（喺 Supabase SQL Editor 跑）
-- ============================================================================
-- 4.1 表同欄位
--   select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--   where table_name = 'pos_store_status' order by ordinal_position;
--   → 5 欄：store_id / is_open / updated_at / updated_source / updated_by
--
-- 4.2 未寫過 row 嘅店：讀出嚟要係「冇 row」→ API 回 isOpen = true（dafault 營業中）
--   select * from pos_store_status;
--
-- 4.3 RLS 已開 + anon 只可以 SELECT
--   select relrowsecurity from pg_class where relname = 'pos_store_status';
--   select has_table_privilege('anon', 'pos_store_status', 'SELECT') as sel,
--          has_table_privilege('anon', 'pos_store_status', 'INSERT') as ins,
--          has_table_privilege('anon', 'pos_store_status', 'UPDATE') as upd;
--   → sel = true，ins / upd = false
--
-- 4.4 已入 realtime publication
--   select tablename from pg_publication_tables
--   where pubname = 'supabase_realtime' and tablename = 'pos_store_status';
--
-- 4.5 手動暫停（模擬收銀撳掣）
--   insert into pos_store_status (store_id, is_open, updated_at, updated_source)
--   values ('<storeId>', false, now(), 'pos')
--   on conflict (store_id) do update set is_open = false, updated_at = now();
--
-- 4.6 落單硬閘驗證（暫停之後，匿名掃碼落單必須被拒）
--   → 客人端撳落單應該見到「商家不在營業中」，而 pos_orders 冇新 row。
-- ============================================================================
