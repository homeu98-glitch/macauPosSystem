-- 0025: 清理死数据 + 确保 admin 登录账号（重建 admin 管理页面前置）
-- ---------------------------------------------------------------------------
-- 对应需求：「重新构建整个 admin 管理页面」第一步 ——
--   先清干净数据库中先前遗留的无效账号（macau-store-a / macau-store-b 等死数据），
--   再确保 admin 登录账号 60000000 / PIN 0000 存在并可正常登录。
--
-- 动作：
--   1. 确保 3 个默认权限组存在（admin-full / store-manager / cashier-basic，固定 UUID）。
--   2. 删死 store：macau-store-a / macau-store-b（mock，唔对应真实 Ledger merchant）
--      + 级联删对应 admin_account_store_bindings。
--   3. 删遗留测试账号：63936541（店長）/ 63936542（收銀）。
--      —— 呢两个系 seed 测试账号，绑定在已删嘅死 store 上，属「先前遗留的无效账号」。
--         如你想保留测试账号自行建立，注释掉第 3) 段即可；之后可用 admin 管理页重建。
--   4. 确保 admin 登录账号存在：60000000 / PIN 0000（role=admin, manageAccounts=true），幂等 upsert。
--
-- 安全：幂等（on conflict do update / do nothing），可重跑。删 store/账号用固定 id 列表，唔会误删。
-- 注意：无 begin/commit（supabase runner 整文件包 transaction）。
-- ---------------------------------------------------------------------------

-- 1) 权限组（固定 UUID，供 60000000 引用 admin-full）
insert into admin_permission_groups (id, code, name, role, permissions, note)
values
  ('11111111-1111-1111-1111-111111111111', 'admin-full', '管理員全權', 'admin', '{"refundOrder":true,"voidItem":true,"manageAccounts":true}', '可管理帳戶、退款、退菜'),
  ('22222222-2222-2222-2222-222222222222', 'store-manager', '店長權限', 'manager', '{"refundOrder":true,"voidItem":true,"manageAccounts":false}', '門店管理權限'),
  ('33333333-3333-3333-3333-333333333333', 'cashier-basic', '收銀權限', 'cashier', '{"refundOrder":false,"voidItem":false,"manageAccounts":false}', '基本收銀權限')
on conflict (code) do update set
  name = excluded.name,
  role = excluded.role,
  permissions = excluded.permissions,
  note = excluded.note,
  updated_at = now();

-- 2) 删死 store + 级联 bindings
delete from admin_account_store_bindings where store_id in ('macau-store-a', 'macau-store-b');
delete from admin_stores where id in ('macau-store-a', 'macau-store-b');

-- 3) 删遗留测试账号（保留 60000000 总管理账号）
delete from admin_account_users where account in ('63936541', '63936542');

-- 4) 确保 admin 账号 60000000 / 0000 存在（幂等 upsert，跑几次都一样）
insert into admin_account_users (account, pin_code, name, role, active, permission_group_id, note, created_at, updated_at)
values ('60000000', '0000', '系統管理員', 'admin', true, '11111111-1111-1111-1111-111111111111', '總管理帳戶', now(), now())
on conflict (account) do update set
  pin_code = excluded.pin_code,
  name = excluded.name,
  role = excluded.role,
  active = excluded.active,
  permission_group_id = excluded.permission_group_id,
  note = excluded.note,
  updated_at = now();

-- 5) 【可选】插入真实门店（清理后 admin_stores 会系空表，管理页「门店绑定」无店可选。
--    拿到 Ledger merchant UUID 后（SQL: 于 Ledger DB 跑 select id, name from merchants;
--    或 POS 登入后 authSession.merchantId 就系），取消注释并填 UUID 再跑。
--    id 建议直接用 merchant UUID，与 0024 admin_stores.merchant_id 体系一致，
--    admin 账号绑定门店同 POS 店铺就系同一套 ID。
-- insert into admin_stores (id, name, active, note)
-- values
--   ('<merchant-uuid-1>', '表嫂美食', true, '真實門店（Ledger merchant UUID）'),
--   ('<merchant-uuid-2>', '<第二間店名>', true, '真實門店（Ledger merchant UUID）')
-- on conflict (id) do update set
--   name = excluded.name,
--   active = excluded.active,
--   updated_at = now();
