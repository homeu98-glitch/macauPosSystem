-- 0046_pos_orders_page_rpc.sql
-- ============================================================================
-- 目的：用**一條 SQL** 取代 `/api/pos/state`／報表／admin 訂單嘅「三條時間腿」查詢。
--
-- 【背景：為咩要三條腿，同為咩要換走】
-- 報表口徑要「created_at / updated_at / reopened_at **任何一個**落喺區間內就算」
-- （OR 語義，見 src/lib/pos-orders-range.ts 檔頭）。歷史上有兩個做法都出事：
--   · `.or('and(created_at.gte.…),and(updated_at.gte.…)')` —— PostgREST 對
--     nested 群組 + `+08:00` offset 值嘅解析歧義（回 0 筆）→ admin 報表「全部→今天」空資料；
--   · `.filter()` chain —— AND 語義，會漏「昨日開單、今日結帳」嘅單。
-- ⇒ 現行做法係**三條完全無 logic 語法嘅 plain indexed 查詢並行**，每次 `.range()`
--   各自分頁，回嚟嘅超集再喺 client 按 id 去重。
--
-- 🔴 代價（2026-09-21 實測 Supabase log）：**每一頁都要回 3 份**，
--    而 PostgREST egress 係按 bytes 計費。實測形狀：
--      pos_orders?select=*&…&order=created_at.desc&offset=0&limit=5000   ← 一組三條
--      pos_orders?select=*&…&order=updated_at.desc&offset=0&limit=5000
--      pos_orders?select=*&…&order=reopened_at.desc&offset=0&limit=5000
--    26 分鐘內出現 30 次（= 10 組），係當時**最大單一 egress 來源**。
--
-- 【本函數做乜】
--   同一條 SQL 內做 OR + 去重 + 排序 + 分頁 → **每行只回一次**（省 2/3），
--   而且 PostgREST 層面零 `.or()` 語法，重蹈唔到上面兩個歷史坑。
--
-- 【語義等價性（必須逐項對齊 client）】
--   舊（三腿 union）   本函數
--   -----------------  ------------------------------------------------------
--   store_id = eq       `p_store_id is null or o.store_id = p_store_id`
--                       （null = admin 跨店彙總，舊版係唔加 store filter）
--   L >= start          `p_start is null or o.<L> >= p_start`
--   L <= end            `p_end   is null or o.<L> <= p_end`
--   L ∈ {created_at, updated_at, reopened_at}（三腿 OR）
--   id 去重             天然去重（單一 select，冇 union all）
--   order created_at desc → 一樣
--   ⚠️ 舊版 start/end 兩者皆 null 時 = 三個全表查詢 union（等價於「全部」）；
--      本函數嘅 OR 條件喺兩者皆 null 時恆真 → **同樣回全部**（super-set 語義一致）。
--
-- 【client 端配合】
--   `fetchOrdersInRange()` 先試本 RPC；**未跑本 migration 會自動降級**回三條腿
--   （錯誤碼 PGRST202 / 42883 = function not found），所以「新 client + 舊 DB」唔會壞。
--
-- 【索引】
--   依賴 0044_pos_orders_range_indexes.sql 嘅三個索引：
--     pos_orders_store_created_idx  (store_id, created_at desc)
--     pos_orders_store_updated_idx  (store_id, updated_at desc)
--     pos_orders_store_reopened_idx (store_id, reopened_at desc)
--   ⚠️ 未跑 0044 都唔會錯，只係「全部／30 日」呢類大範圍會慢（仍然正確）。
--
-- ⚠️ 寫咗 migration ≠ 跑咗 migration（已踩過 0018/0019/0020/0040/0044/0045）。
--    本機冇 DB 連線 → 要人手去 Supabase Dashboard → SQL Editor 貼呢段。
--    全部 idempotent（create or replace），可以重複貼。
-- ============================================================================

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
-- security invoker（預設，明寫出嚟做文件）：純讀取函數唔需要提升權限。
-- 呼叫端係 server（service_role，本身 bypass RLS）；而他日若有人用 anon key 呼叫，
-- invoker + RLS 會照樣擋住 —— 唔會因為呢個函數開咗後門。
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
     )
   order by o.created_at desc
   limit  greatest(1, least(coalesce(p_limit, 200), 5000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.pos_orders_page(text, timestamptz, timestamptz, int, int) is
  '訂單區間分頁（OR 語義：created_at / updated_at / reopened_at 任一命中）。取代 /api/pos/state 嘅三條時間腿並行查詢，每次只回一份（egress -2/3）。未跑本 migration 時 fetchOrdersInRange() 會自動降級回三腿路徑。';

-- 只准 server（service_role）呼叫。anon / authenticated 一律拒絕。
revoke all on function public.pos_orders_page(text, timestamptz, timestamptz, int, int) from public, anon, authenticated;
grant execute on function public.pos_orders_page(text, timestamptz, timestamptz, int, int) to service_role;

-- ============================================================================
-- 驗證（貼完之後逐條跑，全部唯讀）
-- ============================================================================
-- ① 函數存在？
--    select proname, pg_get_function_arguments(oid) as args
--      from pg_proc where proname = 'pos_orders_page';
--    期望：1 行，args = 'p_store_id text, p_start timestamp with time zone, p_end timestamp with time zone, p_limit integer, p_offset integer'
--
-- ② 語義等價（同一區間，三腿 vs 本函數，兩個數字必須一樣）
--    -- 三腿（舊做法，模擬 client）
--    select count(*) from (
--      select id from pos_orders where store_id = '<STORE>' and created_at  between '<START>' and '<END>'
--      union
--      select id from pos_orders where store_id = '<STORE>' and updated_at  between '<START>' and '<END>'
--      union
--      select id from pos_orders where store_id = '<STORE>' and reopened_at between '<START>' and '<END>'
--    ) t;
--    -- 本函數
--    select count(*) from pos_orders_page('<STORE>', '<START>', '<END>', 5000, 0);
--    ⇒ 兩個必須完全相同。
--
-- ③ 無區間（兩個 null）＝ 全部（同舊行為）
--    select count(*) from pos_orders_page('<STORE>', null, null, 5000, 0);
--    select count(*) from pos_orders where store_id = '<STORE>';
--    ⇒ 若總數 ≤ 5000，兩個必須相同。
--
-- ④ 權限：anon 應該被拒
--    set role anon;
--    select * from pos_orders_page('<STORE>', null, null, 1, 0);   -- 期望：permission denied
--    reset role;
--
-- ⑤ 效能（跑 0044 索引之後）：應該見到 Index Scan / Index Only Scan，唔應該 Seq Scan
--    explain (analyze, buffers)
--    select * from pos_orders_page('<STORE>', now() - interval '1 day', now(), 2000, 0);
--
-- 【降級回滾】唔想用 RPC？把 client 端 `fetchOrdersInRange()` 嘅 RPC 分支註釋即可
-- （函數留喺 DB 無害，唔會有人自動呼叫）。或者：
--    drop function if exists public.pos_orders_page(text, timestamptz, timestamptz, int, int);
