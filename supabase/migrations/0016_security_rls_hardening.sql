-- 0016 · 安全加固：RLS 全面開啟 + 最小權限回收
-- 對應 docs/89 §2（資安修復）。**呢份係破壞性權限變更，上線前必須確認部署環境已設
-- `SUPABASE_SERVICE_ROLE_KEY`**，否則 server 端會 fallback 去 anon key 而全部讀寫失敗。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 修緊乜（現狀風險）
-- ─────────────────────────────────────────────────────────────────────────────
-- Supabase 專案對 `public` schema 設有 default privileges：新表自動
-- `grant all ... to anon, authenticated, service_role`。而 `NEXT_PUBLIC_SUPABASE_ANON_KEY`
-- 係 **編譯入瀏覽器 bundle 嘅公開值**（見 src/lib/pos/supabase-client.ts），任何人
-- 開 devtools 就拎到。於是：
--
--   A. 5 張表 **完全冇 RLS** → 拎住 anon key 可以任意 SELECT / INSERT / UPDATE / DELETE：
--        inv_products、inv_stock_movements、pos_bootstrap_config、pos_device_configs、
--        pos_queue_events、pos_daily_sequences
--      （pos_device_configs.local_settings 係成個終端設定 JSONB；pos_bootstrap_config
--        係餐牌 / 枱位 / 打印機組態。可被任意篡改或清空。）
--
--   B. 12 張 salon 表 + pos_kiosk_settings 係 `for all using (true) with check (true)`
--      → anon 可任意改寫 / 刪除（salon_customers 含 customer_phone = 客人 PII；
--        pos_kiosk_settings 可被翻「自動接自助單」開關）。
--
--   C. pos_orders / pos_print_jobs / pos_soldout 已開 RLS 但 `using (true)`
--      → 跨店可讀全部歷史單（無 PII，但係完整營收 / 菜單 / 枱號資料）。
--      好消息：policy 係 `for select`，寫入已被 RLS 擋住。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 修復策略
-- ─────────────────────────────────────────────────────────────────────────────
--   1. 回收 public schema 嘅 default privileges（防將來新表再中同一個坑）
--   2. server-only 表：開 RLS + service_role-only policy + revoke anon/authenticated
--   3. Realtime 三張表：anon 只留 SELECT（不可寫），並收窄做「近 14 日」
--   4. next_daily_sequence() 唔再畀 anon 直接 call
--
-- 冇動任何資料、冇 drop 任何表、冇改任何欄位。全部 idempotent，可重複執行。
-- ============================================================================


-- ============================================================================
-- 1) 防止將來新表外洩：回收 public schema 嘅 default privileges
--    只回收 anon / authenticated；service_role 同 postgres 不受影響。
-- ============================================================================
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;


-- ============================================================================
-- 2) server-only 表：開 RLS + service_role-only policy + 回收 anon / authenticated
--
--    點解敢全收：
--      - salon_*   → 全部經 /api/salon/{sync,state,bootstrap}（server service_role）。
--                    瀏覽器完全冇直連（src 內搵唔到任何 createClient 連 salon 表）。
--      - pos_bootstrap_config / pos_device_configs / pos_queue_events
--                  → 全部經 /api/pos/{bootstrap,device-config,state,sync}。
--      - pos_kiosk_settings    → 經 /api/pos/kiosk-settings。
--      - pos_daily_sequences   → 經 /api/pos/sequence（server rpc）。
--      - inv_products / inv_stock_movements
--                  → 經 /api/inventory/products/**。
--    全部寫入路徑都喺 server，用 service_role（BYPASSRLS）→ 收 RLS 唔會影響功能。
-- ============================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    -- salon（12 張）
    'salon_bootstrap_config',
    'salon_bookings',
    'salon_orders',
    'salon_customers',
    'salon_print_jobs',
    'salon_queue_events',
    'salon_package_templates',
    'salon_customer_packages',
    'salon_products',
    'salon_product_sales',
    'salon_staff_leaves',
    'salon_staff_shifts',
    -- pos 設定 / 序號（5 張）
    'pos_bootstrap_config',
    'pos_device_configs',
    'pos_queue_events',
    'pos_kiosk_settings',
    'pos_daily_sequences',
    -- 庫存（2 張）
    'inv_products',
    'inv_stock_movements'
  ] loop
    if to_regclass('public.' || t) is null then
      raise notice '0016: skip %（表唔存在，可能未跑對應 migration）', t;
      continue;
    end if;

    -- 2a) 開 RLS。冇任何 anon/authenticated policy = 兩個 role 一律食閉門羹
    --     （service_role 有 BYPASSRLS，照行）。
    execute format('alter table public.%I enable row level security', t);

    -- 2b) 清走 0005 / 0006 / 0007 / 0015 建落嘅 permissive allow_all
    execute format('drop policy if exists %I on public.%I', t || '_allow_all', t);
    execute format('drop policy if exists %I on public.%I', 'anon_all_' || t, t);

    -- 2c) 建 service_role-only policy（service_role 本來就 bypass，呢條係顯式文檔化 + 雙保險）
    execute format('drop policy if exists %I on public.%I', t || '_service_only', t);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      t || '_service_only', t
    );

    -- 2d) 回收 anon / authenticated 一切權限（RLS 之外再落一道閘，depth in depth）
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;


-- ============================================================================
-- 3) Realtime 三張表：anon 只保留 SELECT，並收窄時間窗
--
--    點解唔可以全收：src/lib/pos/use-pos-realtime.ts 用瀏覽器 anon client 訂閱
--    postgres_changes（pos_orders / pos_print_jobs / pos_soldout，filter store_id）。
--    Supabase Realtime 會以 anon role 跑 RLS 檢查 → 一定要留 SELECT。
--
--    收窄做 14 日嘅取捨：
--      - 好處：就算 anon key 外洩，都只會漏近 14 日，拎唔走全部歷史營收。
--      - 代價：14 日前嘅舊單若有 UPDATE / DELETE，realtime 唔會推畀收銀。
--        實務上 kiosk 單係「即刻建、幾分鐘內更新」，舊單唔會再變；
--        而且 `/api/pos/state`（service_role，唔受呢條 policy 影響）仍然讀到全量。
--      - 已知限制（TODO）：真正嘅多租戶隔離要 store 級過濾，而 anon JWT 冇 store claim。
--        長遠做法係收銀 realtime 改行 server 端授權通道（per-store signed token / SSE proxy），
--        屆時呢三張表都可以收做 service_role-only。
-- ============================================================================

-- 3a) pos_orders
revoke all on table public.pos_orders from anon, authenticated;
grant select on table public.pos_orders to anon;
grant all on table public.pos_orders to service_role;

drop policy if exists "pos_orders anon read" on public.pos_orders;
drop policy if exists "pos_orders anon read recent" on public.pos_orders;
create policy "pos_orders anon read recent" on public.pos_orders
  for select to anon
  using (coalesce(created_at, now()) >= now() - interval '14 days');

drop policy if exists "pos_orders service only" on public.pos_orders;
create policy "pos_orders service only" on public.pos_orders
  for all to service_role using (true) with check (true);

-- 3b) pos_print_jobs
revoke all on table public.pos_print_jobs from anon, authenticated;
grant select on table public.pos_print_jobs to anon;
grant all on table public.pos_print_jobs to service_role;

drop policy if exists "pos_print_jobs anon read" on public.pos_print_jobs;
drop policy if exists "pos_print_jobs anon read recent" on public.pos_print_jobs;
create policy "pos_print_jobs anon read recent" on public.pos_print_jobs
  for select to anon
  using (coalesce(created_at, now()) >= now() - interval '14 days');

drop policy if exists "pos_print_jobs service only" on public.pos_print_jobs;
create policy "pos_print_jobs service only" on public.pos_print_jobs
  for all to service_role using (true) with check (true);

-- 3c) pos_soldout：得 store_id + menu_item_id + sold_out 三格，無歷史、無 PII，
--     保留 using (true)（收窄時間窗反而會令沽清狀態同步失效）。
revoke all on table public.pos_soldout from anon, authenticated;
grant select on table public.pos_soldout to anon;
grant all on table public.pos_soldout to service_role;

drop policy if exists "pos_soldout anon read" on public.pos_soldout;
create policy "pos_soldout anon read" on public.pos_soldout
  for select to anon using (true);

drop policy if exists "pos_soldout service only" on public.pos_soldout;
create policy "pos_soldout service only" on public.pos_soldout
  for all to service_role using (true) with check (true);


-- ============================================================================
-- 4) 函數：next_daily_sequence() 唔再畀 anon 直接 call
--    0012 當初 grant 咗畀 anon（「視部署」），但實際只經 /api/pos/sequence 用
--    service_role call（src/app/api/pos/sequence/route.ts L42）。呢個函數會
--    INSERT/UPDATE pos_daily_sequences，公開 call = 任何人可以亂推單號。
-- ============================================================================
do $$
begin
  if to_regprocedure('public.next_daily_sequence(text, text)') is not null then
    revoke all on function public.next_daily_sequence(text, text) from public;
    revoke all on function public.next_daily_sequence(text, text) from anon, authenticated;
    grant execute on function public.next_daily_sequence(text, text) to service_role;
  end if;
end $$;


-- ============================================================================
-- 5) 驗收（喺 Supabase SQL Editor 跑，全部要符合預期）
-- ============================================================================
--
-- 5.1 所有業務表都應該開咗 RLS（relrowsecurity = true）
--   select relname, relrowsecurity, relforcerowsecurity
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relkind = 'r'
--   order by relname;
--   → 全部 relrowsecurity 都係 true
--
-- 5.2 anon 唔應該喺任何業務表有 INSERT / UPDATE / DELETE
--   select tablename,
--          has_table_privilege('anon', tablename, 'SELECT')     as anon_select,
--          has_table_privilege('anon', tablename, 'INSERT')     as anon_insert,
--          has_table_privilege('anon', tablename, 'UPDATE')     as anon_update,
--          has_table_privilege('anon', tablename, 'DELETE')     as anon_delete
--   from pg_tables where schemaname = 'public' order by tablename;
--   → 只有 pos_orders / pos_print_jobs / pos_soldout 嘅 anon_select = true，
--     其餘全部（尤其所有 anon_insert/update/delete）都必須 = false
--
-- 5.3 冇任何 policy 係 FOR ALL + using(true) 而唔限定 service_role
--   select schemaname, tablename, policyname, roles, cmd, qual
--   from pg_policies
--   where schemaname = 'public' and cmd = 'ALL' and qual = 'true'
--     and not (roles @> '{service_role}'::name[] and array_length(roles, 1) = 1);
--   → 應該 0 行
--
-- 5.4 default privileges 已回收（之後新表唔會自動公開）
--   select * from pg_default_acl d
--   join pg_namespace n on n.oid = d.defaclnamespace
--   where n.nspname = 'public';
--   → 唔應該再有 anon / authenticated 嘅 entry
--
-- 5.5 實測（用 anon key 打 PostgREST，應該全部失敗）
--   curl "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/salon_orders?select=*" \
--        -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY"
--   → 應該空陣列或 401/403（而唔係出到訂單資料）
--
--   curl -X POST "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/salon_orders" \
--        -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
--        -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
--        -H "Content-Type: application/json" -d '{"id":"hack"}'
--   → 必須失敗（401/403/42501）
--
-- 5.6 Realtime 仍然通（用返個 app 測：kiosk 落一張單，收銀要即刻見到）
-- ============================================================================
