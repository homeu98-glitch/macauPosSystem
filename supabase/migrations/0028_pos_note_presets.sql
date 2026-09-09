-- 0028 · pos_note_presets（備註預設按店存 DB）
-- 對應「設置頁備註欄位以 DB 為唯一真源」根治：備註預設（常用備註 / 免單備註 /
-- 取消備註）以前同其他 per-terminal 設定一齊塞喺 `pos_device_configs.local_settings`
-- 個 JSONB 度。但 pos_device_configs 以 device_id 為 primary key（每台終端一行），
-- 而備註語意係「全店共用」——多台機同時改備註會各自寫自己嗰行，讀取端只拎
-- store_id「最新一條」，另一台機嘅改動會被靜默丟失（同 docs/52 autoAccept 同一個坑）。
--
-- 本 migration 建立單一 per-store 真源：`pos_note_presets` 一張表一間店一行，
-- 三個備註槽位（常用 / 免單 / 取消）各自一個 jsonb 欄。
--
-- 設計要點（照抄 0027 pos_print_templates 已驗證嘅模式）：
--   - store_id = 登入 merchant UUID（同 pos_orders.store_id / pos_shifts.store_id 口徑一致）。
--   - 一店一行 → 多終端共享同一份備註，唔會互相覆蓋。
--   - 唔加 FK / 唔做 cascade：同 pos_shifts / pos_print_templates 一樣，店舖刪除係上層業務。
--   - 寫入一律經 /api/pos/note-presets（server service_role），唔開放 anon 寫入。
--   - 版本衝突（last-write-wins）：POST 時 server 用 now() 覆寫 updated_at；
--     client 拉取後記低 server updated_at 做「已知版本」，下次同步只有 server 更新
--     （updated_at 較新）先採納，避免舊終端本地 default 蓋走 DB 已設嘅備註。
-- ============================================================================

create table if not exists pos_note_presets (
  store_id            text primary key,
  note_presets        jsonb not null default '[]'::jsonb,
  cancel_note_presets jsonb not null default '[]'::jsonb,
  comp_note_presets   jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ============================================================================
-- 權限（對齊 0023 pos_shifts / 0027 pos_print_templates：service_role 全權；
-- anon / authenticated 一律 revoke —— 備註預設唔需要 realtime 訂閱）
-- ============================================================================
revoke all on table public.pos_note_presets from anon, authenticated;
grant all on table public.pos_note_presets to service_role;

alter table public.pos_note_presets enable row level security;

drop policy if exists "pos_note_presets service only" on public.pos_note_presets;
create policy "pos_note_presets service only" on public.pos_note_presets
  for all to service_role using (true) with check (true);

-- ============================================================================
-- 驗收
-- ============================================================================
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema='public' and table_name='pos_note_presets'
-- order by ordinal_position;
--
-- -- 一店一行：同一 store_id 兩行會違反 pos_note_presets_pkey（預期 error）。
-- insert into pos_note_presets (store_id, note_presets) values ('x', '[]');
-- insert into pos_note_presets (store_id, note_presets) values ('x', '[]'); -- 預期 duplicate key
