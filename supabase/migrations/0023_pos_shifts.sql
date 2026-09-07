-- 0023 · pos_shifts（開工/收工班次狀態上雲）
-- 對應 docs/109-shift-sync-overtime-plan.md。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 背景（2026-09-07）
-- ─────────────────────────────────────────────────────────────────────────────
-- 開工/收工狀態一直只存喺每部機嘅 localStorage
-- （`macau-pos/stores/{storeId}/shift`，見 src/lib/storage.ts STORE_SUFFIX.shift），
-- 完全冇上雲 → 跨裝置 / 跨瀏覽器各自為政：
--   A 機開咗工，B 機仍見「未開工」→ 每次要求重新開工，且開工時間各機唔同。
--
-- 本 migration 建立單一 source of truth：`pos_shifts` 一張表 = 一個班次一行，
-- active（進行中）班次 = `closed_at IS NULL`。每間店同一時間最多一個 active 班次
-- （由 partial unique index 保證），開工 = insert，收工 = update 該 row。
--
-- 「連續開工 > 10 小時提醒」（問題二）嘅判斷權威欄位都放呢度：
--   overtime_acked_at = 用戶最近一次撳「取消（繼續營業）」嘅時間；
--   提醒條件 = now - opened_at >= 10h AND (overtime_acked_at IS NULL OR now - overtime_acked_at >= 10h)。
--   因為 ack 狀態喺 server，任何一部機撳「取消」後，其他機都唔會再彈（行為跨裝置一致）。
--
-- 寫入一律經 /api/pos/shift（server service_role），同 pos_orders 一樣唔開放 anon 寫入。
-- ============================================================================

create table if not exists pos_shifts (
  id text primary key,
  -- 店舖 = 登入 merchant UUID（同 pos_orders.store_id 口徑一致）
  store_id text not null,
  -- 開工員工（來自 auth session account / name；舊本地班次可能冇，容許 NULL）
  employee_account text,
  employee_name text,
  opened_at timestamptz not null,
  opening_note text,
  -- 最近一次「取消逾時提醒」時間（問題二權威欄位）。NULL = 從未 ack。
  overtime_acked_at timestamptz,
  -- NULL = 班次進行中（active）
  closed_at timestamptz,
  closing_note text,
  actual_cash numeric,
  cash_difference numeric,
  -- 收工統計快照（settledCount / revenue / … 全部放 jsonb 一欄，方便日後跨裝置歷史）
  summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 每店一個 active 班次（closed_at IS NULL 至多一行）
create unique index if not exists pos_shifts_one_active_per_store
  on pos_shifts (store_id) where closed_at is null;

-- 收工歷史查詢（日後 /api/pos/shift/history 用）
create index if not exists pos_shifts_store_opened_idx
  on pos_shifts (store_id, opened_at desc);

-- 開啟時做冧巴時間排序（防止兩部機同時開工 race）
create index if not exists pos_shifts_active_opened_idx
  on pos_shifts (opened_at) where closed_at is null;

-- ============================================================================
-- 權限（對齊 0016：service_role 全權；anon / authenticated 一律 revoke——
-- 開工狀態唔需要 realtime 訂閱，唔似 pos_orders 咁要留 anon SELECT）
-- ============================================================================
revoke all on table public.pos_shifts from anon, authenticated;
grant all on table public.pos_shifts to service_role;

alter table public.pos_shifts enable row level security;

drop policy if exists "pos_shifts service only" on public.pos_shifts;
create policy "pos_shifts service only" on public.pos_shifts
  for all to service_role using (true) with check (true);

-- ============================================================================
-- 驗收
-- ============================================================================
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema='public' and table_name='pos_shifts'
-- order by ordinal_position;
--
-- -- 每店一個 active 班次：同一 store_id 兩行 closed_at IS NULL 會違反
-- -- pos_shifts_one_active_per_store unique index（預期 error）。
-- insert into pos_shifts (id, store_id, opened_at) values ('t-1','test-store', now());
-- insert into pos_shifts (id, store_id, opened_at) values ('t-2','test-store', now());  -- ERROR
-- update pos_shifts set closed_at = now() where id = 't-1';                              -- 收工
-- insert into pos_shifts (id, store_id, opened_at) values ('t-2','test-store', now());  -- 再開工 OK
