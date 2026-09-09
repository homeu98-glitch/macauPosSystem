-- 為咗搞清「報表線下 903」嘅來源，跑一句簡單 sum：
-- 同時顯示「加 subtotal/service_charge/tax 嘅衍生數」方便對數
select
  count(*) filter (where status = 'settled') as settled_n,
  sum(case when status = 'settled' then total else 0 end) as sum_total,
  sum(case when status = 'settled' then coalesce(subtotal,0) else 0 end) as sum_subtotal,
  sum(case when status = 'settled' then coalesce(service_charge_amount,0) else 0 end) as sum_svc,
  sum(case when status = 'settled' then coalesce(tax_amount,0) else 0 end) as sum_tax,
  sum(case when status = 'settled' then coalesce(discount_amount,0) else 0 end) as sum_discount,
  -- 衍生：subtotal + svc + tax
  sum(case when status = 'settled'
           then coalesce(subtotal,0) + coalesce(service_charge_amount,0) + coalesce(tax_amount,0)
           else 0 end) as sum_gross,
  -- 衍生：subtotal + svc + tax - discount
  sum(case when status = 'settled'
           then coalesce(subtotal,0) + coalesce(service_charge_amount,0) + coalesce(tax_amount,0) - coalesce(discount_amount,0)
           else 0 end) as sum_net
from pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and created_at::date = current_date;