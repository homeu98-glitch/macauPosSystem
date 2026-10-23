-- =============================================================================
-- 0072 · POS 店員帳號與權限（「權限控制」）
--
-- 對應：docs/160-pos-staff-permission-plan-2026-10-23.md
-- 日期：2026-10-23
--
-- 為何要呢張表：
--   Ledger `merchant_staff.staff_role` 只有 `owner` / `staff` 兩檔，契約明文
--   「勿 invent `role` 欄」，而且 RPC 權限閘只有 `is_merchant_staff()`（boolean）。
--   ⇒ 表達唔到「店長 vs 收銀」「邊個睇得到報表」「邊個可以退菜」。
--   而且商家實際情況：**員工唔一定個個有 Ledger 戶口**（兼職／臨時工）。
--   ⇒ 權限與店員帳號一律放 POS 本地，`store_id` 對齊 `merchants.id`，Ledger 零改動。
--
-- 設計取捨：
--   §1 店員係 store-scoped（一部機一間店），跨店店員日後再擴。
--   §2 權限存 jsonb（`{pages:{...}, actions:{...}}`），唔逐個 flag 開欄 ——
--      加一個權限唔需要再 migration。
--   §3 PIN 只存 PBKDF2-SHA256（120k iter）＋ per-row salt，**絕對唔存明文**。
--      樣板反面教材：`admin_account_users.pin_code`（明文，2026-09-15 已加 hash）。
--   §4 RLS 一律 service_role only：呢張表只經 server route 讀寫，
--      anon / authenticated 一個權限都唔畀（同 `pos_*` 表慣例一致）。
--
-- 安全性：全部 `if not exists`，可重複執行。
-- ⚠️ migration 已寫 ≠ 已跑 —— 要人手去 **POS Supabase**（iyrywzormzisyppkokbi）
--    → SQL Editor 貼。未跑之前 API 會回 `tableReady:false`，UI 顯示提示而唔會爆。
-- =============================================================================

create table if not exists public.pos_staff (
  id               uuid primary key default gen_random_uuid(),
  -- = Ledger `merchants.id` / `pos_orders.store_id`（同一個 UUID 口徑）
  store_id         text        not null,
  -- 短工號（登入輸入／顯示用；同一店唯一，大小寫不敏感）
  staff_no         text        not null,
  name             text        not null,
  -- ⚠️ 只准 manager / cashier。`admin`（店主）**唔入呢張表** ——
  --    店主係 Ledger `staff_role = owner`，權限唔受呢層限制。
  role             text        not null,
  -- `{ "pages": {"order":true,...}, "actions": {"voidItem":false,...} }`
  permissions      jsonb       not null default '{}'::jsonb,
  -- PBKDF2-SHA256(120000) hex；salt 獨立欄（per-row random）
  pin_hash         text        not null,
  pin_salt         text        not null,
  pin_algo         text        not null default 'pbkdf2-sha256-120000',
  active           boolean     not null default true,
  -- 4 位 PIN 只有 10⁴ 組合 ⇒ 一定要 per-staff 鎖定（同 admin 帳號同一理由）
  failed_attempts  integer     not null default 0,
  locked_until     timestamptz,
  must_change_pin  boolean     not null default false,
  last_login_at    timestamptz,
  note             text        not null default '',
  created_by       text,
  updated_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint pos_staff_role_check check (role in ('manager', 'cashier')),
  constraint pos_staff_no_check check (length(btrim(staff_no)) between 1 and 12),
  constraint pos_staff_name_check check (length(btrim(name)) between 1 and 40)
);

comment on table public.pos_staff is
  'POS 本地店員帳號（工號＋PIN）與權限。store_id = Ledger merchants.id。2026-10-23。';
comment on column public.pos_staff.permissions is
  '權限覆寫：{pages:{pageId:bool}, actions:{actionId:bool}}；缺欄用角色預設（見 src/lib/pos/staff-core.ts）。';
comment on column public.pos_staff.pin_hash is
  'PBKDF2-SHA256 120k iter、32 bytes、hex。絕不存明文；salt 喺 pin_salt。';
comment on column public.pos_staff.failed_attempts is
  '連續 PIN 錯誤次數；成功登入清零。5 次 → locked_until = now()+15min。';

-- 同一店「工號」唯一（忽略大小寫／前後空白）
create unique index if not exists pos_staff_store_no_idx
  on public.pos_staff (store_id, lower(btrim(staff_no)));

-- 列出啟用店員（權限控制頁 / 簽到頁最常用查詢）
create index if not exists pos_staff_store_active_idx
  on public.pos_staff (store_id)
  where active;


-- ---------------------------------------------------------------------------
-- §4 RLS：service_role only
-- ---------------------------------------------------------------------------
alter table public.pos_staff enable row level security;

drop policy if exists "pos_staff service only" on public.pos_staff;
create policy "pos_staff service only"
  on public.pos_staff
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.pos_staff from public, anon, authenticated;
grant all on table public.pos_staff to service_role;


-- ---------------------------------------------------------------------------
-- 驗收（可重複跑）
-- ---------------------------------------------------------------------------
-- ① 表存在、欄齊：
--    select column_name, data_type from information_schema.columns
--     where table_schema='public' and table_name='pos_staff' order by ordinal_position;
-- ② RLS 已開、只有一條 service_role policy：
--    select relrowsecurity from pg_class where relname='pos_staff';
--    select policyname, roles from pg_policies where tablename='pos_staff';
-- ③ anon 讀唔到（應該 0 行／權限錯誤）：
--    set role anon; select count(*) from public.pos_staff; reset role;
