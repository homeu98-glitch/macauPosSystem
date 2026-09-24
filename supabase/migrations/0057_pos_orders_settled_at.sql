-- 0057 · 訂單不可變業務時間 `settled_at`（跨日漂移根治）
--
-- 背景（2026-09-24 「補完更錯」事故實案）：
--   `/api/pos/sync` 嘅 `updated_at` 係 **server 蓋章**（Vercel/DB 時鐘，方案 B）。
--   任何「重推舊單」（補建、離線補傳、舊 bundle 重推、retry）都會把 `updated_at`
--   推成**重推當刻** ⇒ 報表／交班用 `updated_at` 做日歸屬 ⇒ 舊單**漂到重推嗰日**：
--     · 09-23 嘅 002 / 003 被補建重推 ⇒ 漂到 09-24 ⇒ 28 張/1,778 變 37 張/2,423。
--   本機雖然有 `originalSettledAt`（首次結帳），但**從未上雲**（逐欄複製漏抄嘅同型問題），
--   所以雲端冇任何一個「唔會被重推改變」嘅業務時間。
--
-- 解法（四條鐵律之一）：
--   加一個**裝置喺結帳嗰刻寫一次、server 永不覆蓋**嘅欄：
--     ① client 喺（重）結帳嗰刻用自己部機嘅鐘寫入（重開再結先再寫）；
--     ② sync route 只接受 client 帶上嚟嘅值（「有值才寫」，同 0038 member_* 同款），
--        **永唔用 server 時鐘落章**；舊 client 冇呢個 key ⇒ 唔寫 ⇒ 唔會抹走已有值；
--     ③ 報表／交班／訂單頁統一經 `orderEventInstant()` 讀，`settledAt` 排最前
--        （舊單冇 → 落返 `reopenedAt → originalSettledAt → updatedAt → createdAt`，行為不變）；
--     ④ 區間查詢（`pos_orders_page` RPC ＋ 三腿降級）加第四條 `settled_at` 腿，
--        保證 SQL 超集仍然 ⊇ client 口徑（否則「結帳昨日、重推今日」嘅單會喺昨日報表消失）。
--
-- 效果：重推 N 次、斷網遲上傳、補建舊單 —— `settled_at` 都唔郁 ⇒ 日歸屬永遠啱。
--   離線場景（商家斷網照落單、復網先上傳）反而係最受益嘅情況：
--   單係昨日離線結嘅，`settled_at` 就係昨日，幾時上傳都歸昨日。
--
-- ⚠️ additive + idempotent：舊行唔會壞；舊 client（唔識呢欄）照跑。
--    未跑之前，client 投影（POS_ORDER_DB_COLUMNS）會撞 42703 →
--    server 端已有「42703 降級 select("*")」保險（pos-orders-range.ts 三級降級 ＋
--    state route 嘅 selectOrdersWithFallback），第四腿亦係 best-effort（出錯當冇命中），
--    即係「暫時冇漂移保護」，但落單／結帳／報表主流程完全唔受影響。
--
-- 🔴 俾商家跑嘅 SQL **唔好用 begin;…commit;**（2026-09-24 教訓：商家會將 commit
--    理解成 git commit ⇒ transaction rollback ⇒ 靜默冇改）。本檔全部語句即時生效。

-- ── pos_orders：不可變業務時間 ──
alter table public.pos_orders
  add column if not exists settled_at timestamptz;

comment on column public.pos_orders.settled_at is
  '最近一次結帳時間（寫入嗰部裝置嘅鐘）。結帳嗰刻由 client 寫一次；返結後重結先再寫。server（/api/pos/sync）永不覆蓋、永不用 server 時鐘落章 ⇒ 重推／離線補傳／補建都唔會改變日歸屬。報表／交班／訂單頁經 orderEventInstant() 讀（排最前）。未結帳單 / 舊 client 寫入嘅單為 NULL（落返 reopened_at → updated_at 鏈）。';

-- ── 舊單 backfill：而家嘅雲端口徑係 `reopened_at ?? updated_at`，
--    照原樣 freeze 落 `settled_at` ⇒ backfill 本身**零行為改變**，
--    之後重推就唔會再漂。只限「收過錢」嘅狀態（settled / paid / refunded / partially_refunded）；
--    draft / sent_to_kitchen / reopened 未結帳，留 NULL（結帳嗰刻 client 會寫）。
update public.pos_orders
   set settled_at = coalesce(reopened_at, updated_at)
 where settled_at is null
   and status in ('settled', 'paid', 'refunded', 'partially_refunded');

-- ── 區間查詢第四腿用索引（同 0044 三個索引同款；partial：只索引有值嘅行）──
create index if not exists pos_orders_store_settled_idx
  on public.pos_orders (store_id, settled_at desc)
  where settled_at is not null;

-- ── `pos_orders_page` RPC 加第四條腿（OR 語義不變，只係多一個命中途徑）──
-- create or replace 保留原有 grants；下面照旧補返 revoke/grant 做雙保險。
-- ⚠️ 語義等價性：client 口徑 `orderEventInstant()` 2026-09-24 起改為
--    `settledAt → reopenedAt → originalSettledAt → updatedAt → createdAt`，
--    SQL 必須回傳**超集** ⇒ `settled_at` 腿唔可以漏（漏咗＝「結帳昨日、重推今日」
--    嘅單喺昨日報表靜默消失，同當年 reopened_at 腿嘅病一模一樣）。
create or replace function public.pos_orders_page(
  p_store_id text,
  p_start    timestamptz,
  p_end      timestamptz,
  p_limit    int,
  p_offset   int
)
returns setof public.pos_orders
language sql
stable
security invoker
set search_path = public
as $$
  select o.*
    from public.pos_orders o
   where (p_store_id is null or o.store_id = p_store_id)
     and (
          -- 腿 1：created_at（涵蓋 updated_at 為 NULL 嘅 legacy row）
          ((p_start is null or o.created_at  >= p_start) and (p_end is null or o.created_at  <= p_end))
          -- 腿 2：updated_at（涵蓋「昨日開單、今日結帳」）
       or ((p_start is null or o.updated_at  >= p_start) and (p_end is null or o.updated_at  <= p_end))
          -- 腿 3：reopened_at（涵蓋「昨日開、今日返結重結」；0043 之後先有呢欄）
       or ((p_start is null or o.reopened_at >= p_start) and (p_end is null or o.reopened_at <= p_end))
          -- 腿 4：settled_at（0057；涵蓋「結帳後被重推、updated_at 漂走」嘅單 —— 跨日漂移根治後
          --       client 日歸屬以 settled_at 為準，SQL 超集必須包埋佢）
       or ((p_start is null or o.settled_at  >= p_start) and (p_end is null or o.settled_at  <= p_end))
     )
   order by o.created_at desc
   limit  greatest(1, least(coalesce(p_limit, 200), 5000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.pos_orders_page(text, timestamptz, timestamptz, int, int) is
  '訂單區間分頁（OR 語義：created_at / updated_at / reopened_at / settled_at 任一命中）。取代 /api/pos/state 嘅三條時間腿並行查詢，每次只回一份（egress -2/3）。0057 加 settled_at 腿（跨日漂移根治：client 日歸屬以 settled_at 為準，SQL 超集必須涵蓋）。未跑本 migration 時 fetchOrdersInRange() 會自動降級回三腿路徑。';

revoke all on function public.pos_orders_page(text, timestamptz, timestamptz, int, int) from public, anon, authenticated;
grant execute on function public.pos_orders_page(text, timestamptz, timestamptz, int, int) to service_role;

-- ============================================================================
-- 驗證（貼完之後逐條跑，全部唯讀；唔好用 begin;…commit;）
-- ============================================================================
-- ① 欄位存在 + 型別
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'pos_orders' and column_name = 'settled_at';
--   → settled_at / timestamp with time zone / YES
--
-- ② backfill 覆蓋率（已收錢嘅單應該全部有值；未結帳單應該係 NULL）
--   select status, count(*) as rows, count(settled_at) as with_settled_at
--   from pos_orders
--   group by status
--   order by rows desc;
--   → settled / paid / refunded / partially_refunded 嘅 with_settled_at 應該 = rows
--
-- ③ 抽一張已知嘅單核對（settled_at 應該 = coalesce(reopened_at, updated_at)）
--   select local_order_no, status, reopened_at, updated_at, settled_at
--   from pos_orders
--   where store_id = '<STORE>'
--   order by updated_at desc
--   limit 10;
--
-- ④ RPC 第四腿生效（語義等價：四腿 union vs 函數，兩個數字必須一樣）
--   select count(*) from (
--     select id from pos_orders where store_id = '<STORE>' and created_at  between '<START>' and '<END>'
--     union
--     select id from pos_orders where store_id = '<STORE>' and updated_at  between '<START>' and '<END>'
--     union
--     select id from pos_orders where store_id = '<STORE>' and reopened_at between '<START>' and '<END>'
--     union
--     select id from pos_orders where store_id = '<STORE>' and settled_at  between '<START>' and '<END>'
--   ) t;
--   select count(*) from pos_orders_page('<STORE>', '<START>', '<END>', 5000, 0);
--   ⇒ 兩個必須完全相同。
--
-- ⑤ 權限：anon 應該被拒
--   set role anon;
--   select * from pos_orders_page('<STORE>', null, null, 1, 0);   -- 期望：permission denied
--   reset role;
--
-- 【降級回滾】唔想用第四腿？把函數嘅 settled_at 腿註釋、create or replace 一次即可；
--    `settled_at` 欄留喺 DB 無害（client 舊 bundle 唔讀佢）。
