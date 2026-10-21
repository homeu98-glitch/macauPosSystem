-- =============================================================================
-- 0068 · Admin 安全底座（多店控制台 P0）
--
-- 對應：docs/157 §5 P0、docs/159 §3（P0-2 / P0-4）
-- 日期：2026-10-21
--
-- 做兩件事：
--   §1 `admin_account_users` 加「失敗鎖定」欄位（per-account，落 DB）
--   §2 建 `admin_audit_log`（登入成功／失敗／鎖定／寫入操作）
--
-- 為何要落 DB（唔可以放記憶體）：
--   Vercel 係多 instance。鎖定狀態放記憶體 = 每個 instance 各自計 5 次
--   ⇒ 實際可試次數 = 5 × instance 數，而且冷啟動就清零。冇意義。
--
-- 為何要有 §1（D2 = 沿用 4 位 PIN）：
--   4 位 PIN = 10⁴ 組合、帳號 = 8 位電話（可枚舉）。單靠 IP rate limit 換 IP 即繞過。
--   所以一定要有 per-account 鎖定：連續 5 次失敗 → 鎖 15 分鐘（期間連正確 PIN 都拒）。
--
-- 安全性（本檔唔會令資料外洩）：
--   · 兩張表都**只經 service_role** 存取（PostgREST 用 anon key 打唔到）。
--   · `admin_audit_log` 開 RLS 但**唔建 policy** ⇒ anon / authenticated 一律睇唔到；
--     service_role 繞過 RLS（正常寫入）。
--   · 唔會記 PIN、token（見 `src/lib/admin-audit.server.ts` 的鐵律）。
--
-- 冪等性：全部 `if not exists`，可以重複執行。
-- 執行方式：Supabase SQL Editor 直接貼，或 `supabase db push`。
-- 回滾：
--   alter table public.admin_account_users drop column if exists failed_login_count;
--   alter table public.admin_account_users drop column if exists locked_until;
--   drop table if exists public.admin_audit_log;
-- =============================================================================


-- ---------------------------------------------------------------------------
-- §1【必跑】admin_account_users 加鎖定欄位
--
-- 預設值語義：
--   failed_login_count = 0、locked_until = null ⇒ 未鎖（等同現有帳號行為，零影響）
-- ---------------------------------------------------------------------------
alter table public.admin_account_users
  add column if not exists failed_login_count integer not null default 0;

alter table public.admin_account_users
  add column if not exists locked_until timestamptz;

comment on column public.admin_account_users.failed_login_count is
  '連續登入失敗次數；成功登入清零。達 5 次即設 locked_until。2026-10-21（D2 沿用 4 位 PIN 的補償措施）。';

comment on column public.admin_account_users.locked_until is
  '鎖定到期時間；NULL = 未鎖。鎖定期間連正確 PIN 都拒絕（防鎖定期間繼續爆破）。2026-10-21。';


-- ---------------------------------------------------------------------------
-- §2【必跑】admin_audit_log
--
-- 為何 store_ids 用 text[] 而唔係 FK：
--   POS DB 冇 `merchants` 表（merchants 住喺 Ledger 另一邊 DB，見 migration 0024 說明），
--   所以全 POS 一律用 merchant UUID 的 text 表示店舖，唔可以建 FK。
-- ---------------------------------------------------------------------------
create table if not exists public.admin_audit_log (
  id         bigserial primary key,
  account    text        not null,
  action     text        not null,          -- login_success | login_failed | login_locked | logout | write | read
  target     text,                          -- 資源／動作（例：merchant.status、menu.price、store.active）
  store_ids  text[],                        -- 涉及邊幾間店（Ledger merchant UUID）
  detail     jsonb,                         -- 細粒度補充（**唔可以**放 PIN／token／整個 payload）
  ip         text,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_audit_account_time
  on public.admin_audit_log (account, created_at desc);

create index if not exists idx_admin_audit_created_at
  on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;

-- 明確收權：即使將來有人加 policy，anon / authenticated 都唔應該有直接表權限。
revoke all on public.admin_audit_log from anon, authenticated;
grant all on public.admin_audit_log to service_role;

-- bigserial 的 sequence 都要收（否則 anon 可以推測寫入量）
revoke all on sequence public.admin_audit_log_id_seq from anon, authenticated;
grant all on sequence public.admin_audit_log_id_seq to service_role;

comment on table public.admin_audit_log is
  'Admin 操作審計：登入成功／失敗／鎖定、寫入操作。只經 service_role 讀寫（RLS 無 policy）。2026-10-21。';


-- ---------------------------------------------------------------------------
-- §3【驗證】跑完可以照下面查（Supabase SQL Editor）
--
--   -- 欄位有冇加：
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_name = 'admin_account_users'
--      and column_name in ('failed_login_count','locked_until');
--
--   -- 表有冇建、RLS 有冇開：
--   select relname, relrowsecurity from pg_class where relname = 'admin_audit_log';
--
--   -- 現有帳號應全部未鎖：
--   select account, failed_login_count, locked_until from public.admin_account_users;
-- ---------------------------------------------------------------------------
