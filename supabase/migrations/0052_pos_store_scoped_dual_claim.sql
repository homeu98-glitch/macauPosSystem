-- =============================================================================
-- 0052 · per-store token 第 1 階段（補強）：令 store 政策同時接受兩種 claim 位置
--
-- 背景：0051 已經執行（用戶 2026-09-23 跑過），佢寫嘅係：
--         store_id = (auth.jwt() ->> 'store_id')          ← 頂層 claim
--
-- 但 2026-09-23 睇 Supabase Dashboard 之後發現一個關鍵事實：
--   🔴 該專案**已經由 legacy HS256 shared secret 輪換到非對稱簽名金鑰（ECC P-256）**
--      （Current key = ECC P-256；Legacy HS256 只係「PREVIOUS KEY」，2 個月前輪換走）。
--   而 Supabase 官方明文：**私鑰／shared secret 無法由 Supabase 取出**
--      （docs/guides/auth/signing-keys →「Why is it not possible to extract the
--        private key or shared secret from Supabase?」）。
--   ⇒ **「用 Current key 自簽 JWT」技術上唔存在**。
--
-- 所以真正可行嘅路只有兩條（另一條完全唔用 JWT，見評估文件 §3）：
--   ① **Supabase Auth 簽發**（推薦）：終端／中繼機用 anonymous sign-in 取得
--      `authenticated` role 嘅 JWT，server 再用 Admin API 把 `store_id` 寫入
--      **`app_metadata`**（只有 service_role 寫得入，用戶改唔到）。
--      ⇒ claim 位置 ＝ `auth.jwt() -> 'app_metadata' ->> 'store_id'`
--      ⇒ ✅ 零密鑰管理、官方支援、有官方 refresh 機制
--   ② Legacy JWT Secret 自簽 HS256：官方明文「Not recommended for production
--      applications」，而且本專案已經輪換走嗰把 key（會被 revoke）⇒ 唔建議。
--
-- 本檔做一件小事：把 0051 嘅 5 條政策**換成「兩個位置都認」**：
--      coalesce(
--        auth.jwt() -> 'app_metadata' ->> 'store_id',   -- 路徑 ①
--        auth.jwt() ->> 'store_id'                      -- 路徑 ②（保留兼容）
--      )
-- ⇒ 將來無論揀邊條路，**都唔需要再改一次 policy**；
--   而政策對「用邊種機制簽發」保持中立，係呢類工程最想做到嘅性質。
--
-- -----------------------------------------------------------------------------
-- 🔴 同 0051 一樣嘅鐵律（唔可以違反）
-- -----------------------------------------------------------------------------
-- 1. **絕對唔會 touch 任何 anon 政策** —— 加性推進，「零停機」嘅全部前提。
-- 2. 目前**冇任何 client 攜帶 JWT** ⇒ 本檔執行之後**系統行為依然零改變**。
-- 3. 時間窗唔可以比 anon 更短（pos_orders ≥72h、pos_print_jobs ≥24h）——
--    Realtime 嘅 UPDATE／DELETE 事件用 **row 自身 `created_at`** 過 policy。
-- 4. `coalesce(created_at, now())` 唔可以省（`created_at` 可以係 null ⇒ 否則永遠讀唔到）。
-- 5. `pos_soldout` 唔喺範圍（匿名客人端讀，永遠拿唔到 token）。
-- 6. 本檔要喺 **Supabase SQL Editor** 貼得通（唔可以用 psql 專屬語法）。
-- =============================================================================


-- ---------------------------------------------------------------------------
-- §0 前置條件檢查（同 0051 一致：anon 政策必須仍然存在）
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
      select 1 from pg_policies p
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
      '0052 係「加性推進」（必須保留 anon），請先確認 anon 政策仍然存在。',
      array_to_string(v_missing, ', ');
  end if;
end
$preflight$;


-- ---------------------------------------------------------------------------
-- §1 逐表換成「雙位置 claim」版本（先 drop 舊，再 create 新；anon 完全唔碰）
-- ---------------------------------------------------------------------------

-- 1a) pos_orders（72 小時）
drop policy if exists "pos_orders store scoped read" on public.pos_orders;
create policy "pos_orders store scoped read" on public.pos_orders
  for select to authenticated
  using (
    store_id = coalesce(
      auth.jwt() -> 'app_metadata' ->> 'store_id',
      auth.jwt() ->> 'store_id'
    )
    and coalesce(created_at, now()) >= now() - interval '72 hours'
  );

-- 1b) pos_print_jobs（24 小時）
drop policy if exists "pos_print_jobs store scoped read" on public.pos_print_jobs;
create policy "pos_print_jobs store scoped read" on public.pos_print_jobs
  for select to authenticated
  using (
    store_id = coalesce(
      auth.jwt() -> 'app_metadata' ->> 'store_id',
      auth.jwt() ->> 'store_id'
    )
    and coalesce(created_at, now()) >= now() - interval '24 hours'
  );

-- 1c) pos_kds_item_state（後廚；PK 首欄就係 store_id ⇒ 索引可用）
drop policy if exists "pos_kds_item_state store scoped read" on public.pos_kds_item_state;
create policy "pos_kds_item_state store scoped read" on public.pos_kds_item_state
  for select to authenticated
  using (
    store_id = coalesce(
      auth.jwt() -> 'app_metadata' ->> 'store_id',
      auth.jwt() ->> 'store_id'
    )
  );

-- 1d) pos_store_status
drop policy if exists "pos_store_status store scoped read" on public.pos_store_status;
create policy "pos_store_status store scoped read" on public.pos_store_status
  for select to authenticated
  using (
    store_id = coalesce(
      auth.jwt() -> 'app_metadata' ->> 'store_id',
      auth.jwt() ->> 'store_id'
    )
  );

-- 1e) pos_online_order_settings
drop policy if exists "pos_online_order_settings store scoped read" on public.pos_online_order_settings;
create policy "pos_online_order_settings store scoped read" on public.pos_online_order_settings
  for select to authenticated
  using (
    store_id = coalesce(
      auth.jwt() -> 'app_metadata' ->> 'store_id',
      auth.jwt() ->> 'store_id'
    )
  );

-- 1f) pos_soldout —— 再次明確：唔喺範圍，維持 anon `using (true)`。


-- ---------------------------------------------------------------------------
-- §2 執行後自我檢查
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
    -- (a) 新政策存在，而且同時認兩個 claim 位置
    if not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = v_tbl
        and p.policyname = v_tbl || ' store scoped read'
        and 'authenticated' = any (p.roles::text[])
        and p.qual like '%app_metadata%'
        and p.qual like '%store_id%'
    ) then
      v_missing := v_missing || (v_tbl || '(雙位置政策)');
    end if;

    -- (b) 🔴 anon 政策必須仍然存在
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
    raise exception '0052 自我檢查失敗 → %', array_to_string(v_missing, ', ');
  end if;
end
$postcheck$;


-- =============================================================================
-- §3 回滾 SQL（貼咗 0052 之後想回到 0051 嘅狀態）
-- 只還原政策定義；兩者都對 client 零影響（因為仲未有人帶 JWT）。
-- =============================================================================
-- drop policy if exists "pos_orders store scoped read" on public.pos_orders;
-- create policy "pos_orders store scoped read" on public.pos_orders
--   for select to authenticated
--   using (store_id = (auth.jwt() ->> 'store_id')
--          and coalesce(created_at, now()) >= now() - interval '72 hours');
-- drop policy if exists "pos_print_jobs store scoped read" on public.pos_print_jobs;
-- create policy "pos_print_jobs store scoped read" on public.pos_print_jobs
--   for select to authenticated
--   using (store_id = (auth.jwt() ->> 'store_id')
--          and coalesce(created_at, now()) >= now() - interval '24 hours');
-- drop policy if exists "pos_kds_item_state store scoped read" on public.pos_kds_item_state;
-- drop policy if exists "pos_store_status store scoped read" on public.pos_store_status;
-- drop policy if exists "pos_online_order_settings store scoped read" on public.pos_online_order_settings;
-- ⇒ 或者直接跑 0051 檔尾 §4（完全移除 5 條政策）。


-- =============================================================================
-- §4 驗收查詢
-- =============================================================================
-- (1) 5 條政策都要見到 app_metadata（雙位置）
-- select tablename, policyname, roles::text, qual
--   from pg_policies
--  where schemaname = 'public'
--    and policyname like '%store scoped read'
--  order by tablename;
--
-- (2) 🔴 anon 行為必須完全唔變
-- set role anon;
--   select count(*) from public.pos_orders;
--   select count(*) from public.pos_orders
--    where created_at < now() - interval '72 hours';   -- 應該係 0
-- reset role;
--
-- (3) pos_soldout 完全冇被改動
-- select tablename, policyname, roles::text
--   from pg_policies
--  where schemaname = 'public' and tablename = 'pos_soldout';
-- =============================================================================
