-- =============================================================================
-- Macau POS — Salon 縱向 POS DB 資料表（與餐飲共用同一個 POS Supabase 專案）
-- 執行方式：喺 Supabase SQL Editor 貼上執行一次。
-- 對應前端：src/app/api/salon/* + src/lib/salon/storage.ts
-- 命名空間：salon_*（與餐飲 pos_* 分隔）
-- =============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- 1. salon_bootstrap_config（店家主數據，jsonb 裝類目/項目/員工/房型）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_bootstrap_config (
  store_id                       text primary key,
  source_version                integer        not null default 1,
  store_name                     text           not null default '示範美容院',
  currency                       text           not null default 'MOP',
  service_categories             jsonb          not null default '[]'::jsonb,
  service_items                 jsonb          not null default '[]'::jsonb,
  staff                          jsonb          not null default '[]'::jsonb,
  stations                       jsonb          not null default '[]'::jsonb,
  calendar_slot_minutes         integer        not null default 30,
  deposit_enabled                boolean        not null default false,
  default_service_duration_minutes integer      not null default 60,
  updated_at                     timestamptz    not null default now()
);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. salon_bookings（預約）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_bookings (
  id                            text primary key,
  store_id                      text,
  booking_no                    text,
  source                        text,
  ledger_booking_id             text,
  ledger_order_id               text,
  customer_id                   text,
  customer_name                 text           not null default '',
  customer_phone                text           not null default '',
  staff_id                      text,
  station_id                    text,
  start_at                      timestamptz,
  end_at                        timestamptz,
  services                      jsonb          not null default '[]'::jsonb,
  deposit_amount                numeric(12,2),
  deposit_paid                  boolean,
  deposit_ledger_txn_id         text,
  status                        text,
  order_id                      text,
  notes                         text,
  internal_notes                text,
  created_at                    timestamptz    not null default now(),
  updated_at                    timestamptz    not null default now()
);
create index if not exists salon_bookings_store_id_idx on public.salon_bookings (store_id);
create index if not exists salon_bookings_status_idx    on public.salon_bookings (status);
create index if not exists salon_bookings_start_at_idx  on public.salon_bookings (start_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. salon_orders（結帳單）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_orders (
  id                            text primary key,
  store_id                      text,
  order_no                      text,
  booking_id                    text,
  customer_id                   text,
  customer_name                 text           not null default '',
  customer_phone                text           not null default '',
  staff_id                      text,
  station_id                    text,
  items                         jsonb          not null default '[]'::jsonb,
  subtotal                      numeric(12,2)  not null default 0,
  discount_amount               numeric(12,2)  not null default 0,
  service_charge_amount         numeric(12,2),
  tax_amount                    numeric(12,2),
  total                         numeric(12,2)  not null default 0,
  tips                          jsonb          not null default '[]'::jsonb,
  tip_total                     numeric(12,2)  not null default 0,
  grand_total                   numeric(12,2)  not null default 0,
  payments                      jsonb          not null default '[]'::jsonb,
  deposit_applied               numeric(12,2),
  change_due                    numeric(12,2),
  status                        text,
  notes                         text,
  started_at                    timestamptz,
  completed_at                  timestamptz,
  settled_at                    timestamptz,
  ledger_order_id               text,
  created_at                    timestamptz    not null default now(),
  updated_at                    timestamptz    not null default now()
);
create index if not exists salon_orders_store_id_idx on public.salon_orders (store_id);
create index if not exists salon_orders_status_idx   on public.salon_orders (status);
create index if not exists salon_orders_created_at_idx on public.salon_orders (created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. salon_customers（客戶檔案）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_customers (
  id                            text primary key,
  store_id                      text,
  name                          text           not null default '',
  phone                         text           not null default '',
  ledger_balance                numeric(12,2),
  ledger_points                 numeric(12,2),
  ledger_tier                   text,
  birthday                      text,
  gender                        text,
  tags                          jsonb          not null default '[]'::jsonb,
  skin_type                     text,
  hair_type                     text,
  allergies                     jsonb          not null default '[]'::jsonb,
  preferences                   text,
  formula_history               jsonb          not null default '[]'::jsonb,
  visit_count                   integer        not null default 0,
  last_visit_at                 text,
  total_spent                   numeric(12,2),
  updated_at                    timestamptz    not null default now()
);
create index if not exists salon_customers_store_id_idx on public.salon_customers (store_id);
create index if not exists salon_customers_phone_idx    on public.salon_customers (phone);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. salon_print_jobs（收據列印佇列）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_print_jobs (
  id                            text primary key,
  store_id                      text,
  order_id                      text,
  order_no                      text,
  station_name                  text,
  ticket_type                   text,
  printer_group                 text,
  printer_name                  text,
  items                         jsonb          not null default '[]'::jsonb,
  status                        text,
  created_at                    timestamptz    not null default now()
);
create index if not exists salon_print_jobs_store_id_idx on public.salon_print_jobs (store_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. salon_queue_events（同步審計 / 重放）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_queue_events (
  id                            text primary key,
  type                          text,
  entity_id                     text,
  payload                       jsonb,
  status                        text,
  created_at                    timestamptz    not null default now()
);
create index if not exists salon_queue_events_created_at_idx on public.salon_queue_events (created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- RLS：POS Supabase 金鑰為 server-only（service role 繞過 RLS），
-- 此處開啟 RLS 並給一條 permissive policy 作防禦（萬一 anon key 外洩）。
-- ───────────────────────────────────────────────────────────────────────────
alter table public.salon_bootstrap_config enable row level security;
alter table public.salon_bookings          enable row level security;
alter table public.salon_orders            enable row level security;
alter table public.salon_customers         enable row level security;
alter table public.salon_print_jobs         enable row level security;
alter table public.salon_queue_events       enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'salon_bootstrap_config','salon_bookings','salon_orders',
    'salon_customers','salon_print_jobs','salon_queue_events'
  ] loop
    execute format(
      'drop policy if exists %I on public.%I;
       create policy %I on public.%I for all using (true) with check (true);',
      t || '_allow_all', t, t || '_allow_all', t
    );
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- SEED：現有 mock 主數據（bootstrap 配置 + 5 個示範客戶）
-- 預約/訂單為運營數據，開機由 seedMockBookingsIfEmpty 種入後經 /api/salon/sync 自動上雲。
-- ───────────────────────────────────────────────────────────────────────────
insert into public.salon_bootstrap_config (
  store_id, source_version, store_name, currency,
  service_categories, service_items, staff, stations,
  calendar_slot_minutes, deposit_enabled, default_service_duration_minutes, updated_at
) values (
  'demo-salon-001', 1, '示範美容院', 'MOP',
  $$
  [
    {"id":"cat-face","name":"臉部護理","printerGroup":"station_face","sortOrder":1,"color":"#fda4af","active":true},
    {"id":"cat-body","name":"身體護理","printerGroup":"station_body","sortOrder":2,"color":"#fbbf24","active":true},
    {"id":"cat-spa","name":"SPA","printerGroup":"station_body","sortOrder":3,"color":"#a78bfa","active":true},
    {"id":"cat-nails","name":"美甲","printerGroup":"station_nails","sortOrder":4,"color":"#f472b6","active":true},
    {"id":"cat-lashes","name":"美睫","printerGroup":"station_lashes","sortOrder":5,"color":"#60a5fa","active":true},
    {"id":"cat-hair-removal","name":"脫毛","printerGroup":"station_face","sortOrder":6,"color":"#34d399","active":true},
    {"id":"cat-massage","name":"按摩","printerGroup":"station_body","sortOrder":7,"color":"#fb923c","active":true},
    {"id":"cat-slimming","name":"瘦身","printerGroup":"station_body","sortOrder":8,"color":"#94a3b8","active":true}
  ]
  $$::jsonb,
  $$
  [
    {"id":"srv-hydrating-facial","categoryId":"cat-face","name":"保濕臉部護理","description":"深層清潔 + 保濕面膜","price":480,"durationMinutes":60,"stationTypes":["bed"],"staffRoles":["therapist"],"active":true,"sortOrder":1},
    {"id":"srv-anti-aging-facial","categoryId":"cat-face","name":"抗老臉部護理","price":880,"durationMinutes":90,"stationTypes":["bed"],"staffRoles":["therapist"],"active":true,"sortOrder":2},
    {"id":"srv-body-scrub","categoryId":"cat-body","name":"身體磨砂","price":580,"durationMinutes":60,"stationTypes":["bed","room"],"staffRoles":["therapist"],"active":true,"sortOrder":1},
    {"id":"srv-aroma-spa","categoryId":"cat-spa","name":"香薰 SPA 90 分","price":980,"durationMinutes":90,"stationTypes":["bed","room"],"staffRoles":["therapist"],"active":true,"sortOrder":1},
    {"id":"srv-manicure","categoryId":"cat-nails","name":"基礎手部美甲","price":180,"durationMinutes":45,"stationTypes":["nail_table"],"staffRoles":["stylist","assistant"],"active":true,"sortOrder":1},
    {"id":"srv-gel-manicure","categoryId":"cat-nails","name":"凝膠美甲","price":380,"durationMinutes":75,"stationTypes":["nail_table"],"staffRoles":["stylist"],"active":true,"sortOrder":2},
    {"id":"srv-lash-extension","categoryId":"cat-lashes","name":"美睫嫁接","price":580,"durationMinutes":90,"stationTypes":["chair"],"staffRoles":["stylist"],"active":true,"sortOrder":1},
    {"id":"srv-underarm-wax","categoryId":"cat-hair-removal","name":"腋下脫毛","price":180,"durationMinutes":20,"stationTypes":["bed"],"staffRoles":["therapist"],"active":true,"sortOrder":1},
    {"id":"srv-shoulder-massage","categoryId":"cat-massage","name":"肩頸按摩 30 分","price":280,"durationMinutes":30,"stationTypes":["chair"],"staffRoles":["therapist"],"active":true,"sortOrder":1},
    {"id":"srv-body-contour","categoryId":"cat-slimming","name":"瘦身塑型 60 分","price":880,"durationMinutes":60,"stationTypes":["bed"],"staffRoles":["therapist"],"active":true,"sortOrder":1}
  ]
  $$::jsonb,
  $$
  [
    {"id":"staff-001","name":"小美","nickname":"美姐","role":"stylist","serviceCategoryIds":["cat-nails","cat-lashes"],"phone":"66881234","active":true,"hiredAt":"2024-03-01","createdAt":"2026-08-14T00:00:00+08:00","updatedAt":"2026-08-14T00:00:00+08:00"},
    {"id":"staff-002","name":"阿龍","nickname":"龍哥","role":"therapist","serviceCategoryIds":["cat-face","cat-body","cat-spa","cat-massage","cat-slimming","cat-hair-removal"],"phone":"66885678","active":true,"hiredAt":"2023-08-15","createdAt":"2026-08-14T00:00:00+08:00","updatedAt":"2026-08-14T00:00:00+08:00"},
    {"id":"staff-003","name":"小玲","nickname":"玲玲","role":"assistant","serviceCategoryIds":["cat-nails","cat-massage"],"phone":"66889012","active":true,"hiredAt":"2025-01-10","createdAt":"2026-08-14T00:00:00+08:00","updatedAt":"2026-08-14T00:00:00+08:00"}
  ]
  $$::jsonb,
  $$
  [
    {"id":"station-chair-1","name":"美甲椅 1","type":"nail_table","capacity":1,"location":"1 樓 美甲區","active":true,"sortOrder":1},
    {"id":"station-bed-1","name":"臉部護理床 1","type":"bed","capacity":1,"location":"1 樓 護理區","active":true,"sortOrder":2},
    {"id":"station-bed-2","name":"身體護理床 1","type":"bed","capacity":1,"location":"1 樓 SPA 房","active":true,"sortOrder":3},
    {"id":"station-room-vip","name":"VIP 房","type":"room","capacity":1,"location":"2 樓","active":true,"sortOrder":4}
  ]
  $$::jsonb,
  30, true, 60, '2026-08-14T00:00:00+08:00'
)
on conflict (store_id) do update set
  store_name = excluded.store_name,
  currency = excluded.currency,
  service_categories = excluded.service_categories,
  service_items = excluded.service_items,
  staff = excluded.staff,
  stations = excluded.stations,
  calendar_slot_minutes = excluded.calendar_slot_minutes,
  deposit_enabled = excluded.deposit_enabled,
  default_service_duration_minutes = excluded.default_service_duration_minutes,
  updated_at = excluded.updated_at;

insert into public.salon_customers (
  id, store_id, name, phone, ledger_balance, ledger_points, ledger_tier,
  birthday, gender, tags, skin_type, hair_type, allergies, preferences,
  formula_history, visit_count, last_visit_at, total_spent, updated_at
) values
  ('cust-001','demo-salon-001','林小姐','66883333',1200,3400,'金卡會員','1990-05-12','female',
   $$["VIP","敏感肌"]$$::jsonb,'sensitive','fine',$$["香料","酒精"]$$::jsonb,'喜歡安靜環境，怕癢',
   $$[{"date":"2026-06-15","service":"保濕臉部護理","formula":"溫和保濕精華 + 蘆薈","staffId":"staff-002","staffName":"阿龍"},{"date":"2026-07-20","service":"抗老臉部護理","formula":"視黃醇 0.3% + 神經醯胺","staffId":"staff-002","staffName":"阿龍"}]$$::jsonb,
   12,'2026-08-10',8650,'2026-08-14T00:00:00+08:00'),
  ('cust-002','demo-salon-001','王小姐','66881111',300,1200,'銀卡會員',null,'female',
   $$["美甲常客"]$$::jsonb,'combination',null,$$[]$$::jsonb,null,
   $$[]$$::jsonb,5,'2026-08-14',2400,'2026-08-14T00:00:00+08:00'),
  ('cust-003','demo-salon-001','張小姐','66884444',0,800,'普通會員',null,'female',
   $$[]$$::jsonb,null,'damaged',$$[]$$::jsonb,null,
   $$[]$$::jsonb,3,'2026-08-14',1740,'2026-08-14T00:00:00+08:00'),
  ('cust-004','demo-salon-001','陳先生','66882222',500,2100,'銀卡會員',null,'male',
   $$["SPA愛好者"]$$::jsonb,null,null,$$[]$$::jsonb,'力度要重一點',
   $$[]$$::jsonb,8,'2026-08-14',7840,'2026-08-14T00:00:00+08:00'),
  ('cust-005','demo-salon-001','黃先生','66885555',0,150,'普通會員',null,'male',
   $$[]$$::jsonb,null,null,$$[]$$::jsonb,null,
   $$[]$$::jsonb,1,'2026-08-14',280,'2026-08-14T00:00:00+08:00')
on conflict (id) do nothing;
