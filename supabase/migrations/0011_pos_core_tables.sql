-- 0011 · macau-pos 核心 POS 表（自給自足 schema 真源）
-- 配套客戶端：src/lib/pos/use-pos-realtime.ts（收銀 realtime 訂閱）、
--             src/app/api/pos/sync|state|orders|bootstrap|device-config/route.ts（server service_role 讀寫）
--
-- 設計要求：Kiosk 落單→收銀秒級見單，禁用 polling（15s 輪詢只係 fallback）。
-- 實現：pos_orders / pos_print_jobs / pos_soldout 加入 supabase_realtime publication，
--       收銀用 anon key 訂閱（postgres_changes, filter store_id）。落單寫入一律經
--       /api/pos/sync（server service_role，繞過 RLS）。
--
-- ⚠️ 重要更正（2026-08-22）：呢啲 `pos_*` 表全部屬 **macau-pos 自己嘅 Supabase 項目**，
--    由本 repo 嘅 migrations 建立，**唔係** Ledger。所有操作都係 macau-pos 發起。
--
-- 全部 idempotent（create table if not exists / create policy if not exists / DO block 查
-- pg_publication_tables + to_regclass 守門），所以：
--   - 喺已經有呢啲表嘅 existing DB 上跑 → 表建立變 no-op，realtime/RLS 係幂等重複套用，安全；
--   - 喺 fresh DB 上跑 → 完整建立晒 7 張表 + realtime + RLS。
-- 建議順序：0010（建 pos_soldout DDL）→ 0011（建其餘表 + realtime + RLS）。
-- 注意：0011 自己都會再 `create table if not exists pos_soldout` 做雙保險，避免漏跑 0010。

-- ───────────────────────────────────────────────────────────
-- 1) 建立七張 POS 表（idempotent）
-- ───────────────────────────────────────────────────────────

-- 落單隊列事件（sync / state 用）
create table if not exists pos_queue_events (
  id text primary key,
  type text,
  entity_id text,
  payload jsonb,
  status text,
  created_at timestamptz
);
create index if not exists pos_queue_events_created_idx on pos_queue_events (created_at);

-- 訂單主表（realtime 訂閱 + 15s 輪詢）
create table if not exists pos_orders (
  id text primary key,
  local_order_no text,
  store_id text,
  table_id text,
  table_name text,
  status text,
  fulfillment_status text,
  items jsonb,
  order_note text,
  subtotal numeric default 0,
  tax_amount numeric default 0,
  service_charge_amount numeric default 0,
  discount_amount numeric default 0,
  total numeric default 0,
  prepaid_amount numeric default 0,
  online_order_id text,
  payment_method text,
  created_at timestamptz,
  updated_at timestamptz
);
create index if not exists pos_orders_store_idx on pos_orders (store_id);
create index if not exists pos_orders_updated_idx on pos_orders (updated_at);

-- 廚房 / 收銀列印任務（realtime 訂閱）
create table if not exists pos_print_jobs (
  id text primary key,
  store_id text,
  order_id text,
  order_no text,
  table_name text,
  ticket_type text,
  printer_group text,
  printer_name text,
  items jsonb,
  status text,
  created_at timestamptz
);
create index if not exists pos_print_jobs_store_idx on pos_print_jobs (store_id);
create index if not exists pos_print_jobs_created_idx on pos_print_jobs (created_at);

-- 店鋪開台設定 / 餐牌 / 枱位 / 打印機群（server service_role 讀寫）
create table if not exists pos_bootstrap_config (
  store_id text primary key,
  source_version integer default 1,
  store_name text,
  currency text,
  categories jsonb,
  menu_items jsonb,
  tables jsonb,
  rules jsonb,
  printer_groups jsonb,
  updated_at timestamptz
);
create index if not exists pos_bootstrap_config_updated_idx on pos_bootstrap_config (updated_at);

-- 設備設定（state / device-config 用，server service_role 讀寫）
create table if not exists pos_device_configs (
  device_id text primary key,
  store_id text,
  terminal_name text,
  printers jsonb,
  local_settings jsonb,
  updated_at timestamptz
);
create index if not exists pos_device_configs_store_idx on pos_device_configs (store_id);

-- pos_soldout 雙保險（0010 已建，呢度再 if not exists 一次）
create table if not exists pos_soldout (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  menu_item_id text not null,
  sold_out boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (store_id, menu_item_id)
);
create index if not exists pos_soldout_store_idx on pos_soldout (store_id);

-- ───────────────────────────────────────────────────────────
-- 2) 加入 Realtime publication（idempotent，存在先加）
-- ⚠️ `ALTER PUBLICATION ... ADD TABLE` 唔支援 `IF NOT EXISTS`（PostgreSQL 語法限制），
--    用 DO block 先查 pg_publication_tables 判斷未入先加；to_regclass 守門確認表存在。
-- ───────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['pos_orders', 'pos_print_jobs', 'pos_soldout'] loop
    if to_regclass('public.' || t) is not null
       and not exists (
         select 1
         from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = t
       ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────
-- 3) RLS：收銀 Realtime 訂閱需要 anon 有 SELECT
--    落單內容屬營運資料（枱號 / 項目 / 金額），無客人 PII，故允許 anon 讀取。
--    ⚠️ 多租戶隔離：現行 using (true) 會暴露所有店；上線前應改為
--       using (store_id = current_setting('request.headers')::json->>'x-store-id') 之類嘅店級過濾。
--       寫入只可由 service_role（/api/pos/sync）處理；anon 唔使寫入權限。
-- ───────────────────────────────────────────────────────────
alter table pos_orders enable row level security;
alter table pos_print_jobs enable row level security;
alter table pos_soldout enable row level security;

drop policy if exists "pos_orders anon read" on pos_orders;
create policy "pos_orders anon read" on pos_orders for select to anon using (true);

drop policy if exists "pos_print_jobs anon read" on pos_print_jobs;
create policy "pos_print_jobs anon read" on pos_print_jobs for select to anon using (true);

drop policy if exists "pos_soldout anon read" on pos_soldout;
create policy "pos_soldout anon read" on pos_soldout for select to anon using (true);

grant select on pos_orders to anon;
grant select on pos_print_jobs to anon;
grant select on pos_soldout to anon;
