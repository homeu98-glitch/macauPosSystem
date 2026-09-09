-- 比較今日 4 張「正常結帳」（有 service/tax）vs 13 張「手動修復」（service/tax = 0）嘅加項比例
-- 目的：用 4 張嘅比例套去 13 張，重算 total，令交班同報表一致
with t as (
  select id, local_order_no, status, subtotal, service_charge_amount, tax_amount, total
  from pos_orders
  where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
    and status = 'settled'
    and created_at::date = current_date
)
select
  -- 有加項 vs 無加項嘅分組
  case
    when coalesce(service_charge_amount,0) + coalesce(tax_amount,0) > 0 then '有加項(4張)'
    else '無加項(13張)'
  end as group_label,
  count(*) as n,
  sum(subtotal) as subtotal_sum,
  sum(coalesce(service_charge_amount,0)) as service_sum,
  sum(coalesce(tax_amount,0)) as tax_sum,
  sum(total) as total_sum,
  -- 派生比：有加項嗰組嘅 svc+tax / subtotal，作為「無加項」嗰組要補返嘅比例
  case
    when sum(subtotal) > 0 and sum(coalesce(service_charge_amount,0)) > 0
    then round( (sum(coalesce(service_charge_amount,0)) + sum(coalesce(tax_amount,0)))::numeric / sum(subtotal) * 100, 2)
  end as pct_svc_plus_tax
from t
group by 1
order by 1;

-- 個別 row（用嚟對數）
select local_order_no, subtotal, service_charge_amount, tax_amount, total,
       (subtotal + coalesce(service_charge_amount,0) + coalesce(tax_amount,0)) as expected_total,
       total as actual_total,
       (subtotal + coalesce(service_charge_amount,0) + coalesce(tax_amount,0)) - total as gap
from pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and status = 'settled'
  and created_at::date = current_date
order by (coalesce(service_charge_amount,0) + coalesce(tax_amount,0)) desc, local_order_no;