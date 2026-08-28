-- 0013 · macau-pos 庫存表（inv_products / inv_stock_movements）
-- 配套客戶端：src/lib/inventory-products.ts（server-only helper）、
--             src/app/api/inventory/products/**（server service_role 讀寫）、
--             src/components/inventory/inventory-view.tsx（庫存表 section）
--
-- 設計：
-- - 僅在 macau-pos 自己的 Supabase 專案跑（SUPABASE_URL），不碰 expenseRecorder。
-- - store_id = Ledger merchantId（auth session 的 merchantId）。
-- - 來源：基於 expenseRecorder 收據/品項（receipt_items.name）做 sync-from-receipts 種子；
--   current_qty 首次同步 = 該品名累計採購量，之後由使用者在 UI 做「盤點」維護。
-- - avg_unit_cost：每次同步重算（receipt_items 單價 × 數量 的加權平均）。
-- - inv_stock_movements 只記「adjust（盤點）」，作為 current_qty 變動的稽核軌跡。
--
-- 全部 idempotent：create table if not exists / create index if not exists。

-- 1) 庫存品主檔
create table if not exists inv_products (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  name text not null,
  category text,
  unit text not null default 'unit',
  current_qty numeric(12,3) not null default 0,
  avg_unit_cost numeric(12,2) not null default 0,
  last_purchase_date date,
  last_supplier text,
  reorder_level numeric(12,3) not null default 0,
  note text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists inv_products_store_name_uniq
  on inv_products (store_id, lower(name));
create index if not exists inv_products_store_idx
  on inv_products (store_id);
create index if not exists inv_products_store_active_idx
  on inv_products (store_id) where is_active;

-- 2) 庫存異動流水（盤點稽核；cascade 刪 product 時一併清掉）
create table if not exists inv_stock_movements (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  product_id uuid not null references inv_products(id) on delete cascade,
  movement_type text not null,                -- 'adjust'
  prev_qty numeric(12,3),
  new_qty numeric(12,3) not null,
  delta numeric(12,3) not null,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists inv_movements_product_idx
  on inv_stock_movements (product_id);
create index if not exists inv_movements_store_idx
  on inv_stock_movements (store_id);

-- 3) updated_at 觸發器
create or replace function inv_touch_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists inv_products_touch on inv_products;
create trigger inv_products_touch
  before update on inv_products
  for each row execute function inv_touch_updated_at();