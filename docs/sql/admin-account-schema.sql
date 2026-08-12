create extension if not exists pgcrypto;

create table if not exists admin_stores (
  id text primary key,
  name text not null,
  active boolean not null default true,
  note text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists admin_permission_groups (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  role text not null check (role in ('admin', 'manager', 'cashier')),
  permissions jsonb not null default '{}'::jsonb,
  note text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists admin_account_users (
  id uuid primary key default gen_random_uuid(),
  account text not null unique,
  pin_code text not null,
  name text not null,
  role text not null check (role in ('admin', 'manager', 'cashier')),
  active boolean not null default true,
  permission_group_id uuid references admin_permission_groups(id) on delete set null,
  note text default '',
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists admin_account_store_bindings (
  account_id uuid not null references admin_account_users(id) on delete cascade,
  store_id text not null references admin_stores(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (account_id, store_id)
);

create index if not exists idx_admin_account_users_account on admin_account_users(account);
create index if not exists idx_admin_account_users_role on admin_account_users(role);
create index if not exists idx_admin_account_store_bindings_store on admin_account_store_bindings(store_id);

insert into admin_stores (id, name, active, note)
values
  ('macau-store-a', '澳門店 A', true, '預設主門店'),
  ('macau-store-b', '澳門店 B', true, '分店示例')
on conflict (id) do update
set name = excluded.name,
    active = excluded.active,
    note = excluded.note,
    updated_at = now();

insert into admin_permission_groups (id, code, name, role, permissions, note)
values
  ('11111111-1111-1111-1111-111111111111', 'admin-full', '管理員全權', 'admin', '{"refundOrder":true,"voidItem":true,"manageAccounts":true}', '可管理帳戶、退款、退菜'),
  ('22222222-2222-2222-2222-222222222222', 'store-manager', '店長權限', 'manager', '{"refundOrder":true,"voidItem":true,"manageAccounts":false}', '門店管理權限'),
  ('33333333-3333-3333-3333-333333333333', 'cashier-basic', '收銀權限', 'cashier', '{"refundOrder":false,"voidItem":false,"manageAccounts":false}', '基本收銀權限')
on conflict (code) do update
set name = excluded.name,
    role = excluded.role,
    permissions = excluded.permissions,
    note = excluded.note,
    updated_at = now();

insert into admin_account_users (account, pin_code, name, role, active, permission_group_id, note)
values
  ('60000000', '0000', '系統管理員', 'admin', true, '11111111-1111-1111-1111-111111111111', '總管理帳戶'),
  ('63936541', '1234', '店長', 'manager', true, '22222222-2222-2222-2222-222222222222', '門店管理帳戶'),
  ('63936542', '1234', '收銀員', 'cashier', true, '33333333-3333-3333-3333-333333333333', '前台收銀帳戶')
on conflict (account) do update
set pin_code = excluded.pin_code,
    name = excluded.name,
    role = excluded.role,
    active = excluded.active,
    permission_group_id = excluded.permission_group_id,
    note = excluded.note,
    updated_at = now();

insert into admin_account_store_bindings (account_id, store_id)
select u.id, 'macau-store-a'
from admin_account_users u
where u.account in ('63936541', '63936542')
on conflict do nothing;

insert into admin_account_store_bindings (account_id, store_id)
select u.id, s.store_id
from admin_account_users u
cross join (values ('macau-store-a'), ('macau-store-b')) as s(store_id)
where u.account = '60000000'
on conflict do nothing;
