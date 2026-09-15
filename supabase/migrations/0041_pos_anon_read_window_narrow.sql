-- =============================================================================
-- 0041 · 收窄 pos_orders 嘅 anon 讀取時間窗（14 日 → 72 小時）
--
-- 🔴 2026-09-15 實測狀態（用公開 anon key 對生產 POS 專案唯讀探測）：
--   · 0016 **已跑** —— pos_bootstrap_config / pos_device_configs / pos_queue_events /
--     pos_daily_sequences / inv_products / salon_orders / salon_customers 對 anon 全部 401；
--     anon POST pos_orders 亦 42501 被擋。✅
--   · 0021 **未跑** —— pos_print_jobs 經 anon 仍讀得到 ≈187 小時前嘅 row
--     （> 24 小時）⇒ policy 仍係 0016 嘅 14 日窗口。
--   · 跨店洩漏**確實存在** —— anon 讀 pos_orders 拎到 207 行、涉及 **3 間店**、橫跨 9 日；
--     pos_print_jobs 352 行、3 間店。
--
-- 所以要做兩件事：
--   【1】跑 `0021`（pos_print_jobs：14 日 → 24 小時）。**0021 已寫好，本檔唔重複。**
--   【2】跑本檔（pos_orders：14 日 → 72 小時）。
--
-- =============================================================================
-- 🔴🔴 最重要嘅一句：**唔可以**就咁畀 anon policy 加 `store_id` 過濾
-- =============================================================================
-- 直覺上「加 store_id 條件」就解決跨店。但實測 + 程式碼證明，咁樣會**靜默搞死 Realtime**：
--
--   1. 以下三個 client **全部用 anon key（公開值）** 訂閱 `postgres_changes`：
--        · 收銀台 / 快餐：`src/lib/pos/use-pos-realtime.ts`（pos_orders / pos_print_jobs / pos_soldout）
--        · 後廚 / 出餐屏：`src/lib/kds/use-kds-realtime.ts`（pos_orders / pos_kds_item_state）
--        · 雲端中繼機 Hub：`src/components/print-center.tsx` 相關流程（pos_print_jobs）
--   2. anon 身份**冇任何 store claim** ⇒ policy 寫 `store_id = <jwt 內嘅 store>` 時，
--      對 anon 永遠唔成立 ⇒ **一個事件都唔會推**。
--   3. 而 Supabase Realtime **唔會報錯**（channel 照樣 SUBSCRIBED）⇒ 正是 docs/113
--      「Realtime 靜默失效」同一型：畫面顯示已連線，但收銀台永遠收唔到新單。
--   4. 另外（`0021` 檔頭已記錄）：Realtime 對 **UPDATE / DELETE** 事件係用
--      **新 row / 舊 row** 去過 RLS SELECT policy，而 `created_at` 唔會變。
--      ⇒ 時間窗亦唔可以收得太短，否則「延遲認領 / 延遲結帳」嘅舊單事件會被擋。
--
-- ⇒ 真正嘅按店隔離**必須連同 token 機制一齊做**（見本檔 §3），唔可以淨改 SQL。
--   本檔只做「時間窗收窄」——對 web / KDS / Hub **行為零改變**（見下面 §1 取捨）。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- §1 pos_orders：anon 讀取窗口 14 日 → 72 小時（idempotent）
--
-- 為何係 72 小時而唔係 24 小時（保守取值）：
--   Realtime 嘅 UPDATE / DELETE 事件用 row 自身嘅 `created_at` 過 policy。
--   一張單由建立到「最後一次狀態變更」相隔幾耐，就決定窗口下限：
--     · 快餐：幾分鐘內完成 ⇒ 24 小時都非常充裕。
--     · 堂食：開枱 → 加菜 → 結帳，正常幾小時；跨夜長枱亦常見。
--     · 72 小時 = 3 日，遠超任何真實單據生命週期 ⇒ 實務上等同冇改變。
--   代價：經 PostgREST 可以摷到嘅歷史由 14 日縮到 3 日（減少約 4.7 倍），
--        而_**唔會**_影響 Realtime 即時事件（事件係即時，created_at ≈ now）。
--
-- 注意：console 若見到代碼查 `pos_orders` 舊於 72 小時嘅 UPDATE 而「消失」，
--       正確反應係查 `/api/pos/state`（service_role，**完全唔受呢條 policy 影響**）
--       或者靠 `sync-reconcile-daemon` 對賬補回 —— 呢兩條路本來就係設計好嘅兜底。
-- ---------------------------------------------------------------------------
revoke all on table public.pos_orders from anon, authenticated;
grant select on table public.pos_orders to anon;
grant all on table public.pos_orders to service_role;

drop policy if exists "pos_orders anon read" on public.pos_orders;
drop policy if exists "pos_orders anon read recent" on public.pos_orders;
create policy "pos_orders anon read recent" on public.pos_orders
  for select to anon
  using (coalesce(created_at, now()) >= now() - interval '72 hours');

drop policy if exists "pos_orders service only" on public.pos_orders;
create policy "pos_orders service only" on public.pos_orders
  for all to service_role using (true) with check (true);

-- ---------------------------------------------------------------------------
-- §2 pos_soldout 保持 using (true)（唔改）
-- 原因（0016 §3c 已記錄）：得 store_id + menu_item_id + sold_out 三格，
-- 無歷史、無 PII；收窄時間窗反而會令沽清狀態同步失效。
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §3 【根治 · 未做 · 需同 3 個 client 一齊改】按店隔離 anon 讀取
--
-- 🔴 唔可以單獨跑。前置條件齊全之前跑 = 收銀台 / KDS / Hub 靜默收唔到事件。
--
-- 前置條件（全部要人手做，唔可以寫落 migration）：
--   P1. Supabase Dashboard → Project Settings → API → 攞 **JWT Secret**
--   P2. 加落 Vercel（Production scope）：`SUPABASE_JWT_SECRET`
--       （server-only，**絕對唔可以**加 `NEXT_PUBLIC_` 前綴）
--   P3. 加一個端點簽發「per-store 短命 token」：claims = { role: "authenticated", store_id }
--       · 收銀台 / KDS：由已登入 session（`authSession.merchantId`）經 server 簽發
--       · Hub：沿用 `/api/pos/print-agent/pair`（佢已經有 agent token 驗權）
--       TTL 建議 24 小時，用每一輪 heartbeat / state 拉取順便換新。
--   P4. 改 3 個 client 由 anon key 改用呢個 token 去連 Realtime：
--       `use-pos-realtime.ts`、`use-kds-realtime.ts`、Hub 嘅 Realtime 訂閱。
--   P5. **驗收後**才落下面 §3a 嘅 policy（先落 = 上面三個 client 即刻死）。
--
-- §3a 落呢段（P1–P4 完成、且已實測 Realtime 收到 event 之後）：
--
--   drop policy if exists "pos_orders anon read recent" on public.pos_orders;
--   create policy "pos_orders store scoped read" on public.pos_orders
--     for select to authenticated
--     using (
--       store_id = coalesce(
--         current_setting('request.jwt.claims', true)::json ->> 'store_id',
--         ''
--       )
--       and coalesce(created_at, now()) >= now() - interval '72 hours'
--     );
--
--   drop policy if exists "pos_print_jobs anon read recent" on public.pos_print_jobs;
--   create policy "pos_print_jobs store scoped read" on public.pos_print_jobs
--     for select to authenticated
--     using (
--       store_id = coalesce(
--         current_setting('request.jwt.claims', true)::json ->> 'store_id',
--         ''
--       )
--     );
--
--   然後 `revoke select on ... from anon;`（anon 完全唔再需要讀呢兩張表）。
--
-- §3b Hub 嘅另一條路（唔使 JWT，最簡單）
--   中繼機改成**純輪詢** `POST /api/pos/print-agent/claim`（本身已有 agent token 驗權，
--   天然按店隔離），完全唔用 Realtime。代價＝出紙延遲由毫秒級升到輪詢間隔
--   （現時 60 秒對賬 tick 兜底）。若商家接受「最慢 60 秒」，呢條路風險最低。
--
-- §3c 另一條路（以 PostgREST header 換取「唔可以一次過 dump 全平台」）
--   理論上 policy 可讀 `current_setting('request.headers', true)::json ->> 'x-pos-store'`，
--   令匿名者必須逐間店試。**但唔建議**：storeId 就喺枱 QR 內（本來公開），
--   只係把「1 個 request 拎全部店」變成「每店 1 個 request」，而且 Realtime 是否帶到
--   自訂 header 未經驗證 ⇒ 有機會重蹈靜默失效。記錄在此僅為免日後重複討論。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- §4 驗收 SQL（貼完逐段跑）
-- ---------------------------------------------------------------------------
-- 4.1 兩張表嘅 select policy 同窗口
--   select tablename, policyname, roles, cmd, qual
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('pos_orders','pos_print_jobs','pos_soldout')
--    order by tablename, policyname;
--   期望：pos_orders → 72:00:00；pos_print_jobs → 24:00:00；pos_soldout → true
--
-- 4.2 anon 只有 SELECT（唔應該有 INSERT/UPDATE/DELETE）
--   select tablename,
--          has_table_privilege('anon', 'public.'||tablename, 'SELECT') as sel,
--          has_table_privilege('anon', 'public.'||tablename, 'INSERT') as ins,
--          has_table_privilege('anon', 'public.'||tablename, 'UPDATE') as upd,
--          has_table_privilege('anon', 'public.'||tablename, 'DELETE') as del
--     from pg_tables where schemaname = 'public' order by tablename;
--   期望：只有 pos_orders / pos_print_jobs / pos_soldout 嘅 sel = true；
--        所有 ins / upd / del 一律 false。
--
-- 4.3 實測時間窗（用 anon key 打 PostgREST）
--   curl "$POS_URL/rest/v1/pos_orders?select=created_at&order=created_at.asc&limit=1" \
--        -H "apikey: $POS_ANON_KEY" -H "Authorization: Bearer $POS_ANON_KEY"
--   期望：最早一筆距今 ≈ 3 日內（唔再係 14 日）。
--   同法測 pos_print_jobs → 距今 ≈ 24 小時內。
--
-- 4.4 🔴 **必做**：實測 Realtime 仍然通
--   去收銀台落一張測試單 → 另一部機 / KDS 要即刻見到（唔可以只靠 F5）。
--   現成工具：
--     node --env-file=.env.local tools/2026-09-11-check-pos-realtime.mjs --watch 20 --store <storeId>
--   （工具已內建「SUBSCRIBED ≠ 推送正常」嘅提醒，所以一定要用 --watch 落真單。）
--
-- 4.5 跨店仍然可見（已知限制）
--   curl "$POS_URL/rest/v1/pos_orders?select=store_id&limit=300" -H "apikey: ..." -H "Authorization: Bearer ..."
--   期望：仍然會見到多過一間店 ⇒ 呢個就係 §3 未做之前嘅**已知殘留風險**，
--        唔係 migration 冇跑。報告已記錄，唔好誤以為跑漏咗。
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- §5 回退
-- ---------------------------------------------------------------------------
-- update policy：回復 14 日窗口
-- drop policy if exists "pos_orders anon read recent" on public.pos_orders;
-- create policy "pos_orders anon read recent" on public.pos_orders
--   for select to anon
--   using (coalesce(created_at, now()) >= now() - interval '14 days');
--
-- 完全回復 0016 原狀（含 pos_print_jobs）：重跑 tools 內冇、但可直接貼：
--   drop policy if exists "pos_print_jobs anon read recent" on public.pos_print_jobs;
--   create policy "pos_print_jobs anon read recent" on public.pos_print_jobs
--     for select to anon
--     using (coalesce(created_at, now()) >= now() - interval '14 days');
