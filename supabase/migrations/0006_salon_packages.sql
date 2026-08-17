-- =============================================================================
-- Macau POS — Salon 套票 / 次卡（P1）
-- 執行方式：喺 Supabase SQL Editor 貼上執行一次（緊接 0005 之後）。
-- 對應前端：src/lib/salon/storage.ts（load/saveSalonPackage*）
--           src/app/api/salon/state.ts（拉取）
--           src/app/api/salon/sync.ts（PACKAGE_TEMPLATE_UPDATED / CUSTOMER_PACKAGE_UPDATED 寫入）
-- 命名空間：salon_*（與餐飲 pos_*、salon 其他表分隔）
-- 設計：次數額度（remaining / items）留 salon 本地；儲值 / 積分委託 Ledger。
-- =============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- 7. salon_package_templates（套票模板，店家後台建立一次可重複賣）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_package_templates (
  id            text primary key,
  store_id      text,
  name          text           not null default '',
  price         numeric(12,2)  not null default 0,
  validity_days integer        not null default 0,
  items         jsonb          not null default '[]'::jsonb,
  bonus_points  integer        not null default 0,
  bonus_balance numeric(12,2)  not null default 0,
  note          text,
  active        boolean        not null default true,
  created_at    timestamptz    not null default now(),
  updated_at    timestamptz    not null default now()
);
create index if not exists salon_package_templates_store_id_idx on public.salon_package_templates (store_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 8. salon_customer_packages（客戶持有的套票卡，購買後生成）
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.salon_customer_packages (
  id            text primary key,
  store_id      text,
  customer_id   text,
  template_id   text,
  template_name text,
  price         numeric(12,2)  not null default 0,
  purchased_at  timestamptz,
  expires_at    timestamptz,
  remaining     jsonb          not null default '[]'::jsonb,
  status        text,
  payment_method text,
  note          text,
  created_at    timestamptz    not null default now(),
  updated_at    timestamptz    not null default now()
);
create index if not exists salon_customer_packages_store_id_idx    on public.salon_customer_packages (store_id);
create index if not exists salon_customer_packages_customer_id_idx on public.salon_customer_packages (customer_id);

-- ───────────────────────────────────────────────────────────────────────────
-- RLS：POS Supabase 金鑰為 server-only（service role 繞過 RLS），
-- 此處開啟 RLS 並給 permissive policy 作防禦（沿用 0005 模式）。
-- ───────────────────────────────────────────────────────────────────────────
alter table public.salon_package_templates  enable row level security;
alter table public.salon_customer_packages  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['salon_package_templates','salon_customer_packages'] loop
    execute format(
      'drop policy if exists %I on public.%I;
       create policy %I on public.%I for all using (true) with check (true);',
      t || '_allow_all', t, t || '_allow_all', t
    );
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- SEED：示範套票模板（與 src/lib/salon/mock-data.ts defaultSalonPackageTemplates 對齊）
-- 客戶套票卡為銷售數據，開機由前端種入後經 /api/salon/sync 自動上雲，此處不預置。
-- ───────────────────────────────────────────────────────────────────────────
insert into public.salon_package_templates (
  id, store_id, name, price, validity_days, items, bonus_points, bonus_balance, note, active, created_at, updated_at
) values
  ('pkg-facial-10','demo-salon-001','面部 10 次豪華套票',6800,180,
   $$[{"serviceItemId":"srv-hydrating-facial","sessions":10},{"serviceItemId":"srv-shoulder-massage","sessions":2}]$$::jsonb,
   500,0,'含 2 次肩頸按摩 + 贈 500 積分',true,'2026-08-14T00:00:00+08:00','2026-08-14T00:00:00+08:00'),
  ('pkg-gel-5','demo-salon-001','凝膠美甲 5 次套票',1500,90,
   $$[{"serviceItemId":"srv-gel-manicure","sessions":5}]$$::jsonb,
   100,0,'效期 90 天',true,'2026-08-14T00:00:00+08:00','2026-08-14T00:00:00+08:00')
on conflict (id) do nothing;
