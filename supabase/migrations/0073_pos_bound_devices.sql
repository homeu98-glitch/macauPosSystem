-- =============================================================================
-- 0073 · POS 裝置授權（免店主帳密開機）
--
-- 對應：docs/160-pos-staff-permission-plan-2026-10-23.md §10
-- 日期：2026-10-23
--
-- 為何要呢張表：
--   0072 之後 L2（工號 + PIN）仍然依附 L1（Ledger 8 位帳號 + PIN）。
--   而 L1 唯一通道係**店主**嘅 Ledger 帳號 ⇒ 新機／清 cache／登出之後，
--   店員開機一定要店主到場打 PIN。呢個同「員工唔一定有 Ledger 戶口」矛盾。
--
-- 設計：
--   §1 店主喺呢部機登入一次並「授權呢部機」→ server 記低一筆。
--   §2 客戶端只存一個 **隨機 secret**（32 bytes），DB 只存 SHA-256；
--      唔存明文 ⇒ DB 洩漏都唔可以直接冒認裝置。
--   §3 為咗開機後仍然有**真嘅 Ledger session**（會員／加值／報表／權限控制全部要
--      `ledgerAccessToken`），server 要代為續期 ⇒ 存 Ledger refresh token。
--      🔴 呢個欄位**一定**要 AES-256-GCM 加密（見 device-binding-server.ts），
--         金鑰由 `POS_DEVICE_TOKEN_SECRET`（或 fallback secret）派生。
--   §4 撤銷 = `revoked_at` 有值 ⇒ 即刻唔可以再換 session（已開咗嘅 session 最長 12h）。
--   §5 RLS 一律 service_role only（同 pos_staff / pos_* 慣例）。
--
-- 安全性：全部 `if not exists`，可重複執行。
-- ⚠️ migration 已寫 ≠ 已跑 —— 要人手去 **POS Supabase**（iyrywzormzisyppkokbi）
--    → SQL Editor 貼。未跑之前 API 回 `tableReady:false`，UI 顯示提示而唔會爆。
-- =============================================================================

create table if not exists public.pos_bound_devices (
  -- `${store_id}:${device_id}`。同 `pos_sessions` 一樣用合成字串：
  -- ① 天然滿足「同店同 device 只有一行」→ upsert 用 on_conflict；
  -- ② 出事時一眼睇得出屬邊間店。
  id                text primary key,

  -- = Ledger `merchants.id`（同 pos_orders.store_id 同一口徑）
  store_id          text        not null,
  -- 客戶端產生並長期保存（localStorage `macau-pos/device-id`）
  device_id         text        not null,

  -- 顯示用（店主自己改／預設由 User-Agent 粗略推）
  label             text,

  -- 邊個店主授權（Ledger email / admin 帳號），審計用
  bound_by          text,
  bound_at          timestamptz not null default now(),
  -- 最後一次用呢個授權換 session 嘅時間
  last_seen_at      timestamptz,
  -- 有值 = 已撤銷（軟刪除，保留審計）
  revoked_at        timestamptz,

  -- 客戶端 secret 嘅 SHA-256（hex）。高熵隨機值，唔需要 PBKDF2。
  secret_hash       text        not null,

  -- Ledger refresh token（AES-256-GCM，格式 `v1.<iv>.<tag>.<ct>`，base64url）
  refresh_token_enc text        not null,
  token_updated_at  timestamptz not null default now(),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists pos_bound_devices_store_idx
  on public.pos_bound_devices (store_id, revoked_at);

create index if not exists pos_bound_devices_device_idx
  on public.pos_bound_devices (device_id);

alter table public.pos_bound_devices enable row level security;

drop policy if exists "pos_bound_devices service only" on public.pos_bound_devices;
create policy "pos_bound_devices service only"
  on public.pos_bound_devices
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.pos_bound_devices from public, anon, authenticated;
grant all on table public.pos_bound_devices to service_role;


-- ---------------------------------------------------------------------------
-- 驗收（可重複跑）
-- ---------------------------------------------------------------------------
-- ① 表存在、欄齊：
--    select column_name, data_type from information_schema.columns
--     where table_schema='public' and table_name='pos_bound_devices' order by ordinal_position;
-- ② RLS 已開、只有一條 service_role policy：
--    select relrowsecurity from pg_class where relname='pos_bound_devices';
--    select policyname, roles from pg_policies where tablename='pos_bound_devices';
-- ③ anon 讀唔到（應該 0 行／權限錯誤）：
--    set role anon; select count(*) from public.pos_bound_devices; reset role;
-- ④ 冇明文 refresh token（應該全部係 `v1.` 開頭）：
--    select device_id, left(refresh_token_enc, 3) from public.pos_bound_devices;
