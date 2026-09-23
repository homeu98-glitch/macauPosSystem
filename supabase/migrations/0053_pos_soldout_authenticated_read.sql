-- =============================================================================
-- 0053 · per-store token 第 2 階段配套：`pos_soldout` 加 `authenticated` 讀取政策
--
-- 為何需要（🔴 唔加就會退化）：
--   POS 收銀台嘅瀏覽器 client（`getPosSupabaseClient()`）係**單例**，
--   一旦佢用匿名登入取得 Supabase Auth session，整個 client 嘅身份就由
--   `anon` 變成 **`authenticated`**：
--     · Realtime 嘅 WebSocket 只用**一條連線** ⇒ 連線嘅 role 一改，
--       **所有** channel（`pos_orders` / `pos_print_jobs` / `pos_soldout` /
--       `pos_kds_item_state` / `pos_store_status` / `pos_online_order_settings`）
--       嘅 RLS 檢查都由 `authenticated` 去跑；
--     · `soldout.ts` 仲會用同一個 client 直接 PostgREST 讀 `pos_soldout`。
--   而 `0016` 對 `pos_soldout` 做過 `revoke all ... from anon, authenticated`
--   ＋只 `grant select ... to anon` ⇒ **`authenticated` 目前完全讀唔到**。
--   ⇒ 唔補呢條政策，就會出現：
--       · 收銀台「售罄」即時標記靜默失效（客人端唔會灰化售罄菜）；
--       · 更嚴重嘅係 `pos_soldout` channel 收唔到事件 —— 而 Realtime **唔會報錯**
--         （channel 照樣 `SUBSCRIBED`），即 docs/113「靜默失效」同一型。
--
-- 為何畀 `authenticated` `using (true)` 係安全嘅：
--   呢張表**而家已經對 anon 開放 `using (true)`**（0016 §3c 明文決定）。
--   anon 係「任何人都係」，所以開放畀 `authenticated` **唔會增加任何曝露面**；
--   表只有 `store_id` + `menu_item_id` + `sold_out` 三格、冇歷史、冇 PII。
--   ⚠️ 亦**唔可以**順手改成按 store 過濾 —— 客人掃碼／kiosk 係匿名，
--      永遠拿唔到 store claim（見 assessment 文件 §2）。
--
-- -----------------------------------------------------------------------------
-- 🔴 鐵律（同 0051 / 0052 一致）
-- -----------------------------------------------------------------------------
-- 1. **唔會 touch 任何 anon 政策**（加性推進，零停機嘅全部前提）。
-- 2. 本檔執行後**系統行為零改變** —— 因為未有 client 用 authenticated 身份。
-- 3. 唔可以 `revoke` 任何嘢：只加 grant ＋ 加政策。
-- 4. 要喺 Supabase SQL Editor 貼得通（唔可以用 psql 專屬語法）。
-- =============================================================================


-- ---------------------------------------------------------------------------
-- §0 前置條件檢查：`pos_soldout` 嘅 anon 政策必須仍然存在
--     （若果已經被人收走，代表「加性推進」嘅前提破咗，要即刻停低查）
-- ---------------------------------------------------------------------------
do $preflight$
declare
  v_anon  boolean;
  v_grant boolean;
begin
  select exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename  = 'pos_soldout'
      and p.cmd        = 'SELECT'
      and 'anon' = any (p.roles::text[])
  ) into v_anon;

  select has_table_privilege('anon', 'public.pos_soldout', 'SELECT') into v_grant;

  if not v_anon or not v_grant then
    raise exception
      '前置條件唔成立：pos_soldout 嘅 anon SELECT 政策／權限唔見咗（policy=% grant=%）。'
      '客人掃碼／kiosk 係匿名讀呢張表，收走咗就係客人落唔到單。',
      v_anon, v_grant;
  end if;
end
$preflight$;


-- ---------------------------------------------------------------------------
-- §1 只加：`authenticated` 讀取權 ＋ 讀取政策（`using (true)`，同 anon 完全一致）
-- ---------------------------------------------------------------------------
alter table public.pos_soldout enable row level security;

grant select on table public.pos_soldout to authenticated;

drop policy if exists "pos_soldout authenticated read" on public.pos_soldout;
create policy "pos_soldout authenticated read" on public.pos_soldout
  for select to authenticated
  using (true);

-- ⚠️ 既有嘅 `pos_soldout anon read`（using true）同 `pos_soldout service only`
--    一律保持不變。本檔完全冇 drop 過任何 anon 政策。


-- ---------------------------------------------------------------------------
-- §2 執行後自我檢查
-- ---------------------------------------------------------------------------
do $postcheck$
declare
  v_new   boolean;
  v_anon  boolean;
  v_grant boolean;
begin
  select exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename  = 'pos_soldout'
      and p.policyname = 'pos_soldout authenticated read'
      and 'authenticated' = any (p.roles::text[])
  ) into v_new;

  select exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename  = 'pos_soldout'
      and p.cmd        = 'SELECT'
      and 'anon' = any (p.roles::text[])
  ) into v_anon;

  select has_table_privilege('authenticated', 'public.pos_soldout', 'SELECT') into v_grant;

  if not v_new then
    raise exception '0053 自我檢查失敗：新政策 pos_soldout authenticated read 唔存在';
  end if;
  if not v_anon then
    raise exception '0053 自我檢查失敗：pos_soldout 嘅 anon 政策唔見咗（本檔唔應該影響佢）';
  end if;
  if not v_grant then
    raise exception '0053 自我檢查失敗：authenticated 冇 pos_soldout 嘅 SELECT 權限';
  end if;

  -- 防手誤：確認冇加過任何寫入權限
  if has_table_privilege('authenticated', 'public.pos_soldout', 'INSERT')
     or has_table_privilege('authenticated', 'public.pos_soldout', 'UPDATE')
     or has_table_privilege('authenticated', 'public.pos_soldout', 'DELETE') then
    raise exception '0053 自我檢查失敗：authenticated 竟然有 pos_soldout 嘅寫入權限（只准 SELECT）';
  end if;
end
$postcheck$;


-- =============================================================================
-- §3 回滾（貼咗之後想還原：只刪新政策 ＋ 收回 authenticated 嘅 select；唔碰 anon）
-- =============================================================================
-- drop policy if exists "pos_soldout authenticated read" on public.pos_soldout;
-- revoke select on table public.pos_soldout from authenticated;


-- =============================================================================
-- §4 驗收查詢
-- =============================================================================
-- (1) pos_soldout 應該有 3 條政策：anon read（true）／authenticated read（true）／service only
-- select policyname, cmd, roles::text, qual
--   from pg_policies
--  where schemaname = 'public' and tablename = 'pos_soldout'
--  order by policyname;
--
-- (2) anon 行為必須完全唔變
-- set role anon;
--   select count(*) from public.pos_soldout;
-- reset role;
--
-- (3) 🔴 其餘五張表嘅 anon 政策必須仍然存在（本檔唔應該影響佢哋）
-- select tablename, policyname, roles::text
--   from pg_policies
--  where schemaname = 'public'
--    and tablename in ('pos_orders','pos_print_jobs','pos_kds_item_state',
--                      'pos_store_status','pos_online_order_settings')
--    and 'anon' = any (roles::text[])
--  order by tablename, policyname;
-- =============================================================================
