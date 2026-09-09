-- ============================================================================
-- 2026-09-09 · 修復「雲端卡喺 sent_to_kitchen、但 iPad 已結帳」嘅單（v2）
--
-- ⚠️ 接駁對象：**POS 個 Supabase 庫**（有 pos_orders / pos_queue_events 嗰個）。
--    staff_accounts 喺另一個庫（登入後台），喺呢度查會 42P01 報錯 → 唔好理佢。
--
-- 用法（兩階段，務必跟）：
--   Phase A：行 0–2 段，輸出貼返畀開發者；
--   Phase B：確認冇誤傷「真係未結帳／仲食緊」嘅單之後，先至行 3–4 段。
--   所有 UPDATE 都喺 transaction 入面，可以 rollback。
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 0) Sanity check：確認你連緊嘅 DB 有數據（以下應該出返好大嘅數）
--    如果 count(*) = 0 → 你連錯 project／錯 DB，後面全部唔使睇
-- ────────────────────────────────────────────────────────────────────────────
select (select count(*) from pos_orders)            as total_orders,
       (select count(*) from pos_print_jobs)        as total_print_jobs,
       (select count(*) from pos_queue_events)      as total_queue_events;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) 定位「未結帳」單：**唔加 store filter**，group by store_id
--    （報表若係 admin 跨店視角，13 張可能分佈多間店 → 逐店查會零行）
-- ────────────────────────────────────────────────────────────────────────────
select o.store_id,
       count(*)                                     as open_count,
       coalesce(sum(o.total), 0)                    as open_total_mop,
       min(o.updated_at)::date                      as earliest_update,
       max(o.updated_at)::date                      as latest_update,
       array_agg(o.local_order_no order by o.updated_at desc) as order_nos
from pos_orders o
where o.status in ('sent_to_kitchen', 'draft', 'paid', 'reopened')
group by o.store_id
order by open_count desc;

-- 1b) 完整清單（逐張對賬用）：想收窄就加 `and o.store_id = '…'`
select o.id, o.store_id, o.local_order_no, o.table_name, o.status,
       o.payment_method, o.total, o.created_at, o.updated_at
from pos_orders o
where o.status in ('sent_to_kitchen', 'draft', 'paid', 'reopened')
order by o.updated_at desc;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) 呢啲單有冇 ORDER_SETTLED 審計事件？
--    有 + 單仲係 sent_to_kitchen → 證明「上咗之後被舊 snapshot 回水」
--    完全冇 → 結帳部機從未成功推上雲（去嗰部機睇左下角「⚠ 未同步」卡）
-- ────────────────────────────────────────────────────────────────────────────
select q.store_id, q.entity_id as order_id, q.type, q.created_at as settle_event_at
from pos_queue_events q
where q.type = 'ORDER_SETTLED'
  and q.entity_id in (
        select o.id from pos_orders o
        where o.status in ('sent_to_kitchen', 'draft', 'paid', 'reopened'))
order by q.created_at desc;

-- ============================================================================
-- Phase B（對賬確認之後先行 ↓）
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 3) 乾跑：先睇 UPDATE 會命中邊幾張（逐張核對單號 + 金額）
--    預設修「近 3 日開出、仲係 open」嘅全部店單；想只修一間店／指定單號，
--    就 uncomment 對應嗰行並填值。
-- ────────────────────────────────────────────────────────────────────────────
begin;

with targets as (
    select o.id
    from pos_orders o
    where o.status in ('sent_to_kitchen', 'draft', 'paid', 'reopened')
      and o.updated_at >= now() - interval '3 days'
      -- and o.store_id in ('REPLACE_ME_WITH_STORE_ID')
      -- and o.local_order_no in ('REPLACE_ME')
)
select o.local_order_no, o.table_name, o.status, o.total,
       o.payment_method, o.updated_at
from pos_orders o
join targets t on t.id = o.id
order by o.updated_at;

-- 確認上面輸出冇問題 → 行第 4 段（同一個 transaction 內）

-- ────────────────────────────────────────────────────────────────────────────
-- 4) 正式修復：標 settled。**updated_at 推去 now()** —— 令雲端變成最新版本，
--    唔會被裝置端 LWW merge 打回頭（淨改 status 會好快翻發）
-- ────────────────────────────────────────────────────────────────────────────
with targets as (
    select o.id
    from pos_orders o
    where o.status in ('sent_to_kitchen', 'draft', 'paid', 'reopened')
      and o.updated_at >= now() - interval '3 days'
      -- and o.store_id in ('REPLACE_ME_WITH_STORE_ID')
      -- and o.local_order_no in ('REPLACE_ME')
)
update pos_orders o
set status             = 'settled',
    served_at          = coalesce(o.served_at, o.updated_at),
    updated_at         = now(),
    fulfillment_status = coalesce(o.fulfillment_status, 'served')
    -- 若確實係口頭支付想寫返 payment_method，uncomment 下面行
    -- , payment_method = coalesce(o.payment_method, '口頭支付')
from targets t
where o.id = t.id
returning o.local_order_no, o.table_name, o.status, o.total;

-- 核實：應該變返 0 行（或者剩返真正未結帳嘅單）
select count(*) as remaining_open
from pos_orders
where status in ('sent_to_kitchen', 'draft', 'paid', 'reopened')
  and updated_at >= now() - interval '3 days';

-- 數字啱就 commit；唔啱就 rollback
commit;
-- rollback;
