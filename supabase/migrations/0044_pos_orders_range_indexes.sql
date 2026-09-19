-- ============================================================================
-- 0044_pos_orders_range_indexes.sql
--
-- 目的：為報表「區間查詢」三條腿補索引（2026-09-19）。
--
-- ## 背景
--
-- `fetchOrdersInRange()`（src/lib/pos-orders-range.ts）用三條**並行**
-- plain 查詢取超集，再喺 server 端按 id 去重：
--
--   1. created 腿 ：`created_at ∈ [start, end]`
--   2. updated 腿 ：`updated_at ∈ [start, end]`
--   3. reopened 腿：`reopened_at ∈ [start, end]`   ← 2026-09-19 新增
--
-- 🔴 第 3 條腿係因為返結（反結賬）會寫 `reopened_at`，但**唔一定**同時刷新
--    `updated_at`。缺呢條腿，一張「昨日開、今日返結重結」嘅單，
--    `created_at` 同 `updated_at` 可能**都唔喺**今日區間 ⇒ SQL 唔回 ⇒ 報表**靜默少錢**。
--
-- ## 索引缺口（今次補）
--
-- | 腿 | 欄位 | 之前有冇索引 |
-- |---|---|---|
-- | 1 | `created_at` | ✅ `pos_orders_store_bizdate_idx`（表達式，非直接可比）＋ PK 排序 |
-- | 2 | `updated_at` | ✅ `pos_orders_updated_idx (updated_at)`（但**唔帶 store_id**） |
-- | 3 | `reopened_at` | ❌ **完全冇** ⇒ seq scan |
--
-- ⚠️ 0011 嘅 `pos_orders_updated_idx on pos_orders (updated_at)` 係「全表單欄」，
--    喺「帶 store_id 過濾 + 時間範圍」嘅查詢上選擇性差（多店時要先掃全部店再 filter）。
--    今次一併補 `(store_id, updated_at)` 複合索引。
--
-- ## 為何用 `(store_id, 時間欄位)` 複合 + DESC
--
-- 查詢形狀係 `eq(store_id) + gte(col) + lte(col) + order(col desc) + range(...)`，
-- 複合索引令 PostgREST 可以一次過完成「等值過濾 + 範圍掃描 + 排序」，
-- 唔需要額外 sort node。
--
-- ## 為何唔落 partial index（where ... is not null）
--
-- `reopened_at` 對絕大多數單都係 NULL。Partial index 可以細好多，但：
--   - 查詢用 `gte/lte` 範圍條件，planner 要**證明**範圍唔含 NULL 才會用 partial index；
--     實際上 PostgREST 產生嘅係普通 range 條件 ⇒ 大機會用唔到。
--   - 店鋪單量級（每日數十至數百單）之下，索引大小差異無實際影響。
-- ⇒ 揀普通複合索引，行為可預期。
--
-- ## 執行方式（沿用本專案慣例）
--
-- 喺 Supabase Dashboard → SQL Editor 貼上執行，或經 `tools/` 下嘅腳本。
-- 全部 `if not exists` ⇒ 可重複執行（idempotent）。
--
-- ## 驗證（手動跑）
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public' and tablename = 'pos_orders'
--     and indexname in (
--       'pos_orders_store_created_idx',
--       'pos_orders_store_updated_idx',
--       'pos_orders_store_reopened_idx'
--     )
--   order by indexname;
--   → 應該回 3 行。
-- ============================================================================

-- 腿 1：created_at（涵蓋「區間內開單」＋ NULL updated_at 嘅 legacy row）
create index if not exists pos_orders_store_created_idx
  on public.pos_orders (store_id, created_at desc);

-- 腿 2：updated_at（涵蓋「昨日開單、今日結帳」）
create index if not exists pos_orders_store_updated_idx
  on public.pos_orders (store_id, updated_at desc);

-- 腿 3：reopened_at（涵蓋「昨日開單、今日返結重結」）—— 2026-09-19 新增
create index if not exists pos_orders_store_reopened_idx
  on public.pos_orders (store_id, reopened_at desc);

-- ============================================================================
-- ⚠️ 部署順序注意
--
-- code 已加 `reopened_at` 腿並對「該腿失敗」做咗容錯（只 warn、唔令整頁 error）。
-- 所以：
--   - 先上 code、後跑 migration → 安全（索引未就緒時該腿可能慢，但唔會壞）。
--   - 先跑 migration、後上 code → 亦安全（多咗索引唔影響舊查詢）。
-- ============================================================================
