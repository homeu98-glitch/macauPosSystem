-- ============================================================================
-- 檢查「關鍵 migration 有冇跑齊」（2026-09-22，17:58 修正版）
-- 用法：Supabase Dashboard → SQL Editor → 貼上全段 → Run
-- 一次過回一張表，唔會改任何嘢（純 read-only）。
-- ============================================================================
--
-- 🔴🔴 修正紀錄（17:58）—— 上一版有兩個**假陰性**，唔好再信舊版：
--   · 我上一版用 `to_regprocedure('public.pos_reclaim_stale_print_jobs(text)')` 檢查 0035
--     —— **根本冇呢個函數**。實情：0035 同 0042 都係 `create or replace function
--     public.pos_claim_print_jobs(text, text, int)` 嘅**連續版本**（0035 = 第 2 版加 stale requeue、
--     0042 = 第 3 版加分段窗）。⇒ 0035 **冇獨立 schema 指紋**，強行檢查只會永遠 false。
--   · 我上一版用 `pos_print_jobs.ttl` 欄檢查 0042 —— `ttl` 其實係 **0020** 加嘅 ⇒ 就算 0042 未跑都會顯示 ✓。
--
-- 🔴🔴🔴 由此引伸出一個**真實風險**，一定要記住：
--   **唔可以單獨重跑 0035 或 0042**。兩者係同一個函數嘅連續版本，
--   單跑 0035 ＝ **把 claim 邏輯回退到第 2 版**（失去 0042 嘅分段 claim 窗）。
--   要跑就一定**順序跑**（0035 → 0042），或者索性兩個都唔跑（跑咗 0042 就當兩者都在）。
--
-- ── A. 一頁睇齊：每份近期 migration 嘅「指紋」存唔存在 ──────────────────────
with checks as (
  select '0035+0042 claim 函數（0042 覆寫 0035）' as migration,
         to_regprocedure('public.pos_claim_print_jobs(text,text,int)') is not null as applied
  union all select '0042b 過期 job 清理函數',   to_regprocedure('public.pos_void_stale_print_jobs(text)') is not null
  union all select '0037 商家模組表',           exists (select 1 from information_schema.tables where table_name='pos_merchant_modules')
  union all select '0039 店舖狀態表',           exists (select 1 from information_schema.tables where table_name='pos_store_status')
  union all select '0041 anon 讀取窗政策',       exists (select 1 from pg_policies where tablename='pos_orders' and policyname ilike '%anon read%')
  union all select '0043 返結審計欄',           exists (select 1 from information_schema.columns where table_name='pos_orders' and column_name='reopen_count')
  union all select '0044 三腿索引(updated)',    exists (select 1 from pg_indexes where indexname='pos_orders_store_updated_idx')
  union all select '0045 once_key 唯一鍵',      exists (select 1 from information_schema.columns where table_name='pos_print_jobs' and column_name='once_key')
  union all select '0046 pos_orders_page RPC',  to_regprocedure('public.pos_orders_page(text,timestamptz,timestamptz,int,int)') is not null
  union all select '0047 pos_sessions 表',      exists (select 1 from information_schema.tables where table_name='pos_sessions')
  union all select '0048 用量計量表',           exists (select 1 from information_schema.tables where table_name='pos_egress_daily')
  union all select '0048b 用量累加 RPC',        to_regprocedure('public.pos_bump_egress(text,date,text,bigint,bigint)') is not null
  -- 🔴 0049：呢三欄**從來冇 migration 建過**（見 0049 檔頭）⇒ 未跑之前每次冷啟都會 42703 + 400
  union all select '0049 退款審計三欄',         exists (select 1 from information_schema.columns where table_name='pos_orders' and column_name='refunded_amount')
)
select migration, applied, case when applied then '✓ 已跑' else '✗ 未跑' end as status
  from checks
 order by applied, migration;

-- ── A2. 0049 即場驗收（應該 3 行）──────────────────────────────────────────
select column_name, data_type
  from information_schema.columns
 where table_name = 'pos_orders'
   and column_name in ('refund_records','refunded_amount','voided_items')
 order by column_name;

-- ── B. 未跑嘅 migration 有咩即時症狀（方便對號入座）─────────────────────────
-- 未跑 0043b ⇒ /api/pos/sync 每次降級查詢，log 會見
--             `column pos_orders.refund_records does not exist`（42703）
-- 未跑 0048  ⇒ Admin → 雲端用量頁顯示「計量尚未啟用」；`pos_egress_daily` 查詢會 42P01
-- 未跑 0047  ⇒ Admin → POS 工作階段頁空白；POS 冇 session 橫幅

-- ── C. RLS / 權限抽查（安全）──────────────────────────────────────────────
select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public' and tablename in
       ('pos_orders','pos_print_jobs','pos_print_agents','pos_sessions','pos_egress_daily')
 order by tablename;

-- anon 應該只有「最新窗口」嘅 SELECT；唔應該有 write
select table_name, privilege_type
  from information_schema.role_table_grants
 where grantee = 'anon' and table_schema = 'public' and table_name like 'pos\_%'
 order by table_name, privilege_type;

-- ── D. once_key 唯一鍵（0045）真係 partial unique index？────────────────────
select indexname, indexdef
  from pg_indexes
 where tablename = 'pos_print_jobs' and indexdef ilike '%once_key%';

-- ── E. 用量計量有冇開始入數（0048 跑完之後）────────────────────────────────
-- select day, route, calls, pg_size_pretty(bytes) as bytes
--   from public.pos_egress_daily
--  order by day desc, bytes desc
--  limit 30;
