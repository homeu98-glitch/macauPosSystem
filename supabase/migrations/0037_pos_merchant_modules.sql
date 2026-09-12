-- 0037 · pos_merchant_modules（商戶模組授權，per-store 一店一行）
--
-- 對應「登入流程改版：先登入 → 後選工作台」：
--   以前「快餐 / 堂食 / 美容 / 自助點餐機 / 後廚屏 / 出餐台屏」嘅選擇器擺喺**登入頁**，
--   即「未證明身份就揀咗要做咩」，而且 6 個模式**人人見到**，包括商戶根本冇買嘅。
--   改為登入成功之後先揀，而且只列 Admin 後台已開通嘅模組。
--
-- 本表就係「已開通」嘅真源：
--   workbenches      = 登入後「選擇工作台」頁會顯示邊幾張卡（未開通嘅灰住 + 🔒）
--   sidebar_modules  = 入到收銀台之後，左邊側欄顯示邊幾個（點餐 / 訂單 / 會員 / …）
--
-- 設計要點（照抄 0027 pos_print_templates / 0028 pos_note_presets 已驗證嘅模式）：
--   - store_id = 登入 merchant UUID（同 pos_orders.store_id / pos_shifts.store_id 口徑一致）。
--   - 一店一行 → 多終端共享同一份授權，唔會互相覆蓋。
--   - 唔加 FK / 唔做 cascade：店舖刪除係上層業務（同 pos_shifts / pos_print_templates）。
--   - 寫入一律經 server service_role（/api/admin/merchants/modules），唔開放 anon 寫入。
--   - ⚠️ **冇記錄 = 全部開通**（見 merchant-modules-server.ts 的 loadMerchantGrants）。
--     呢個係刻意嘅向後兼容：本 migration 上線時，所有現有商戶都未有行，
--     如果當成「全部未開通」就會一夜之間鎖死全部門店，冇人入得返 POS。
--     Admin 第一次儲存之後，就變成「以表為準」（可以有商戶一個模組都唔開）。
-- ============================================================================

create table if not exists pos_merchant_modules (
  store_id         text primary key,
  workbenches      jsonb not null default '[]'::jsonb,
  sidebar_modules  jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ============================================================================
-- 權限（對齊 0023 pos_shifts / 0027 pos_print_templates / 0028 pos_note_presets：
-- service_role 全權；anon / authenticated 一律 revoke —— 授權設定唔需要 realtime 訂閱）
-- ============================================================================
revoke all on table public.pos_merchant_modules from anon, authenticated;
grant all on table public.pos_merchant_modules to service_role;

alter table public.pos_merchant_modules enable row level security;

drop policy if exists "pos_merchant_modules service only" on public.pos_merchant_modules;
create policy "pos_merchant_modules service only" on public.pos_merchant_modules
  for all to service_role using (true) with check (true);

-- ============================================================================
-- 驗收
-- ============================================================================
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema='public' and table_name='pos_merchant_modules'
-- order by ordinal_position;
--
-- -- 一店一行：同一 store_id 兩行會違反 pos_merchant_modules_pkey（預期 error）。
-- insert into pos_merchant_modules (store_id, workbenches, sidebar_modules)
--   values ('x', '["dinein"]', '["order"]');
-- insert into pos_merchant_modules (store_id) values ('x'); -- 預期 duplicate key
--
-- -- 收緊某店授權（只開堂食收銀台 + 側欄只留點餐/訂單/會員/打印/報表/交班）
-- update pos_merchant_modules set
--   workbenches = '["dinein"]'::jsonb,
--   sidebar_modules = '["order","orders","members","prints","reports","shift"]'::jsonb,
--   updated_at = now()
-- where store_id = '<merchant uuid>';
