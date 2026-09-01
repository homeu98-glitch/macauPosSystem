-- 0018 · pos_orders.comp_note / comped_at（免單備註上雲）
-- 對應 docs/91。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 背景
-- ─────────────────────────────────────────────────────────────────────────────
-- 前端 `PosOrder.compNote` / `compedAt`（src/lib/types.ts）喺結帳頁「免單」時寫入
-- （src/components/pos-app.tsx `settleCompOrder()`），用嚟記錄「點解免單」俾對帳。
--
-- **但 `pos_orders` 表一直冇對應欄位，/api/pos/sync 亦冇寫 → 呢兩個值從未上過雲。**
-- 結果：
--   1. 換機／清 cache 之後，由 `/api/pos/state` 重新載入訂單時，免單備註會**冇咗**
--      （本機 localStorage 有，但 server state reload 會蓋返冇 compNote 嘅版本）。
--   2. Ledger 團隊直連 DB 查報表時，無從稽核「邊啲單係免單、點解免單」。
--
-- ⚠️ 點解唔用 `order_note` 裝：
--   `order_note` 係**廚房備註**，受 docs/84 鎖定（`isOrderNoteLocked()`：
--   `sent_to_kitchen` 起鎖死）。而免單**一定**發生喺 `sent_to_kitchen` 之後，
--   寫入 `order_note` 即係直接違反鎖定規則。所以用獨立審計欄位。
--
-- 冇 drop 任何嘢，全部 `if not exists` / DO block 守門，可重複執行。
-- ============================================================================


-- ============================================================================
-- 1) 加欄位
--    comp_note  : text、可 NULL（只有免單嘅單先有值）
--    comped_at  : timestamptz、可 NULL（前端寫 ISO 8601 字串）
--
--    兩欄都係 nullable：絕大多數單永遠唔會免單，唔好迫住填空字串。
-- ============================================================================
alter table pos_orders add column if not exists comp_note text;
alter table pos_orders add column if not exists comped_at timestamptz;

comment on column pos_orders.comp_note is
  '免單備註（原因）。來源：結帳頁「免單」掣，必填，選自 設置→備註→免單備註 或自由輸入。'
  '非免單一律 NULL。⚠️ 唔好寫落 order_note（廚房備註，sent_to_kitchen 起鎖死，見 docs/84）。'
  '報表用途：免單稽核。見 docs/91。';

comment on column pos_orders.comped_at is
  '免單操作時間（ISO 8601 / timestamptz）。非免單一律 NULL。見 docs/91。';


-- ============================================================================
-- 2) 索引：免單稽核報表嘅熱路徑
--
--    只掃有免單嘅單（partial index，佔位極細 —— 免單單佔比通常 < 1%）。
--    `timezone(text, timestamptz)` 係 IMMUTABLE，先入到 expression index
--    （`(timestamptz at time zone 'Asia/Macau')::date` 係 STABLE，會報錯）。
--    同 0017 嘅 `pos_orders_party_size_idx` 同一寫法。
-- ============================================================================
create index if not exists pos_orders_comp_note_idx
  on pos_orders (store_id, (timezone('Asia/Macau', coalesce(updated_at, created_at))::date))
  where comp_note is not null;


-- ============================================================================
-- 3) 報表 View：免單稽核（可選，純新增唔改既有 View）
--
--    刻意**唔改** `report_ro.v_pos_orders` —— `create or replace view` 唔可以
--    淨係「加一欄」，要成個 view 重新貼一次；一旦同線上版本有偏差就會靜默改錯。
--    所以開一張獨立、純新增嘅 view，零風險。
--
--    如果 `report_ro` schema 未建立（未跑 docs/sql/83），成個 block 會跳過。
-- ============================================================================
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'report_ro') then
    execute $ddl$
      create or replace view report_ro.v_pos_comp_orders as
      select
        o.store_id,
        o.id                    as order_id,
        o.local_order_no,
        o.table_name,
        o.status,
        o.payment_method,
        o.subtotal,
        o.discount_amount,
        o.total,
        -- 免單金額 = 全額減免嘅數（settleCompOrder() 寫 discountAmount = 應收原額）
        o.discount_amount       as comped_amount,
        o.comp_note,
        o.comped_at,
        ((coalesce(o.updated_at, o.created_at) at time zone 'Asia/Macau')::date) as biz_date,
        o.created_at,
        o.updated_at
      from public.pos_orders o
      where o.comp_note is not null
    $ddl$;

    -- report_ro 嘅讀取角色（83 號文檔建立）—— 已存在就唔報錯
    if exists (select 1 from pg_roles where rolname = 'ledger_report_ro') then
      execute 'grant select on report_ro.v_pos_comp_orders to ledger_report_ro';
    end if;

    raise notice 'v_pos_comp_orders 已建立（免單稽核 View）';
  else
    raise notice '跳過 v_pos_comp_orders：report_ro schema 尚未建立（見 docs/sql/83）';
  end if;
end $$;


-- ============================================================================
-- 4) 驗收
-- ============================================================================
--
-- 4.1 欄位存在
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema='public' and table_name='pos_orders'
--     and column_name in ('comp_note','comped_at');
--   → comp_note / text / YES
--   → comped_at / timestamp with time zone / YES
--
-- 4.2 有資料（落一張單 → 結帳 → 撳「免單」→ 揀備註 → 確認，之後）
--   select local_order_no, table_name, total, discount_amount,
--          payment_method, comp_note,
--          timezone('Asia/Macau', comped_at) as comped_at_mo
--   from pos_orders
--   where comp_note is not null
--   order by comped_at desc
--   limit 20;
--   → total 應該係 0、payment_method 係「免單」、discount_amount = 免單前應收原額
--
-- 4.3 換機驗證（呢個係今次 migration 嘅核心目的）
--   A 機落免單 → B 機清 localStorage 重新載入 → 開同一張單
--   → 應該睇到「免單備註：XXX」
--
-- 4.4 免單金額彙總（對帳用）
--   select
--     ((coalesce(updated_at, created_at) at time zone 'Asia/Macau')::date) as biz_date,
--     comp_note,
--     count(*)          as comp_count,
--     sum(discount_amount) as comped_total
--   from pos_orders
--   where comp_note is not null
--   group by 1, 2
--   order by 1 desc, 4 desc;
-- ============================================================================
