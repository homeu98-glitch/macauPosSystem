-- =============================================================================
-- Macau POS — Salon 縱向（F1–F5 新功能）所需 SQL
-- 執行方式：喺 Supabase SQL Editor 貼上執行一次（idempotent）。
-- 對應前端：src/lib/salon/*（員工工錢/級別、賣產品、員工放假/上班時段、檔案號碼）
-- 命名空間：salon_*（與餐飲 pos_* 分隔）
--
-- 注意：本 migration 補齊「表 / 欄位」；雲端同步寫入已喺
--       src/app/api/salon/sync/route.ts 處理（PRODUCT_SALE_CREATED / STAFF_LEAVE_UPDATED
--       / STAFF_SHIFT_UPDATED upsert + BOOTSTRAP_UPDATED 帶 products / staff_level_multipliers
--       + CUSTOMER_UPDATED 帶 file_number）。
--       純 offline / mock 模式完全唔使本 migration。
-- =============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- 1. salon_products（產品目錄；F4 賣產品）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_products (
  id             text           primary key,
  store_id       text,
  name           text           not null default '',
  category       text,
  price          numeric(12,2)  not null default 0,
  cost           numeric(12,2),
  commission_rate numeric(5,2)   not null default 0,
  active         boolean        not null default true,
  sort_order     integer        not null default 0,
  updated_at     timestamptz    not null default now()
);
create index if not exists salon_products_store_id_idx on public.salon_products (store_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. salon_product_sales（產品銷售記錄；F4）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_product_sales (
  id               text           primary key,
  store_id         text,
  product_id       text,
  product_name     text           not null default '',
  price            numeric(12,2)  not null default 0,
  commission_rate  numeric(5,2)   not null default 0,
  commission_amount numeric(12,2) not null default 0,
  staff_id         text,
  staff_name       text,
  customer_id      text,
  customer_name    text,
  payment_method   text,
  sold_at          timestamptz,
  note             text,
  created_at       timestamptz    not null default now()
);
create index if not exists salon_product_sales_store_id_idx on public.salon_product_sales (store_id);
create index if not exists salon_product_sales_sold_at_idx on public.salon_product_sales (sold_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. salon_staff_leaves（員工放假記錄；F2）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_staff_leaves (
  id         text           primary key,
  store_id   text,
  staff_id   text,
  start_date text,  -- ISO date YYYY-MM-DD（start 非保留字，保留；end 係 PostgreSQL 保留字故改 end_date）
  end_date   text,  -- ISO date YYYY-MM-DD
  reason     text,
  created_at timestamptz    not null default now()
);
create index if not exists salon_staff_leaves_staff_id_idx on public.salon_staff_leaves (staff_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. salon_staff_shifts（員工上班時段記錄；F2）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_staff_shifts (
  id         text           primary key,
  store_id   text,
  staff_id   text,
  date       text,  -- ISO date YYYY-MM-DD
  start_time text,  -- HH:MM（start 非保留字；end 係保留字故改 end_time）
  end_time   text,  -- HH:MM
  note       text,
  created_at timestamptz    not null default now()
);
create index if not exists salon_staff_shifts_staff_id_idx on public.salon_staff_shifts (staff_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. salon_customers.file_number（檔案號碼；F5）
-- ───────────────────────────────────────────────────────────────────────────
alter table public.salon_customers add column if not exists file_number text;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. salon_bootstrap_config 擴展（products 目錄 + 級別工錢倍率；F3/F4）
--    code 會將 products 雙寫入 bootstrap（見 storage.ts saveSalonProducts），
--    所以呢度加 jsonb 欄令雲端 bootstrap upsert 一併帶走。
-- ───────────────────────────────────────────────────────────────────────────
alter table public.salon_bootstrap_config
  add column if not exists products jsonb not null default '[]'::jsonb;

alter table public.salon_bootstrap_config
  add column if not exists staff_level_multipliers jsonb not null
    default '{"junior":1,"senior":1.3,"master":1.6}'::jsonb;

-- ───────────────────────────────────────────────────────────────────────────
-- RLS：新表開啟 RLS + permissive allow_all（與 0005 一致，server-only service role 繞過）
-- ───────────────────────────────────────────────────────────────────────────
alter table public.salon_products      enable row level security;
alter table public.salon_product_sales enable row level security;
alter table public.salon_staff_leaves  enable row level security;
alter table public.salon_staff_shifts  enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'salon_products','salon_product_sales','salon_staff_leaves','salon_staff_shifts'
  ] loop
    execute format(
      'drop policy if exists %I on public.%I;
       create policy %I on public.%I for all using (true) with check (true);',
      t || '_allow_all', t, t || '_allow_all', t
    );
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- SEED：示範店產品目錄（與 src/lib/salon/mock-data.ts DEFAULT_SALON_PRODUCTS 一致）
-- ───────────────────────────────────────────────────────────────────────────
insert into public.salon_products (id, store_id, name, category, price, cost, commission_rate, active, sort_order)
values
  ('prod-moisturizer','demo-salon-001','保濕精華 30ml','護膚',320,120,10,true,1),
  ('prod-serum','demo-salon-001','抗老血清 15ml','護膚',580,220,12,true,2),
  ('prod-nail-oil','demo-salon-001','指甲營養油','美甲',90,30,8,true,3),
  ('prod-lash-care','demo-salon-001','睫毛養護液','美睫',150,55,10,true,4)
on conflict (id) do nothing;

-- 令示範店 bootstrap 同樣帶齊 products + 級別倍率（與 code 雙寫一致）
update public.salon_bootstrap_config
set
  products = '[
    {"id":"prod-moisturizer","name":"保濕精華 30ml","category":"護膚","price":320,"cost":120,"commissionRate":10,"active":true,"sortOrder":1},
    {"id":"prod-serum","name":"抗老血清 15ml","category":"護膚","price":580,"cost":220,"commissionRate":12,"active":true,"sortOrder":2},
    {"id":"prod-nail-oil","name":"指甲營養油","category":"美甲","price":90,"cost":30,"commissionRate":8,"active":true,"sortOrder":3},
    {"id":"prod-lash-care","name":"睫毛養護液","category":"美睫","price":150,"cost":55,"commissionRate":10,"active":true,"sortOrder":4}
  ]'::jsonb,
  staff_level_multipliers = '{"junior":1,"senior":1.3,"master":1.6}'::jsonb
where store_id = 'demo-salon-001';
