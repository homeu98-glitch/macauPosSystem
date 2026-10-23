-- =============================================================================
-- 0074 · 店舖帳號對照（登入第 2 步：顯示可用身份）
--
-- 對應：docs/160 §11（登入流程改版）
-- 日期：2026-10-23
--
-- 為何要呢張表：
--   新流程係「輸入 8 位店舖帳號 → 顯示可用身份（店主＋店員）→ 揀身份 → 打 PIN」。
--   但未登入時**冇辦法**由帳號查到店舖：
--     · Ledger 契約明文「沒有 login / verify_pin / check_phone RPC」，
--       亦禁止打 Ledger Web 登入頁；
--     · POS 自己嘅表全部以 `store_id` 為主鍵，冇「8 位帳號 → store_id」對照。
--   ⇒ 自己維護一張。**店主第一次成功登入時自動寫入**（零額外操作）。
--
-- 設計：
--   §1 `account` 做主鍵：Ledger 一個電話 = 一個 Auth 帳號 = 一個 merchant_staff row。
--   §2 `store_name` 只係顯示用（Ledger 改店名後，下次店主登入會更新）。
--   §3 RLS service_role only：呢張表會間接俾「知道帳號嘅人」列出店員姓名，
--      所以**唔可以**俾 anon 直接讀；只經 server route（有 IP 限流）讀。
--   §4 冇呢張表 / 冇對應 row = 可預期狀態（第一次用），route 回 `known:false`，
--      client 直接跳去傳統「帳號 + PIN」登入，唔會爆。
--
-- 安全性：全部 `if not exists`，可重複執行。
-- ⚠️ migration 已寫 ≠ 已跑 —— 要人手去 **POS Supabase**（iyrywzormzisyppkokbi）
--    → SQL Editor 貼。
-- =============================================================================

create table if not exists public.pos_store_accounts (
  -- Ledger 8 位登入電話（normalize 後，純數字）
  account      text primary key,
  -- = Ledger `merchants.id` / `pos_orders.store_id`
  store_id     text        not null,
  store_name   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists pos_store_accounts_store_idx
  on public.pos_store_accounts (store_id);

alter table public.pos_store_accounts enable row level security;

drop policy if exists "pos_store_accounts service only" on public.pos_store_accounts;
create policy "pos_store_accounts service only"
  on public.pos_store_accounts
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.pos_store_accounts from public, anon, authenticated;
grant all on table public.pos_store_accounts to service_role;


-- ---------------------------------------------------------------------------
-- 驗收（可重複跑）
-- ---------------------------------------------------------------------------
-- ① 表存在：
--    select column_name, data_type from information_schema.columns
--     where table_schema='public' and table_name='pos_store_accounts' order by ordinal_position;
-- ② RLS 已開、只有一條 service_role policy：
--    select relrowsecurity from pg_class where relname='pos_store_accounts';
--    select policyname, roles from pg_policies where tablename='pos_store_accounts';
-- ③ anon 讀唔到：
--    set role anon; select count(*) from public.pos_store_accounts; reset role;
-- ④ 店主登入過一次之後，應該有 row：
--    select account, store_id, store_name, updated_at from public.pos_store_accounts;
