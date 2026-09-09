-- 確認今日 17 張 settled 單嘅 subtotal/service/tax/total 真實數字
-- 用嚟分辨「903」到底係點計出嚟
select
  local_order_no,
  status,
  subtotal,
  service_charge_amount,
  tax_amount,
  total,
  discount_amount,
  (coalesce(subtotal,0) + coalesce(service_charge_amount,0) + coalesce(tax_amount,0)) as gross_total,
  (coalesce(subtotal,0) + coalesce(service_charge_amount,0) + coalesce(tax_amount,0) - coalesce(discount_amount,0)) as net_total
from pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and status = 'settled'
  and created_at::date = current_date
order by local_order_no;