-- ============================================================================
-- 2026-09-09 · 修復後核實（唯讀，安全）
-- 用嚟確認：啱啱 UPDATE 究竟改咗邊啲單、改咗幾多行、報表數字啱唔啱
-- ============================================================================

-- 1) 啱啱（最後 30 分鐘內）被你改成 settled 嘅單 —— 睇下係咪嗰 13 張
--    如果呢度係空 → 證明你個 UPDATE 影響咗 0 行（= 情況 B，我哋搵錯表）
select store_id, local_order_no, table_name, total, payment_method,
       status, updated_at
from pos_orders
where status = 'settled'
  and updated_at >= now() - interval '30 minutes'
order by updated_at;

-- 2) 你間店而家仲有冇 open 單（應該係 0；仲有就係「真係未結帳」嗰啲）
select status, count(*), coalesce(sum(total), 0) as total_mop
from pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and status in ('sent_to_kitchen', 'draft', 'paid', 'reopened')
group by status;

-- 3) 你間店今日總共幾多張 settled（含啱啱修嘅）—— 用嚟同報表營業額對數
select count(*) as settled_today, coalesce(sum(total), 0) as settled_total_mop
from pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and status = 'settled'
  and updated_at >= date_trunc('day', now() - interval '8 hours');
