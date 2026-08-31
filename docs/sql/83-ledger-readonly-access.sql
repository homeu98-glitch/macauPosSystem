-- =============================================================================
-- Macau POS → Ledger 報表對接：唯讀角色 + 唯讀 View
-- 配套文檔：docs/83-ledger-report-db-integration.md
--
-- 執行者  ：macau-pos 管理員（Supabase Dashboard → SQL Editor）
-- 引擎    ：PostgreSQL 15+（Supabase）
-- 冪等性  ：全部語句可重複執行，重跑唔會報錯、唔會改壞現有設定
--
-- 分四部分：
--   Part A  建立唯讀角色 ledger_report_ro + 逐表 SELECT 授權（必須）
--   Part B  建立 report_ro schema + 唯讀 View（必須）
--   Part C  驗收檢查（必須，執行完要逐條確認）
--   Part D  可選：補齊 pos_orders.party_size 後重建覆蓋人數 View
--
-- ⚠️ Part A 第 1 步嘅密碼請先改成強密碼，唔好直接貼上執行。
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- Part A · 唯讀角色與權限
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A1. 建立角色（LOGIN + 密碼）────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ledger_report_ro') then
    -- TODO: 換成強密碼（建議 32 字符隨機字串），並透過密碼管理器交畀 Ledger
    create role ledger_report_ro login password 'CHANGE_ME_STRONG_PASSWORD_32CHARS';
  end if;
end
$$;

-- ── A2. 會話級防呆設定 ───────────────────────────────────────────────────
-- 說明：真正嘅強制唯讀係 A4「唔授予任何寫入權限」（PG 無 GRANT 即為拒絕）。
--       以下 GUC 只係第二層防呆；客戶端可以自己 SET 覆寫，勿當硬性保證。
alter role ledger_report_ro set default_transaction_read_only = on;
alter role ledger_report_ro set statement_timeout                  = '30s';   -- 單條 SQL 最長 30 秒
alter role ledger_report_ro set idle_in_transaction_session_timeout  = '60s';   -- 防僵屍交易
alter role ledger_report_ro set lock_timeout                         = '5s';    -- 只讀唔會攞鎖，純保險
alter role ledger_report_ro set timezone                             = 'Asia/Macau';
alter role ledger_report_ro set search_path                          = public, report_ro;

-- ── A3. 連線與 schema ────────────────────────────────────────────────────
grant connect on database postgres        to ledger_report_ro;
grant usage   on schema public            to ledger_report_ro;
revoke create on schema public            from ledger_report_ro;   -- 唔准喺 public 建物件

-- ── A4. 逐表 SELECT 授權（白名單，其餘一律唔可讀）─────────────────────────
-- 餐飲報表（/reports）
grant select on public.pos_orders            to ledger_report_ro;
grant select on public.pos_bootstrap_config  to ledger_report_ro;
grant select on public.inv_products          to ledger_report_ro;
grant select on public.inv_stock_movements   to ledger_report_ro;

-- Salon 報表（/salon/reports）
grant select on public.salon_orders              to ledger_report_ro;
grant select on public.salon_bookings            to ledger_report_ro;
grant select on public.salon_package_templates   to ledger_report_ro;
grant select on public.salon_customer_packages   to ledger_report_ro;
grant select on public.salon_product_sales       to ledger_report_ro;
grant select on public.salon_products            to ledger_report_ro;

-- ⚠️ 以下表**刻意唔授權**，如有需要請另行提出：
--   public.salon_customers       含客戶姓名 / 電話 / 生日 / 病歷偏好（PII）
--                                → 只經 report_ro.v_salon_expiring_packages 暴露姓名
--   public.pos_device_configs    含打印機 IP、終端本機設定（營運基建）
--   public.pos_queue_events      同步隊列原始 payload（含已刪除單內容）
--   public.pos_print_jobs        廚房單列印任務（與報表無關）
--   public.salon_print_jobs      同上（salon）
--   public.salon_queue_events    同上（salon）
--   public.pos_soldout           沽清標記（程式目前無寫入，全為空，見文檔 §6.4）
--   public.pos_daily_sequences   單號計數器（與報表無關）


-- ═══════════════════════════════════════════════════════════════════════════
-- Part B · report_ro schema + 唯讀 View
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 設計原則：
--  1. View 由 postgres（owner）執行，讀取底表用 owner 權限 → Ledger 唔使直讀
--     salon_customers 都可以拎到套票到期嘅客戶名（資料最小化）。
--  2. 所有 View 一律帶 store_id，Ledger **必須**自行加 where store_id = ? 隔離。
--  3. 所有日期邊界統一用 Asia/Macau，避免 UTC 錯位。
--  4. 一律用 security_invoker = false（PG15 預設），保持上述「經 View 授權」行為。
--
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists report_ro;
grant usage on schema report_ro to ledger_report_ro;

-- 日後喺 report_ro 新增 View 時自動授權
alter default privileges in schema report_ro
  grant select on tables to ledger_report_ro;


-- ─────────────────────────────────────────────────────────────────────────
-- B1 · 餐飲：訂單級寬表（一張單一行）
--      v_pos_orders
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_pos_orders as
select
  o.store_id,
  o.id                                                    as order_id,
  o.local_order_no,
  o.table_id,
  o.table_name,
  o.status,
  o.fulfillment_status,
  o.payment_method,
  (o.online_order_id is not null)                         as is_online,
  o.online_order_id,
  -- 報表口徑：只計「已結帳類」狀態（對應前端 aggregate() 嘅 closed）
  (o.status in ('settled', 'partially_refunded', 'refunded')) as is_closed,
  o.subtotal,
  o.discount_amount,
  o.tax_amount,
  o.service_charge_amount,
  o.total,
  o.prepaid_amount,
  o.created_at,
  o.updated_at,
  o.sent_to_kitchen_at,
  o.served_at,
  -- 報表歸屬日（前端用 coalesce(updatedAt, createdAt) 嘅澳門日期）
  ((coalesce(o.updated_at, o.created_at) at time zone 'Asia/Macau')::date) as biz_date,
  -- 落單日（前端「本月食材消耗」用 createdAt 嘅澳門年月）
  ((o.created_at at time zone 'Asia/Macau')::date)                        as order_date,
  (extract(hour from o.created_at at time zone 'Asia/Macau'))::int         as order_hour,
  -- 出餐時間（分鐘）
  case
    when o.sent_to_kitchen_at is not null and o.served_at is not null
      then greatest(0, extract(epoch from (o.served_at - o.sent_to_kitchen_at)) / 60.0)
  end                                                     as serving_minutes_measured,
  (o.sent_to_kitchen_at is null or o.served_at is null)   as serving_is_estimated,
  greatest(
    0,
    extract(epoch from (coalesce(o.served_at, o.updated_at)
                      - coalesce(o.sent_to_kitchen_at, o.created_at))) / 60.0
  )                                                       as serving_minutes_fallback,
  -- 明細聚合（已退菜唔計入 sold）
  agg.sold_qty,
  agg.void_qty,
  agg.void_amount
from public.pos_orders o
left join lateral (
  select
    coalesce(sum(case when coalesce((it ->> 'voided')::boolean, false)
                      then 0 else coalesce((it ->> 'quantity')::numeric, 0) end), 0)      as sold_qty,
    coalesce(sum(case when coalesce((it ->> 'voided')::boolean, false)
                      then coalesce((it ->> 'quantity')::numeric, 0) else 0 end), 0)      as void_qty,
    coalesce(sum(case when coalesce((it ->> 'voided')::boolean, false)
                      then coalesce((it ->> 'quantity')::numeric, 0)
                         * coalesce((it ->> 'price')::numeric, 0) else 0 end), 0)         as void_amount
  from jsonb_array_elements(
    case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
  ) as it
) as agg on true;


-- ─────────────────────────────────────────────────────────────────────────
-- B2 · 餐飲：菜品明細寬表（一條明細一行）
--      v_pos_order_items
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_pos_order_items as
select
  o.store_id,
  o.id                                                    as order_id,
  o.local_order_no,
  o.table_id,
  o.table_name,
  o.status,
  (o.online_order_id is not null)                         as is_online,
  (o.status in ('settled', 'partially_refunded', 'refunded')) as is_closed,
  ((coalesce(o.updated_at, o.created_at) at time zone 'Asia/Macau')::date) as biz_date,
  ((o.created_at at time zone 'Asia/Macau')::date)                        as order_date,
  (extract(hour from o.created_at at time zone 'Asia/Macau'))::int         as order_hour,
  (it ->> 'menuItemId')                                   as menu_item_id,
  (it ->> 'name')                                         as item_name,
  (it ->> 'printerGroup')                                 as printer_group,
  coalesce((it ->> 'quantity')::numeric, 0)               as quantity,
  coalesce((it ->> 'price')::numeric, 0)                  as unit_price,
  coalesce((it ->> 'quantity')::numeric, 0)
    * coalesce((it ->> 'price')::numeric, 0)              as line_amount,
  coalesce((it ->> 'voided')::boolean, false)             as is_voided,
  (it ->> 'voidedAt')                                     as voided_at,
  (it ->> 'voidedReason')                                 as voided_reason,
  (it ->> 'note')                                         as item_note,
  (it -> 'selectedSpecs')                                 as selected_specs
from public.pos_orders o
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
) as it;


-- ─────────────────────────────────────────────────────────────────────────
-- B3 · 餐飲：每日總結（KPI）
--      v_pos_daily_summary
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_pos_daily_summary as
select
  store_id,
  biz_date,
  count(*)                                                       as order_count,
  sum(total)                                                     as revenue,
  sum(case when is_online then total else 0 end)                 as online_revenue,
  sum(case when not is_online then total else 0 end)             as offline_revenue,
  case when sum(total) > 0
       then sum(case when is_online then total else 0 end) / sum(total) end as online_share,
  sum(discount_amount)                                           as discount_amount,
  case when sum(total) > 0 then sum(discount_amount) / sum(total) end       as discount_ratio,
  sum(sold_qty)                                                  as sold_qty,
  sum(void_qty)                                                  as void_qty,
  sum(void_amount)                                               as void_amount,
  case when sum(sold_qty) > 0 then sum(void_qty) / sum(sold_qty) end        as void_rate,
  case when count(*) > 0 then sum(total) / count(*) end                     as avg_ticket,
  -- 出餐時間（分鐘）：measured = 只計有完整時間戳；mixed = 缺時間戳用落單→結帳估算
  count(*) filter (where serving_minutes_measured is not null)   as serving_measured_count,
  avg(serving_minutes_measured)                                  as serving_avg_min_measured,
  percentile_cont(0.5)  within group (order by serving_minutes_measured::double precision) as serving_median_min_measured,
  percentile_cont(0.95) within group (order by serving_minutes_measured::double precision) as serving_p95_min_measured,
  avg(coalesce(serving_minutes_measured, serving_minutes_fallback))       as serving_avg_min_mixed,
  percentile_cont(0.5)  within group (order by coalesce(serving_minutes_measured, serving_minutes_fallback)::double precision) as serving_median_min_mixed,
  percentile_cont(0.95) within group (order by coalesce(serving_minutes_measured, serving_minutes_fallback)::double precision) as serving_p95_min_mixed,
  bool_or(serving_is_estimated)                                  as serving_contains_estimate
from report_ro.v_pos_orders
where is_closed
group by store_id, biz_date;


-- ─────────────────────────────────────────────────────────────────────────
-- B4 · 餐飲：菜品銷售排行
--      v_pos_dish_ranking（按日）
--      v_pos_dish_ranking_range（不預先分組，自行 where biz_date between）
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_pos_dish_ranking as
select
  store_id,
  biz_date,
  menu_item_id,
  max(item_name)                                     as item_name,
  sum(quantity)                                      as total_qty,
  sum(case when is_online then quantity else 0 end)  as online_qty,
  sum(case when not is_online then quantity else 0 end) as offline_qty,
  sum(line_amount)                                   as revenue,
  case
    when sum(case when is_online then quantity else 0 end) > 0
     and sum(case when not is_online then quantity else 0 end) > 0 then 'mix'
    when sum(case when is_online then quantity else 0 end) > 0     then 'online'
    else 'offline'
  end                                                as channel
from report_ro.v_pos_order_items
where is_closed and not is_voided
group by store_id, biz_date, menu_item_id;


-- ─────────────────────────────────────────────────────────────────────────
-- B5 · 餐飲：桌台排行
--      v_pos_table_ranking（按日）
--      ⚠️ covers（覆蓋人數）需要 pos_orders.party_size，見 Part D
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_pos_table_ranking as
select
  store_id,
  biz_date,
  table_id,
  max(table_name)   as table_name,
  count(*)          as order_count,
  sum(total)        as revenue
from report_ro.v_pos_orders
where is_closed
group by store_id, biz_date, table_id;


-- ─────────────────────────────────────────────────────────────────────────
-- B6 · 餐飲：尖峰時段（每小時訂單數）
--      v_pos_hourly（按日 × 小時）
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_pos_hourly as
select
  store_id,
  biz_date,
  order_hour,
  count(*)   as order_count,
  sum(total) as revenue
from report_ro.v_pos_orders
where is_closed
group by store_id, biz_date, order_hour;


-- ─────────────────────────────────────────────────────────────────────────
-- B7 · 餐飲：低庫存預警
--      v_inv_low_stock（即時快照，唔分日期）
--      條件與前端一致：reorder_level > 0 AND current_qty <= reorder_level
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_inv_low_stock as
select
  store_id,
  id                                  as product_id,
  name,
  category,
  unit,
  current_qty,
  reorder_level,
  avg_unit_cost,
  (reorder_level - current_qty)       as shortfall,
  round(current_qty * avg_unit_cost, 2) as stock_value,
  last_purchase_date,
  last_supplier,
  updated_at
from public.inv_products
where reorder_level > 0
  and current_qty <= reorder_level;


-- ─────────────────────────────────────────────────────────────────────────
-- B8 · Salon：訂單級寬表（一張單一行）
--      v_salon_orders
--      付款方式已拆成 4 欄（cash / card / ledger_balance / external）
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_salon_orders as
select
  o.store_id,
  o.id                                                as order_id,
  o.order_no,
  o.booking_id,
  o.customer_id,
  o.customer_name,
  o.staff_id,
  o.station_id,
  o.status,
  (o.status = 'settled')                              as is_settled,
  o.subtotal,
  o.discount_amount,
  o.total,
  o.tip_total,
  o.grand_total,
  o.deposit_applied,
  o.change_due,
  o.started_at,
  o.completed_at,
  o.settled_at,
  o.created_at,
  o.updated_at,
  o.ledger_order_id,
  ((coalesce(o.settled_at, o.created_at) at time zone 'Asia/Macau')::date) as biz_date,
  pay.payment_cash,
  pay.payment_card,
  pay.payment_ledger_balance,
  pay.payment_external,
  ia.service_qty,
  ia.service_amount,
  ia.product_qty,
  ia.product_amount
from public.salon_orders o
left join lateral (
  select
    coalesce(sum(case when p ->> 'method' = 'cash'           then (p ->> 'amount')::numeric end), 0) as payment_cash,
    coalesce(sum(case when p ->> 'method' = 'card'           then (p ->> 'amount')::numeric end), 0) as payment_card,
    coalesce(sum(case when p ->> 'method' = 'ledger_balance' then (p ->> 'amount')::numeric end), 0) as payment_ledger_balance,
    coalesce(sum(case when p ->> 'method' = 'external'       then (p ->> 'amount')::numeric end), 0) as payment_external
  from jsonb_array_elements(
    case when jsonb_typeof(o.payments) = 'array' then o.payments else '[]'::jsonb end
  ) as p
) as pay on true
left join lateral (
  select
    coalesce(sum(case when i ->> 'kind' = 'service' then coalesce((i ->> 'quantity')::numeric, 0) end), 0) as service_qty,
    coalesce(sum(case when i ->> 'kind' = 'service' then coalesce((i ->> 'quantity')::numeric, 0)
                                                        * coalesce((i ->> 'unitPrice')::numeric, 0) end), 0) as service_amount,
    coalesce(sum(case when i ->> 'kind' = 'product' then coalesce((i ->> 'quantity')::numeric, 0) end), 0) as product_qty,
    coalesce(sum(case when i ->> 'kind' = 'product' then coalesce((i ->> 'quantity')::numeric, 0)
                                                        * coalesce((i ->> 'unitPrice')::numeric, 0) end), 0) as product_amount
  from jsonb_array_elements(
    case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
  ) as i
) as ia on true;


-- ─────────────────────────────────────────────────────────────────────────
-- B9 · Salon：明細寬表（一條明細一行）
--      v_salon_order_items
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_salon_order_items as
select
  o.store_id,
  o.id                                            as order_id,
  o.order_no,
  ((coalesce(o.settled_at, o.created_at) at time zone 'Asia/Macau')::date) as biz_date,
  (o.status = 'settled')                          as is_settled,
  (i ->> 'kind')                                  as kind,          -- 'service' | 'product'
  (i ->> 'itemId')                                as item_id,
  (i ->> 'name')                                  as item_name,
  (i ->> 'serviceItemId')                         as service_item_id,
  (i ->> 'staffId')                               as staff_id,
  (i ->> 'staffName')                             as staff_name,
  coalesce((i ->> 'quantity')::numeric, 0)        as quantity,
  coalesce((i ->> 'unitPrice')::numeric, 0)       as unit_price,
  coalesce((i ->> 'quantity')::numeric, 0)
    * coalesce((i ->> 'unitPrice')::numeric, 0)   as amount,
  coalesce((i ->> 'wageAmount')::numeric, 0)      as wage_amount,
  coalesce((i ->> 'commissionAmount')::numeric, 0) as commission_amount
from public.salon_orders o
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
) as i;


-- ─────────────────────────────────────────────────────────────────────────
-- B10 · Salon：小費明細（一筆小費一行）
--       v_salon_tips
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_salon_tips as
select
  o.store_id,
  o.id                                    as order_id,
  o.order_no,
  ((coalesce(o.settled_at, o.created_at) at time zone 'Asia/Macau')::date) as biz_date,
  (t ->> 'staffId')                       as staff_id,
  (t ->> 'staffName')                     as staff_name,
  coalesce((t ->> 'amount')::numeric, 0)  as amount,
  (t ->> 'method')                        as method      -- 'cash' | 'ledger_balance'
from public.salon_orders o
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(o.tips) = 'array' then o.tips else '[]'::jsonb end
) as t
where o.status = 'settled';


-- ─────────────────────────────────────────────────────────────────────────
-- B11 · Salon：每日總結 + 付款方式拆分
--       v_salon_daily_summary
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_salon_daily_summary as
select
  store_id,
  biz_date,
  count(*)                          as order_count,
  sum(grand_total)                  as revenue,
  sum(discount_amount)              as discount_amount,
  sum(deposit_applied)              as deposit_applied,
  sum(tip_total)                    as tip_total,
  sum(payment_cash)                 as payment_cash,
  sum(payment_card)                 as payment_card,
  sum(payment_ledger_balance)       as payment_ledger_balance,
  sum(payment_external)             as payment_external,
  sum(service_amount)               as service_amount,
  sum(product_amount)               as product_amount,
  case when count(*) > 0 then sum(grand_total) / count(*) end as avg_ticket
from report_ro.v_salon_orders
where is_settled
group by store_id, biz_date;


-- ─────────────────────────────────────────────────────────────────────────
-- B12 · Salon：技師業績 / 小費排行（按日）
--       v_salon_staff_daily
--
-- ⚠️ 對齊前端語義：staffSales 係「所有 kind（服務 + 產品）」有 staffId 嘅明細
--    金額總和（unitPrice × quantity），唔係淨服務。前端 Section 標題叫
--    「技師業績（服務營業額）」，但實際計算含產品，此 View 沿用同一口徑。
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_salon_staff_daily as
select
  store_id,
  biz_date,
  staff_id,
  max(staff_name)   as staff_name,
  sum(amount)       as sales_amount,
  sum(wage_amount)  as wage_amount
from report_ro.v_salon_order_items
where is_settled and staff_id is not null
group by store_id, biz_date, staff_id;

create or replace view report_ro.v_salon_tips_daily as
select
  store_id,
  biz_date,
  staff_id,
  max(staff_name)     as staff_name,
  sum(amount)         as tip_amount,
  sum(case when method = 'cash' then amount else 0 end)           as tip_cash,
  sum(case when method = 'ledger_balance' then amount else 0 end) as tip_ledger_balance
from report_ro.v_salon_tips
group by store_id, biz_date, staff_id;


-- ─────────────────────────────────────────────────────────────────────────
-- B13 · Salon：服務銷量（按日 × 項目名）
--       v_salon_service_ranking
--
-- ⚠️ 對齊前端語義：前端 serviceRank 用 it.name 分組、quantity 加總，
--    含 kind='product' 的項目。此 View 一併提供 kind 欄供自行拆分。
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_salon_service_ranking as
select
  store_id,
  biz_date,
  item_name,
  kind,
  sum(quantity)   as total_qty,
  sum(amount)     as total_amount
from report_ro.v_salon_order_items
where is_settled
group by store_id, biz_date, item_name, kind;


-- ─────────────────────────────────────────────────────────────────────────
-- B14 · Salon：套票使用率（按購買日 × 套票模板）
--       v_salon_package_usage
--
-- 口徑：
--   total_sessions   = 模板 items[].sessions 總和（購買時快照嘅「原本總次數」）
--   remaining_sum    = 客戶套票卡 remaining[].sessionsLeft 總和
--   used_sessions    = greatest(0, total_sessions - remaining_sum)
--   usage_rate       = used_sessions / total_sessions
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_salon_package_usage as
with pkg as (
  select
    p.store_id,
    p.id            as package_id,
    p.template_id,
    p.template_name,
    p.price,
    p.status,
    ((p.purchased_at at time zone 'Asia/Macau')::date) as purchase_date,
    coalesce((
      select sum(coalesce((ti ->> 'sessions')::numeric, 0))
      from jsonb_array_elements(
        case when jsonb_typeof(tpl.items) = 'array' then tpl.items else '[]'::jsonb end
      ) as ti
    ), 0) as total_sessions,
    coalesce((
      select sum(coalesce((ri ->> 'sessionsLeft')::numeric, 0))
      from jsonb_array_elements(
        case when jsonb_typeof(p.remaining) = 'array' then p.remaining else '[]'::jsonb end
      ) as ri
    ), 0) as remaining_sessions
  from public.salon_customer_packages p
  left join public.salon_package_templates tpl
    on tpl.id = p.template_id and tpl.store_id = p.store_id
)
select
  store_id,
  purchase_date,
  template_id,
  max(template_name)                                        as template_name,
  count(*)                                                  as sold_count,
  sum(price)                                                as sales_amount,
  sum(total_sessions)                                       as total_sessions,
  sum(remaining_sessions)                                   as remaining_sessions,
  greatest(0, sum(total_sessions) - sum(remaining_sessions)) as used_sessions,
  case when sum(total_sessions) > 0
       then greatest(0, sum(total_sessions) - sum(remaining_sessions))
            / sum(total_sessions) end                       as usage_rate
from pkg
group by store_id, purchase_date, template_id;


-- ─────────────────────────────────────────────────────────────────────────
-- B15 · Salon：即將到期套票（30 日內 · 催銷）
--       v_salon_expiring_packages
--
-- 資料最小化：只暴露客戶姓名（前端報表顯示嘅欄位），**唔**暴露電話 / 生日 /
--            偏好 / 病歷。底表 salon_customers 唔對 Ledger 授權。
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_salon_expiring_packages as
select
  p.store_id,
  p.id                                     as package_id,
  p.customer_id,
  c.name                                   as customer_name,
  p.template_id,
  p.template_name,
  p.expires_at,
  ceil(extract(epoch from (p.expires_at - now())) / 86400)::int as days_left,
  coalesce((
    select sum(coalesce((ri ->> 'sessionsLeft')::numeric, 0))
    from jsonb_array_elements(
      case when jsonb_typeof(p.remaining) = 'array' then p.remaining else '[]'::jsonb end
    ) as ri
  ), 0)                                    as remaining_sessions
from public.salon_customer_packages p
left join public.salon_customers c
  on c.id = p.customer_id and c.store_id = p.store_id
where p.status = 'active'
  and p.expires_at is not null
  and p.expires_at >= now()
  and p.expires_at <= now() + interval '30 days';


-- ─────────────────────────────────────────────────────────────────────────
-- B16 · 門店主數據（輔助對照）
--       v_pos_menu_items       餐飲菜牌（store × menuItemId → 名稱 / 類目 / 價）
--       v_pos_tables           餐飲枱位（store × tableId → 枱名 / 區域）
--       v_salon_staff          salon 技師（store × staffId → 姓名 / 花名 / 角色）
--       v_salon_service_items  salon 服務目錄
-- ─────────────────────────────────────────────────────────────────────────
create or replace view report_ro.v_pos_menu_items as
select
  b.store_id,
  b.store_name,
  b.currency,
  (m ->> 'id')        as menu_item_id,
  (m ->> 'name')      as menu_item_name,
  (m ->> 'categoryId') as category_id,
  (m ->> 'price')::numeric as price
from public.pos_bootstrap_config b
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(b.menu_items) = 'array' then b.menu_items else '[]'::jsonb end
) as m;

create or replace view report_ro.v_pos_tables as
select
  b.store_id,
  (t ->> 'id')    as table_id,
  (t ->> 'name')  as table_name,
  (t ->> 'area')  as area,
  (t ->> 'floorId') as floor_id
from public.pos_bootstrap_config b
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(b.tables) = 'array' then b.tables else '[]'::jsonb end
) as t;

create or replace view report_ro.v_salon_staff as
select
  b.store_id,
  (s ->> 'id')        as staff_id,
  (s ->> 'name')      as staff_name,
  (s ->> 'nickname')  as nickname,
  (s ->> 'role')      as role,
  (s ->> 'active')::boolean as is_active
from public.salon_bootstrap_config b
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(b.staff) = 'array' then b.staff else '[]'::jsonb end
) as s;

create or replace view report_ro.v_salon_service_items as
select
  b.store_id,
  (s ->> 'id')            as service_item_id,
  (s ->> 'name')          as service_item_name,
  (s ->> 'categoryId')    as category_id,
  (s ->> 'price')::numeric     as price,
  (s ->> 'durationMinutes')::int as duration_minutes
from public.salon_bootstrap_config b
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(b.service_items) = 'array' then b.service_items else '[]'::jsonb end
) as s;


-- 補授權（覆蓋重跑情況：View 喺 default privileges 設定前已經存在）
grant select on all tables in schema report_ro to ledger_report_ro;


-- ═══════════════════════════════════════════════════════════════════════════
-- Part C · 驗收檢查（用 ledger_report_ro 連線執行，逐條確認）
-- ═══════════════════════════════════════════════════════════════════════════

-- C1. 確認身分同時區
-- select current_user, current_setting('TimeZone'), current_setting('transaction_read_only');
-- 預期：ledger_report_ro | Asia/Macau | on

-- C2. 確認讀得到
-- select count(*) from report_ro.v_pos_daily_summary;      -- 預期 ≥ 0，唔報 permission denied
-- select count(*) from report_ro.v_salon_daily_summary;

-- C3. 確認寫唔到（以下四條**全部必須報錯**）
-- insert into public.pos_orders (id) values ('ledger-write-test');
--   預期：ERROR: permission denied for table pos_orders
-- update public.inv_products set current_qty = 999 where store_id = 'x';
--   預期：ERROR: permission denied for table inv_products
-- delete from public.salon_orders where 1 = 0;
--   預期：ERROR: permission denied for table salon_orders
-- create table public.ledger_test (id int);
--   預期：ERROR: permission denied for schema public

-- C4. 確認睇唔到未授權表（必須報錯）
-- select count(*) from public.salon_customers;
--   預期：ERROR: permission denied for table salon_customers
-- select count(*) from public.pos_device_configs;
--   預期：ERROR: permission denied for table pos_device_configs

-- C5. 確認睇得到門店清單（store_id 係報表嘅必要過濾鍵）
-- select distinct store_id from report_ro.v_pos_orders order by 1;


-- ═══════════════════════════════════════════════════════════════════════════
-- Part D · 可選：補齊 pos_orders.party_size（覆蓋人數）
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 背景：前端報表嘅「覆蓋人數」／桌台 covers 用 PosOrder.partySize，
--       但 /api/pos/sync 冇把 partySize 寫上雲 → DB 無此欄 → 對接方查唔到。
--       見文檔 §6.1。
--
-- D-1（macau-pos 管理員執行）：加欄
--   alter table public.pos_orders add column if not exists party_size integer;
--   create index if not exists pos_orders_store_biz_idx
--     on public.pos_orders (store_id, ((coalesce(updated_at, created_at) at time zone 'Asia/Macau')::date));
--
-- D-2（macau-pos 工程師執行）：喺 src/app/api/pos/sync/route.ts 嘅 pos_orders upsert
--       加一行 `party_size: order.partySize ?? null,`，並喺
--       src/lib/pos/pos-order-mapper.ts 嘅 PosOrderRow / mapPosOrderRow 補
--       party_size / partySize。之後新單先有值，歷史單一律 NULL（無法回溯）。
--
-- D-3（欄位存在後執行）：建立覆蓋人數 View
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pos_orders' and column_name = 'party_size'
  ) then
    execute $ddl$
      create or replace view report_ro.v_pos_covers_daily as
      select
        o.store_id,
        ((coalesce(o.updated_at, o.created_at) at time zone 'Asia/Macau')::date) as biz_date,
        o.table_id,
        max(o.table_name)                as table_name,
        count(*)                         as order_count,
        sum(coalesce(o.party_size, 0))   as covers
      from public.pos_orders o
      where o.status in ('settled', 'partially_refunded', 'refunded')
      group by 1, 2, 3
    $ddl$;
    raise notice 'v_pos_covers_daily 已建立（pos_orders.party_size 存在）';
  else
    raise notice '跳過：pos_orders.party_size 尚未建立，覆蓋人數暫不可查（見文檔 §6.1）';
  end if;
end
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 撤銷 / 輪換（有需要時先跑）
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 改密碼：
--   alter role ledger_report_ro with password 'NEW_STRONG_PASSWORD';
--
-- 暫停存取（保留角色）：
--   alter role ledger_report_ro with nologin;
--   -- 恢復：alter role ledger_report_ro with login;
--
-- 踢走現有連線（改密碼 / 停用後建議執行）：
--   select pg_terminate_backend(pid)
--   from pg_stat_activity
--   where usename = 'ledger_report_ro' and pid <> pg_backend_pid();
--
-- 完全移除（會先刪 View，因為 View 依賴底表授權語意）：
--   drop schema if exists report_ro cascade;
--   revoke all privileges on all tables in schema public from ledger_report_ro;
--   revoke all privileges on schema public from ledger_report_ro;
--   revoke connect on database postgres from ledger_report_ro;
--   drop role if exists ledger_report_ro;
--
-- =============================================================================
