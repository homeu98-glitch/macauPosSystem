-- =============================================================================
-- 0070 · 帳號管理（多店控制台 P2）
--
-- 對應：docs/159 §5 P2
-- 日期：2026-10-21
--
-- 做三件事：
--   §1 `admin_account_users` 加 `must_change_pin`（首登強制改 PIN）＋ `created_by`（審計）
--   §2 seed「店舖級」權限組 `pos-owner`（固定 uuid，對齊 0025 的固定 uuid 慣例）
--   §3 明確標記 `admin-full` 為平台級（`scopeAllStores = true`）
--
-- 為何用「權限組」而唔係逐帳號 flag：
--   `adminPanelAccess` / `manageAccounts` / `scopeAllStores` 一直住喺
--   `admin_permission_groups.permissions`（jsonb）。P2 建號只需要揀「平台」定「店主」，
--   由 group 決定全部權限，唔使為每個帳號發明一套 permission 覆寫。
--   ⇒ 建號 API 只揀 `pos-owner` 或 `admin-full` 兩個組之一。
--
-- 安全性：全部 `if not exists` / `on conflict`，可重複執行；唔會覆寫現有帳號嘅組。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- §1 首登強制改 PIN
--
-- 平台派發初始 PIN（例如 1234）之後，如果唔強制改，10⁴ 組合 + 已知初始值 =
-- 任何人都可以撞入（4 位 PIN 的唯一補償是「唔公開」）。所以新帳號一律
-- `must_change_pin = true`，登入後前端強制改，改完才清除。
-- ---------------------------------------------------------------------------
alter table public.admin_account_users
  add column if not exists must_change_pin boolean not null default false;

alter table public.admin_account_users
  add column if not exists created_by text;

comment on column public.admin_account_users.must_change_pin is
  '首登強制改 PIN。建號時 = true；改完 PIN 由 API 設返 false。2026-10-21（P2）。';

comment on column public.admin_account_users.created_by is
  '邊個平台帳號建立呢個帳號（審計用）。2026-10-21（P2）。';


-- ---------------------------------------------------------------------------
-- §2 店舖級權限組 `pos-owner`
--
-- 🔴 id 固定（唔用 gen_random_uuid）—— 建號 API 要硬編碼引用；
--    固定 uuid 亦令 0025 一類 seed 腳本可以 idempotent 重跑。
-- ---------------------------------------------------------------------------
insert into public.admin_permission_groups (id, code, name, role, permissions, created_at, updated_at, note)
values (
  '44444444-4444-4444-4444-444444444444',
  'pos-owner',
  '店主（多店）',
  'manager',
  jsonb_build_object(
    'adminPanelAccess', true,   -- 可以登入 /admin
    'scopeAllStores',   false,  -- 只睇自己綁定嘅店
    'manageAccounts',   false,  -- 唔可以管帳號
    'refundOrder',      true,
    'voidItem',         true
  ),
  now(),
  now(),
  '店舖級後台帳號（可綁多店、只讀自己店）。2026-10-21（P2）'
)
on conflict (id) do update set
  code = excluded.code,
  name = excluded.name,
  role = excluded.role,
  permissions = excluded.permissions,
  updated_at = now();


-- ---------------------------------------------------------------------------
-- §3 `admin-full` 明確標記平台級
--
-- 現時 `resolveAdminScope()` 用 `manageAccounts` 做過渡推導；P2 之後明確加
-- `scopeAllStores = true`，令「管帳號」同「跨全部店」兩件事分開（將來可以
-- 有「可以管帳號但唔可以睇全部店」的角色）。
-- ---------------------------------------------------------------------------
update public.admin_permission_groups
   set permissions = coalesce(permissions, '{}'::jsonb) || '{"scopeAllStores":true}'::jsonb,
       updated_at = now()
 where code = 'admin-full';


-- ---------------------------------------------------------------------------
-- §4 驗證（貼完之後逐條跑）
--
--   -- 欄位有冇加：
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_name='admin_account_users' and column_name in ('must_change_pin','created_by');
--
--   -- 兩個組嘅權限：
--   select code, permissions from admin_permission_groups where code in ('admin-full','pos-owner');
--   → admin-full 應該有 manageAccounts=true + scopeAllStores=true
--   → pos-owner  應該有 adminPanelAccess=true、manageAccounts=false、scopeAllStores=false
-- ---------------------------------------------------------------------------
