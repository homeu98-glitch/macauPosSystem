-- =============================================================================
-- 0069 · pos_orders_page_scoped：多店 scope 的區間訂單查詢（多店控制台 P1）
--
-- 對應：docs/157 §4.4、docs/159 §4（P1-5）
-- 日期：2026-10-21
--
-- 為何要新函數而唔改現有 `pos_orders_page`：
--   現有函數係 `p_store_id text`（單店 or null = 全部店）。店主帳號要「我的 3 間店」
--   彙總，如果用現有函數，唯一寫法係逐店呼叫 3 次再喺 Node merge（3 倍 round trip、
--   3 倍 egress）；而如果傳 null，就會變成「全部店」= **跨租戶洩漏**。
--   ⇒ 新增一支 `p_store_ids text[]`，語義與 0057 版**完全一致**，只係 store 條件由
--     「一間 or 全部」變成「明確一組」。
--
-- 語義（必須逐項對齊 0057 版，唔可以自己重新定義）：
--   · store：`p_store_ids is null or o.store_id = any(p_store_ids)`
--            ⚠️ `null` = 平台級「全部店」；**空陣列 = 一定冇結果**（fail closed）。
--   · 四條時間腿 OR：created_at / updated_at / reopened_at / settled_at 任一命中
--   · order by created_at desc、limit 1..5000、offset >= 0
--
-- 安全：
--   · `security invoker`（同 0046/0057 一致：靠 RLS + 呼叫端身份，唔做 privilege escalation）
--   · revoke anon / authenticated，只 grant service_role（POS server 專用）
--
-- ⚠️ 未跑本 migration 都唔會壞：`fetchOrdersInRange()` 見到 function not found
--    （PGRST202 / 42883）會自動降級四條時間腿（用 `.in("store_id", ids)`），
--    功能仍然正確，只係慢同 egress 多。
--
-- ⚠️ 寫咗 migration ≠ 跑咗 migration。本機冇 DB 連線 ⇒ 要人手去
--    **POS 專案**（iyrywzormzisyppkokbi）→ Supabase Dashboard → SQL Editor 貼。
--    （唔係 Ledger 專案：pos_orders 只存在於 POS DB。）
-- =============================================================================

create or replace function public.pos_orders_page_scoped(
  p_store_ids text[],
  p_start     timestamptz,
  p_end       timestamptz,
  p_limit     int,
  p_offset    int
)
returns setof public.pos_orders
language sql
stable
security invoker
set search_path = public
as $$
  select o.*
    from public.pos_orders o
   where (
          p_store_ids is null
          or (cardinality(p_store_ids) > 0 and o.store_id = any(p_store_ids))
        )
     and (
          -- 腿 1：created_at（涵蓋 updated_at 為 NULL 嘅 legacy row）
          ((p_start is null or o.created_at  >= p_start) and (p_end is null or o.created_at  <= p_end))
          -- 腿 2：updated_at（涵蓋「昨日開單、今日結帳」）
       or ((p_start is null or o.updated_at  >= p_start) and (p_end is null or o.updated_at  <= p_end))
          -- 腿 3：reopened_at（涵蓋「昨日開、今日返結重結」）
       or ((p_start is null or o.reopened_at >= p_start) and (p_end is null or o.reopened_at <= p_end))
          -- 腿 4：settled_at（0057；涵蓋「結帳後被重推、updated_at 漂走」）
       or ((p_start is null or o.settled_at  >= p_start) and (p_end is null or o.settled_at  <= p_end))
     )
   order by o.created_at desc
   limit  greatest(1, least(coalesce(p_limit, 200), 5000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.pos_orders_page_scoped(text[], timestamptz, timestamptz, int, int) is
  '多店範圍的訂單區間分頁（OR 語義同 pos_orders_page 一致）。p_store_ids = null 表示全部店（平台級）；空陣列表示一定冇結果（fail closed）。2026-10-21 多店控制台 P1。';

revoke all on function public.pos_orders_page_scoped(text[], timestamptz, timestamptz, int, int)
  from public, anon, authenticated;
grant execute on function public.pos_orders_page_scoped(text[], timestamptz, timestamptz, int, int)
  to service_role;

-- ============================================================================
-- 驗證（貼完之後逐條跑；全部唯讀）
-- ============================================================================
-- ① 兩店彙總 = 逐店相加（換 <A> / <B> / <START> / <END>）
--   select count(*) from pos_orders_page_scoped(array['<A>','<B>'], '<START>', '<END>', 5000, 0);
--   select count(*) from pos_orders_page('<A>', '<START>', '<END>', 5000, 0)
--        + count(*) from pos_orders_page('<B>', '<START>', '<END>', 5000, 0);
--   ⇒ 兩個數必須相同（前提：兩店冇重複 id，id 係 primary key）。
--
-- ② 空陣列必須回 0 行（fail closed）
--   select count(*) from pos_orders_page_scoped(array[]::text[], null, null, 5000, 0);
--   ⇒ 0
--
-- ③ null = 全部店
--   select count(*) from pos_orders_page_scoped(null, '<START>', '<END>', 5000, 0);
--   ⇒ 應該 >= ①
--
-- ④ anon 必須被拒
--   set role anon;
--   select * from pos_orders_page_scoped(array['<A>'], null, null, 1, 0);   -- 期望 permission denied
--   reset role;
-- ============================================================================
