-- 0027 · pos_print_templates（打印模板按店存 DB）
-- 對應 docs/71 擱置嘅 "push seam" 落地：打印模板以前淨存喺每部機嘅 localStorage
-- （`macau-pos/stores/{storeId}/local-settings` → printTemplates，src/lib/storage.ts
-- STORE_SUFFIX.localSettings），print-center 從未 POST 上後台 → 跨終端各自為政、
-- 新終端入打印頁永遠只見到 local default。
--
-- 本 migration 建立單一 per-store 真源：`pos_print_templates` 一張表一間店一行，
-- 四個模板槽位（收據 / 標籤 / 廚房 / 自助點餐機）各自一個 jsonb 欄。
--
-- 設計要點：
--   - store_id = 登入 merchant UUID（同 pos_orders.store_id / pos_shifts.store_id 口徑一致）。
--   - 一店一行 → 多終端共享同一份模板，print-center「進入即拉、儲存即 POST」。
--   - 唔加 FK / 唔做 cascade：同 pos_shifts 一樣，店舖刪除係上層業務，唔喺呢層處理。
--   - 寫入一律經 /api/pos/print-templates（server service_role），同 pos_shifts 一樣
--     唔開放 anon 寫入（0016 已 revoke default privileges，但顯式再落多一道閘）。
--
-- 版本衝突（last-write-wins）策略：POST 時 server 用 now() 覆寫 updated_at；
-- client 拉取後將 server updated_at 記低做「已知版本」，下次同步只有 server 更新
-- （updated_at 較新）先會採納，避免舊終端嘅本地 default 蓋走 DB 已設計嘅模板
-- （docs/71 §8 舊 bug 嘅新解法 —— server 來源改做呢張表，唔再係 device_configs 預設）。
-- ============================================================================

create table if not exists pos_print_templates (
  store_id  text primary key,
  receipt   jsonb not null default '{}'::jsonb,
  label     jsonb not null default '{}'::jsonb,
  kitchen   jsonb not null default '{}'::jsonb,
  kiosk     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- 權限（對齊 0023 pos_shifts：service_role 全權；anon / authenticated 一律 revoke ——
-- 打印模板唔需要 realtime 訂閱，唔似 pos_orders 咁要留 anon SELECT）
-- ============================================================================
revoke all on table public.pos_print_templates from anon, authenticated;
grant all on table public.pos_print_templates to service_role;

alter table public.pos_print_templates enable row level security;

drop policy if exists "pos_print_templates service only" on public.pos_print_templates;
create policy "pos_print_templates service only" on public.pos_print_templates
  for all to service_role using (true) with check (true);

-- ============================================================================
-- 驗收
-- ============================================================================
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema='public' and table_name='pos_print_templates'
-- order by ordinal_position;
--
-- -- 一店一行：同一 store_id 兩行會違反 pos_print_templates_pkey（預期 error）。
-- insert into pos_print_templates (store_id, receipt) values ('x', '{}');
-- insert into pos_print_templates (store_id, receipt) values ('x', '{}'); -- 預期 duplicate key
