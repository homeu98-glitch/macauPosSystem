-- =============================================================================
-- 0051 · per-store token 第 1 階段：加性 store-scoped `authenticated` 讀取政策
--
-- 背景／完整評估：docs/reviews/per-store-token-assessment-2026-09-23.md
--
-- -----------------------------------------------------------------------------
-- 🔴🔴 本檔做咩、唔做咩（睇漏會出事）
-- -----------------------------------------------------------------------------
-- ✅ 做：為 5 張表「**加**」一條 `for select to authenticated` 政策，
--        條件係 `store_id = (auth.jwt() ->> 'store_id')`。
-- ❌ 唔做：**絕對唔會 touch 任何現有 anon 政策**。呢個係「零停機」嘅全部秘密。
--
-- 🔴 **本 migration 單獨執行之後，系統行為零改變** —— 因為目前冇任何 client
--    攜帶 JWT。呢個係刻意嘅（第 1 階段＝純基建，可以長期擱置）。
--    真正令佢生效要等第 2／3 階段（client 開始帶 JWT）。
--    ⇒ 唔可以「跑完 SQL 就當完成」，亦唔可以提早做第 4 階段。
--
-- -----------------------------------------------------------------------------
-- 四階段計劃（每階段都可獨立停下／回滾）
-- -----------------------------------------------------------------------------
--   第 1 階段（本檔）：加 authenticated 政策，保留 anon        ← 風險 ≈ 0
--   第 2 階段：Web client 帶 JWT（`realtime.setAuth`，取唔到就 fallback anon）
--   第 3 階段：中繼 APK 帶 JWT（`/pair` 加可選 `realtimeJwt`；舊 APK 零影響）
--   第 4 階段：**最後才 drop anon 政策**（唯一有風險一步；關店時段；秒級回滾）
--
-- -----------------------------------------------------------------------------
-- 為何唔可以「順手」把 anon 政策收緊或刪走（已經犯過／差啲犯）
-- -----------------------------------------------------------------------------
-- 三個 Realtime 消費者**全部用公開 anon key** 訂 `postgres_changes`：
--   · src/lib/pos/use-pos-realtime.ts   （收銀台：pos_orders / pos_print_jobs / pos_soldout）
--   · src/lib/kds/use-kds-realtime.ts   （後廚：pos_orders / pos_kds_item_state）
--   · 中繼 APK（`resolveRelayRealtimeConfig()` 派 SUPABASE_ANON_KEY，訂 pos_print_jobs）
-- Supabase Realtime **只推「你 SELECT 得到」嘅行**，而 anon 身份冇任何 store claim
-- ⇒ 一旦收緊／刪走 anon 政策，**一個事件都唔會推**，但 channel 照樣 `SUBSCRIBED`、
--    零 error（docs/113「Realtime 靜默失效」同一型）⇒ 列印由 1–3 秒退化成最長 180 秒、
--    訂單唔再自動彈出。守衛：src/lib/pos/print-and-order-realtime-guard.test.ts（14 條）。
--
-- 另外（0021 檔頭已記錄）：Realtime 對 UPDATE / DELETE 事件係用 **row 自身 `created_at`**
-- 去過 RLS SELECT policy，而 `created_at` 唔會變 ⇒ 時間窗亦唔可以收得太短。
--
-- -----------------------------------------------------------------------------
-- 為何係 5 張而唔係 6 張（pos_soldout 刻意排除）
-- -----------------------------------------------------------------------------
-- `pos_soldout` 嘅讀取者係**匿名客人端**：`use-kiosk-order.ts` → `soldout.ts`
-- `fetchStoreSoldoutIds()` 直接用 anon client 讀（客人掃碼 / 自助點餐機冇任何登入身份
-- ⇒ 永遠拿唔到 store token）。該表只有 `store_id + menu_item_id + sold_out` 三格、
-- 冇歷史、冇 PII、目前 0 行 ⇒ 維持 `using (true)`（口徑見 0016 §3c）。
--
-- -----------------------------------------------------------------------------
-- 技術紀律
-- -----------------------------------------------------------------------------
-- 1. 全部 idempotent（`drop policy if exists` → `create policy`）。
-- 2. `coalesce(created_at, now())` **唔可以省** —— `created_at` 可以係 null，
--    寫 `created_at >= now() - interval ...` 會令該行**永遠讀唔到**（靜默漏單）。
--    同 0016 / 0041 同一寫法。
-- 3. 唔建立 helper function：`create function` 預設 `grant execute to PUBLIC`
--    ⇒ 會經 PostgREST RPC 多開一個介面。直接用內建 `auth.jwt()`（本身已 STABLE）。
-- 4. 只 `grant select`（唔 `grant all`）：本政策係 `for select`，
--    而全 49 份 migration 掃過係**零** `to authenticated` grant ⇒ 由零開始，最小權限。
-- 5. 本檔必須喺 **Supabase SQL Editor** 貼得通（唔可以用 psql 專屬語法 `\set` / `:'var'`）。
-- =============================================================================


-- ---------------------------------------------------------------------------
-- §0 前置條件檢查（唔成立就大聲失敗，唔好靜默做錯事）
--
-- 為何要：本檔**假設 anon 政策仍然存在**（加性推進）。若果有人已經提早收緊／刪走，
-- 咁本檔就唔應該繼續 —— 因為「唔改 anon」呢個安全前提已經破咗，要即刻停低查。
-- ---------------------------------------------------------------------------
do $preflight$
declare
  v_tbl     text;
  v_missing text[] := array[]::text[];
begin
  foreach v_tbl in array array[
    'pos_orders',
    'pos_print_jobs',
    'pos_kds_item_state',
    'pos_store_status',
    'pos_online_order_settings'
  ]
  loop
    if not exists (
      select 1
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = v_tbl
        and p.cmd        = 'SELECT'
        and 'anon' = any (p.roles::text[])
    ) then
      v_missing := v_missing || v_tbl;
    end if;
  end loop;

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception
      '前置條件唔成立：以下表冇 anon SELECT policy → %。'
      '本 migration 係「加性推進」（必須保留 anon），'
      '請先確認 0011 / 0016 / 0019 / 0021 / 0033 / 0039 / 0041 已經跑齊，'
      '並且冇人提早收緊 anon 讀取。',
      array_to_string(v_missing, ', ');
  end if;
end
$preflight$;


-- ---------------------------------------------------------------------------
-- §1 RLS 保險（全部表早已啟用；呢句係 idempotent 保險，唔會改任何行為）
-- ---------------------------------------------------------------------------
alter table public.pos_orders                enable row level security;
alter table public.pos_print_jobs            enable row level security;
alter table public.pos_kds_item_state        enable row level security;
alter table public.pos_store_status          enable row level security;
alter table public.pos_online_order_settings enable row level security;


-- ---------------------------------------------------------------------------
-- §2 逐表加 store-scoped `authenticated` 讀取政策
--
-- 時間窗同現有 anon 政策**完全一致**（唔可以更短，見檔頭技術紀律 #2）：
--   pos_orders      → 72 小時（對齊 0041）
--   pos_print_jobs  → 24 小時（對齊 0021）
--   其餘 3 張        → 只做 store 過濾（單店當前狀態表，冇 created_at，
--                      加窗口反而會擋住延遲 UPDATE／DELETE 事件）
-- ---------------------------------------------------------------------------

-- 2a) pos_orders（72 小時）
revoke all on table public.pos_orders from authenticated;
grant select on table public.pos_orders to authenticated;
drop policy if exists "pos_orders store scoped read" on public.pos_orders;
create policy "pos_orders store scoped read" on public.pos_orders
  for select to authenticated
  using (
    store_id = (auth.jwt() ->> 'store_id')
    and coalesce(created_at, now()) >= now() - interval '72 hours'
  );

-- 2b) pos_print_jobs（24 小時）
revoke all on table public.pos_print_jobs from authenticated;
grant select on table public.pos_print_jobs to authenticated;
drop policy if exists "pos_print_jobs store scoped read" on public.pos_print_jobs;
create policy "pos_print_jobs store scoped read" on public.pos_print_jobs
  for select to authenticated
  using (
    store_id = (auth.jwt() ->> 'store_id')
    and coalesce(created_at, now()) >= now() - interval '24 hours'
  );

-- 2c) pos_kds_item_state（後廚單品完成狀態；PK 首欄就係 store_id ⇒ 索引可用）
revoke all on table public.pos_kds_item_state from authenticated;
grant select on table public.pos_kds_item_state to authenticated;
drop policy if exists "pos_kds_item_state store scoped read" on public.pos_kds_item_state;
create policy "pos_kds_item_state store scoped read" on public.pos_kds_item_state
  for select to authenticated
  using (store_id = (auth.jwt() ->> 'store_id'));

-- 2d) pos_store_status（線下營業開關）
--     ⚠️ 客人端（掃碼 / kiosk）讀營業狀態係經 `GET /api/pos/store-status`（service_role）
--        ⇒ 唔受本政策影響；本政策只服務收銀台 Realtime。
revoke all on table public.pos_store_status from authenticated;
grant select on table public.pos_store_status to authenticated;
drop policy if exists "pos_store_status store scoped read" on public.pos_store_status;
create policy "pos_store_status store scoped read" on public.pos_store_status
  for select to authenticated
  using (store_id = (auth.jwt() ->> 'store_id'));

-- 2e) pos_online_order_settings（線上接單鏡像）
revoke all on table public.pos_online_order_settings from authenticated;
grant select on table public.pos_online_order_settings to authenticated;
drop policy if exists "pos_online_order_settings store scoped read" on public.pos_online_order_settings;
create policy "pos_online_order_settings store scoped read" on public.pos_online_order_settings
  for select to authenticated
  using (store_id = (auth.jwt() ->> 'store_id'));


-- 2f) pos_soldout —— 🔴 刻意唔加 store 政策，亦唔可以收緊 anon
--     讀取者係匿名客人端（掃碼 / kiosk）⇒ 永遠拿唔到 store token。
--     見檔頭說明同 0016 §3c。


-- ---------------------------------------------------------------------------
-- §3 執行後自我檢查（唔通過就大聲失敗）
-- ---------------------------------------------------------------------------
do $postcheck$
declare
  v_tbl     text;
  v_missing text[] := array[]::text[];
begin
  foreach v_tbl in array array[
    'pos_orders',
    'pos_print_jobs',
    'pos_kds_item_state',
    'pos_store_status',
    'pos_online_order_settings'
  ]
  loop
    -- (a) 新政策必須存在，而且一定要帶 store 過濾
    if not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = v_tbl
        and p.policyname = v_tbl || ' store scoped read'
        and 'authenticated' = any (p.roles::text[])
        and p.qual like '%store_id%'
    ) then
      v_missing := v_missing || (v_tbl || '(新政策)');
    end if;

    -- (b) 🔴 anon 政策必須仍然存在（本檔嘅安全前提）
    if not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = v_tbl
        and p.cmd        = 'SELECT'
        and 'anon' = any (p.roles::text[])
    ) then
      v_missing := v_missing || (v_tbl || '(anon 政策唔見咗!)');
    end if;
  end loop;

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception '0051 自我檢查失敗 → %', array_to_string(v_missing, ', ');
  end if;
end
$postcheck$;


-- =============================================================================
-- §4 🔴 回滾 SQL（第 1 階段）
--
-- 執行時機：任何時候（呢個階段本來就對 client 零影響）。
-- 只刪新政策同收回 authenticated 嘅 select；**唔會碰 anon**。
-- =============================================================================
-- drop policy if exists "pos_orders store scoped read" on public.pos_orders;
-- drop policy if exists "pos_print_jobs store scoped read" on public.pos_print_jobs;
-- drop policy if exists "pos_kds_item_state store scoped read" on public.pos_kds_item_state;
-- drop policy if exists "pos_store_status store scoped read" on public.pos_store_status;
-- drop policy if exists "pos_online_order_settings store scoped read" on public.pos_online_order_settings;
-- revoke select on table public.pos_orders                from authenticated;
-- revoke select on table public.pos_print_jobs            from authenticated;
-- revoke select on table public.pos_kds_item_state        from authenticated;
-- revoke select on table public.pos_store_status          from authenticated;
-- revoke select on table public.pos_online_order_settings from authenticated;


-- =============================================================================
-- §5 驗收查詢（貼呢幾句入 SQL Editor 睇結果）
-- =============================================================================
-- (1) 政策清單：5 張表每張應該見到「anon read recent / anon read」＋「store scoped read」＋「service only」
-- select tablename, policyname, cmd, roles::text
--   from pg_policies
--  where schemaname = 'public'
--    and tablename in ('pos_orders','pos_print_jobs','pos_kds_item_state',
--                      'pos_store_status','pos_online_order_settings')
--  order by tablename, policyname;
--
-- (2) 🔴 anon 行為必須完全唔變（即係「跑完之後同跑之前一樣」）
-- set role anon;
--   select count(*) from public.pos_orders;            -- 應該同跑之前一樣
--   select count(*) from public.pos_orders
--    where created_at < now() - interval '72 hours';   -- 應該係 0（窗口仍然生效）
-- reset role;
--
-- (3) authenticated 只讀到自己店（用一個手造嘅測試 JWT 於 PostgREST 側驗，
--     或者等第 2 階段 client 帶真 JWT 之後再驗）
--
-- (4) 確認 pos_soldout 完全冇被本檔改動
-- select tablename, policyname, roles::text
--   from pg_policies
--  where schemaname = 'public' and tablename = 'pos_soldout';
-- =============================================================================
