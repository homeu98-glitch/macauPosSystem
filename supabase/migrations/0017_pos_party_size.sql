-- 0017 · pos_orders.party_size（入座人數 / covers）上雲
-- 對應 docs/83 §Part D、docs/89 §3。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 背景
-- ─────────────────────────────────────────────────────────────────────────────
-- 前端 `PosOrder.partySize`（src/lib/types.ts L392）一直有，開桌彈窗會蒐集
-- （src/components/pos-app.tsx `confirmOpenTable()`），報表嘅「覆蓋人數 / 人均消費」
-- 亦已經靠佢計（restaurant-daily-report.tsx L144 / L154）。
-- **但 `pos_orders` 表一直冇對應欄位，/api/pos/sync 亦冇寫 → 呢個值從未上過雲。**
-- 結果：Ledger 團隊直連 DB 查報表時，`covers`（覆蓋人數）永遠係 0 / NULL。
--
-- 修復：加欄 → sync 寫入 → mapper 讀回 → 一次性 backfill 補返歷史單。
--
-- 冇 drop 任何嘢，全部 `if not exists` / DO block 守門，可重複執行。
-- ============================================================================


-- ============================================================================
-- 1) 加欄位
--    integer、可 NULL（快餐／外賣／自取單冇「入座」概念 → 留空，唔好亂填 1，
--    否則會污染人均消費分母）。
-- ============================================================================
alter table pos_orders add column if not exists party_size integer;

comment on column pos_orders.party_size is
  '入座人數（covers）。來源：開桌彈窗 / 點餐頁人數控制。快餐·外賣·自取單為 NULL。'
  '報表用途：覆蓋人數、人均消費。見 docs/83 §5。';


-- ============================================================================
-- 2) 值域約束：NULL 或 1..999
--    先 drop 再 add，等重複執行都安全（add constraint 冇 if not exists）。
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pos_orders_party_size_check'
  ) then
    alter table pos_orders
      add constraint pos_orders_party_size_check
      check (party_size is null or (party_size >= 1 and party_size <= 999));
  end if;
end $$;


-- ============================================================================
-- 3) 索引：報表查詢嘅熱路徑
--
--    報表歸屬日 = (coalesce(updated_at, created_at) at time zone 'Asia/Macau')::date
--    （同 src/lib/ledger/report-period.ts `orderMatchesReportRange()` 一致）。
--    呢個 expression index 令「某店某日嘅單」呢類查詢行 index scan 唔使全表掃。
--    `immutable` 問題：`timestamptz at time zone 'Asia/Macau'` 係 STABLE 唔係 IMMUTABLE，
--    所以要用 `date(timezone('Asia/Macau', ...))` 呢種寫法先入到 expression index。
--    PostgreSQL 對 `(timestamptz at time zone 'Asia/Macau')::date` 其實會報
--    "functions in index expression must be marked IMMUTABLE" → 改用 timezone()，
--    兩者語義一樣（都係轉去 Macau 當地時間），但 timezone(text, timestamptz) 係 IMMUTABLE。
-- ============================================================================
create index if not exists pos_orders_store_bizdate_idx
  on pos_orders (store_id, (timezone('Asia/Macau', coalesce(updated_at, created_at))::date));

-- 有 party_size 嘅單（covers 報表只掃呢批）
create index if not exists pos_orders_party_size_idx
  on pos_orders (store_id, (timezone('Asia/Macau', coalesce(updated_at, created_at))::date))
  where party_size is not null;


-- ============================================================================
-- 4) 驗收
-- ============================================================================
--
-- 4.1 欄位存在
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema='public' and table_name='pos_orders' and column_name='party_size';
--   → integer / YES
--
-- 4.2 約束生效（呢句必須失敗）
--   update pos_orders set party_size = 0 where id = (select id from pos_orders limit 1);
--   → ERROR: new row for relation "pos_orders" violates check constraint "pos_orders_party_size_check"
--
-- 4.3 有資料（落一張堂食單結帳之後）
--   select local_order_no, table_name, party_size, total,
--          timezone('Asia/Macau', coalesce(updated_at, created_at))::date as biz_date
--   from pos_orders
--   where party_size is not null
--   order by updated_at desc
--   limit 20;
--   → 應該見到開桌時填嘅人數
--
-- 4.4 覆蓋率（用嚟判斷 backfill 使唔使跑）
--   select
--     count(*)                                        as total_orders,
--     count(*) filter (where party_size is not null)  as with_party_size,
--     round(100.0 * count(*) filter (where party_size is not null) / nullif(count(*), 0), 1) as pct
--   from pos_orders;
-- ============================================================================
