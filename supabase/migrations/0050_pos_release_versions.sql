-- 0050_pos_release_versions.sql
-- ============================================================================
-- 目的：令「App 安裝包版本」由**代碼常數**變成**資料庫資料** —— 商家可以自己
--       新增／切換 Android APK 與 Desktop 安裝包嘅下載版本，唔使改代碼重新部署。
--
-- 【為何要加（2026-09-23）】
-- 現狀：下載連結只可以寫死喺前端（`public/releases/manifest.json` 只服務 Electron
-- 自動更新；POS 網頁根本冇「下載安裝包」入口）。後果：
--   · 出一個新 APK → 要改代碼 → commit → push → 等 Vercel Redeploy（分鐘級）；
--   · 想「退回上一個版本」＝ 改代碼 + 重新部署，出事時根本來唔及；
--   · 冇任何地方睇得到「而家對外派緊邊個版本」。
--
-- 【設計】
--   · 一行 ＝ 一個版本（`platform` 分 android / desktop，兩者**各自獨立**一條線）。
--   · **每個平台最多一個 active**（partial unique index 喺 DB 層強制，唔靠應用層自律）
--     ⇒ 登入頁永遠只會連去一個確定嘅版本，唔會出現「兩條 active 睇邊條先」。
--   · 檔案本體放 Supabase Storage `macauposapk` bucket（**public**）⇒ 下載連結
--     由 `file_path` 砌出嚟（`/storage/v1/object/public/macauposapk/<file_path>`）。
--     亦可以改填 `download_url` 完整外部連結（例如 CDN、GitHub Release、signed URL）
--     —— 非空時**覆蓋**砌出嚟嘅 URL。
--   · 兩者至少要有一個（check constraint）⇒ 唔會出現「有 active 版本但撳落去冇連結」。
--
-- 【安全】
--   · 表只 `service_role` 可讀寫（`anon` / `authenticated` 一律 revoke）。
--     公開讀取走 `/api/release/versions/active`（server 端用 service role 讀，只回
--     兩個平台嘅 active 版本）—— 同 0016 之後「業務表一律 service_role-only」一致。
--   · ⚠️ **唔可以**為咗方便而 grant anon select：呢張表會經 admin 寫入，一旦 anon
--     可讀就等於公開「內部版本清單 + 備註」。而且登入頁本來就係匿名路徑，
--     走 API route 反而可以順手加 CDN 快取，省 egress。
--
-- ⚠️ 寫咗 migration ≠ 跑咗 migration（已踩過 0018/0019/0020/0040/0044/0045）。
--    本機冇 DB 連線 → 要人手去 Supabase Dashboard（**POS 專案 iyrywzormzisyppkokbi**，
--    唔係 Ledger 專案）→ SQL Editor 貼。全部 idempotent，可以重複貼。
-- ============================================================================

-- ── A. 表 ──────────────────────────────────────────────────────────────────
create table if not exists public.pos_release_versions (
  id           uuid        primary key default gen_random_uuid(),

  -- 分兩條獨立線：android＝APK，desktop＝桌面安裝包（Windows/macOS）。
  platform     text        not null,

  -- 版本號（自由文字，例如 `1.4.2`、`2026.09.23`）。admin 頁按 created_at 排序，
  -- 唔靠版本號排序 —— 唔假設有語意化版本。
  version      text        not null,

  -- Supabase Storage `macauposapk` bucket 內嘅相對路徑，例如 `macau-pos.apk`。
  -- 可以帶子目錄，例如 `1.4.2/macau-pos.apk`。
  file_path    text,

  -- 完整外部下載連結（非空 ⇒ 覆蓋 file_path 砌出嚟嘅公開 URL）。
  -- 用途：檔案放喺 Storage 以外、或者要用 signed URL、或者想留返舊連結做記錄。
  download_url text,

  -- 檔案大小（bytes）。純顯示用（admin 頁 + 登入頁提示），可以留空。
  file_size    bigint,

  -- 更新內容 / 備註（顯示喺 admin 頁；登入頁可以唔顯示）。
  notes        text,

  -- 每個平台最多一個 true（見下面 partial unique index）。
  is_active    boolean     not null default false,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint pos_release_versions_platform_check
    check (platform in ('android', 'desktop')),

  -- 版本號唔可以空白
  constraint pos_release_versions_version_check
    check (length(trim(version)) > 0),

  -- 至少要有一個下載來源，否則「active 但冇連結」＝ 登入頁派一個死 link
  constraint pos_release_versions_link_check
    check (
      length(trim(coalesce(file_path, ''))) > 0
      or length(trim(coalesce(download_url, ''))) > 0
    )
);

comment on table public.pos_release_versions is
  'App 安裝包版本清單（android APK / desktop 安裝包各一條線，每平台最多一個 is_active）。2026-09-23 新增，admin「版本控制」頁 + 登入頁下載按鈕用。只 service_role 可讀寫。';
comment on column public.pos_release_versions.platform is
  'android = APK（Android 裝置）；desktop = 桌面安裝包（非 Android）。';
comment on column public.pos_release_versions.file_path is
  'Supabase Storage `macauposapk` bucket 內相對路徑，例如 macau-pos.apk。';
comment on column public.pos_release_versions.download_url is
  '完整外部連結；非空時覆蓋由 file_path 砌出嘅公開 URL。';
comment on column public.pos_release_versions.is_active is
  '每個平台最多一個 true（partial unique index 強制）。登入頁只連目前 active 版本。';

-- ── B. 「每平台最多一個 active」── DB 層強制 ────────────────────────────────
-- ⚠️ 用 partial unique index 而唔係應用層自律：admin 兩個分頁同時切換、
--    或者有人直接改 SQL，都唔會整出「兩條 active」。
create unique index if not exists pos_release_versions_one_active_per_platform_idx
  on public.pos_release_versions (platform)
  where is_active;

-- admin 列表：最新版本排前面
create index if not exists pos_release_versions_platform_created_idx
  on public.pos_release_versions (platform, created_at desc);

-- ── C. RLS：只有 service_role ──────────────────────────────────────────────
alter table public.pos_release_versions enable row level security;

drop policy if exists "pos_release_versions service only" on public.pos_release_versions;
create policy "pos_release_versions service only"
  on public.pos_release_versions for all to service_role using (true) with check (true);

revoke all on table public.pos_release_versions from public, anon, authenticated;
grant all on table public.pos_release_versions to service_role;

-- ── D. 原子切換 active（1 次呼叫 ＝ 先落閘、後上位，唔會撞 unique index）─────
-- 為何要 RPC：切換 ＝ 兩步（同平台其他 row 落 is_active=false，目標 row 上 true）。
-- 若分兩條 HTTP 請求做，中間失敗會留低「一個 active 都冇」（或者撞 unique index）。
-- 呢個 function 一個 transaction 做完，兼且驗證目標 row 存在。
--
-- 回傳：切換成功返該 row 嘅 id；目標唔存在返 null（呼叫方自行回 404）。
create or replace function public.pos_activate_release_version(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_platform text;
begin
  select platform into v_platform
    from public.pos_release_versions
   where id = p_id;

  -- 目標 row 唔存在 → 唔改任何嘢（避免「先落閘、後發現冇目標」）
  if v_platform is null then
    return null;
  end if;

  -- ① 先落閘（一定要先做，否則 ② 會被 partial unique index 擋）
  update public.pos_release_versions
     set is_active  = false,
         updated_at = now()
   where platform = v_platform
     and is_active
     and id <> p_id;

  -- ② 目標上位
  update public.pos_release_versions
     set is_active  = true,
         updated_at = now()
   where id = p_id;

  return p_id;
end;
$$;

revoke all on function public.pos_activate_release_version(uuid) from public, anon, authenticated;
grant execute on function public.pos_activate_release_version(uuid) to service_role;

-- ============================================================================
-- 驗收（貼完之後跑）
-- ============================================================================
--
-- 1. 表 + RLS
--   select relname, relrowsecurity from pg_class where relname = 'pos_release_versions';
--   → relrowsecurity = true
--
-- 2. anon 冇權（應該全部 false / null）
--   select has_table_privilege('anon', 'public.pos_release_versions', 'SELECT');
--   select has_table_privilege('anon', 'public.pos_release_versions', 'INSERT');
--   select has_function_privilege('anon', 'public.pos_activate_release_version(uuid)', 'EXECUTE');
--
-- 3. 「每平台最多一個 active」真係擋得住（應該報 duplicate key）
--   insert into public.pos_release_versions (platform, version, file_path, is_active)
--   values ('android', '__a__', '__a__.apk', true),
--          ('android', '__b__', '__b__.apk', true);   -- ← 呢句要 fail
--
-- 4. 切換 RPC（可以重複跑；最後 android 應該只剩一條 active）
--   insert into public.pos_release_versions (platform, version, file_path)
--   values ('android', '__a__', '__a__.apk'), ('android', '__b__', '__b__.apk')
--   on conflict do nothing;
--   select public.pos_activate_release_version(
--     (select id from public.pos_release_versions where version = '__a__')
--   );
--   select public.pos_activate_release_version(
--     (select id from public.pos_release_versions where version = '__b__')
--   );
--   select version, is_active from public.pos_release_versions where platform = 'android';
--   → 只有 __b__ 係 true
--
-- 5. 清測試資料
--   delete from public.pos_release_versions where version like '__%__';
--
-- 6. 第一個正式版本（把 `macau-pos.apk` 換成你 Storage 入面嘅真實檔名）
--   insert into public.pos_release_versions (platform, version, file_path, is_active)
--   values ('android', '1.0.0', 'macau-pos.apk', true);
-- ============================================================================
