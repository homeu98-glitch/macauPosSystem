-- diagnose-and-cleanup-cross-store-contamination.sql
-- 2026-09-06 · 跨店串號後嘅數據清理（配合 0022 migration 同 code fix 使用）
--
-- ⚠️ 重要：跑任何 DELETE 之前請先用 Supabase Dashboard / pg_dump 做完整備份。
--     呢份腳本先「SELECT 睇數」、再「BEGIN; ... ROLLBACK;」試跑、最後先 COMMIT。


-- ============================================================================
-- 0) 現狀總覽（只讀，無風險）
-- ============================================================================

-- 0.1 queue 舊 NULL 行數量（你張截圖就係呢條）
select
  store_id,
  count(*) as event_count,
  min(created_at) as oldest,
  max(created_at) as newest
from pos_queue_events
group by store_id
order by event_count desc;

-- 0.2 pos_orders 按 store_id 分佈（睇下有冇某店特別多離線單）
select
  store_id,
  count(*) as order_count,
  count(*) filter (where source = 'pos') as pos_count,
  count(*) filter (where source = 'kiosk') as kiosk_count,
  count(*) filter (where source = 'scan') as scan_count,
  min(created_at) as oldest,
  max(created_at) as newest
from pos_orders
group by store_id
order by order_count desc;


-- ============================================================================
-- 1) 安全清理：pos_queue_events 舊 NULL 行
--
--    呢啲行冇 store_id，0022 migration 之後 /api/pos/state 唔會再派發佢哋。
--    留喺表入面只會令查詢混淆，可以清掉。
--    清咗**唔影響** pos_orders 已經被改姓嘅行。
-- ============================================================================

-- 1.1 先 SELECT 睇清楚要刪幾多
select count(*) as null_queue_events_to_delete
from pos_queue_events
where store_id is null;

-- 1.2 試跑（BEGIN + ROLLBACK，唔會真刪）
begin;
  delete from pos_queue_events
  where store_id is null;
  -- 確認刪咗幾多行
  select count(*) as deleted_rows;
rollback;

-- 1.3 上面確認無誤後，取消 ROLLBACK 改成 COMMIT：
-- begin;
--   delete from pos_queue_events where store_id is null;
-- commit;


-- ============================================================================
-- 2) pos_orders 污染診斷（只讀，搵已經被改姓嘅單）
--
--    因為 queue 冇 store 歷史，SQL 無法 100% 知道一張 pos_orders 原本屬邊店。
--    呢度提供幾種「可疑名單」查詢，幫你人工判斷。
-- ============================================================================

-- 2.1 用外部真源：online_order_id 對應嘅 Ledger 商戶
--     （只適用於線上單；線下單無 online_order_id 就唔適用）
select
  o.id,
  o.store_id as current_store_id,
  o.online_order_id,
  o.local_order_no,
  o.status,
  o.created_at
from pos_orders o
where o.online_order_id is not null
  and o.store_id != '填入呢張單真正嘅 merchant_id'
order by o.created_at desc
limit 100;

-- 2.2 按 local_order_no 前綴診斷（如果你知道某間店嘅單號前綴）
--     例：60000003 店嘅單號前綴係 "A"，但佢哋出現喺 65273599 嘅 store_id 下 → 污染
select
  id,
  store_id,
  local_order_no,
  status,
  source,
  created_at,
  jsonb_array_elements(items)->>'name' as sample_item
from pos_orders
where store_id = '65273599 嘅 merchant_uuid'   -- ← 填被污染嘅店
  and local_order_no like 'A%'                  -- ← 填外店單號前綴
order by created_at desc;

-- 2.3 按「內容/菜品」搵外店特徵單（最粗略，容易誤中）
--     例：人氣半筋半肉麵 / 招牌牛三寶 / 大麥克牛肉麵 / 原汁牛清湯麵
--     主要出現喺 8291f843 店，但 store_id = d564b932 → 高度可疑
select
  id,
  store_id,
  local_order_no,
  status,
  source,
  created_at,
  jsonb_agg(it->>'name') as item_names
from pos_orders o,
     jsonb_array_elements(o.items) as it
where o.store_id = '65273599 嘅 merchant_uuid'  -- ← 填被污染嘅店
  and it->>'name' in (
    '人氣半筋半肉麵',
    '招牌牛三寶',
    '大麥克牛肉麵',
    '原汁牛清湯麵'
  )
group by o.id, o.store_id, o.local_order_no, o.status, o.source, o.created_at
order by o.created_at desc;


-- ============================================================================
-- 3) pos_orders 清理（必須由你確認 ID 後先好執行）
--
--    由於冇法自動 100% 判斷真原店，**唔建議用 DELETE ... WHERE 內容 like 嘅 heuristics 全刪**。
--    安全做法：先用上面 2.x 查詢列出可疑 ID，確認後用白名單 DELETE。
-- ============================================================================

-- 3.1 將要刪嘅 order id 放喺 CTE，再用 SELECT 覆核數量同金額
-- with ids_to_delete as (
--   select id from pos_orders
--   where store_id = '65273599 嘅 merchant_uuid'
--     and id in ('order-id-1', 'order-id-2')  -- ← 填你確認過嘅 id
-- )
-- select
--   o.store_id,
--   count(*) as n,
--   sum(o.total) as total_mop,
--   min(o.created_at) as oldest,
--   max(o.created_at) as newest
-- from pos_orders o
-- join ids_to_delete d on o.id = d.id
-- group by o.store_id;

-- 3.2 覆核無誤後，取消註釋並執行真刪（建議包 transaction）
-- begin;
--   delete from pos_orders
--   where store_id = '65273599 嘅 merchant_uuid'
--     and id in ('order-id-1', 'order-id-2');  -- ← 填你確認過嘅 id
-- commit;
