-- ============================================================================
-- 0048 · 每家店雲端用量計量（admin「雲端用量」頁）
-- ============================================================================
--
-- ## 為何要
--
-- Supabase Dashboard 只會俾**專案總數**，而一個專案裡面有**多間店**
-- （`pos_*` 全部按 `store_id` 隔離）⇒ 商家答唔到「邊間店食咗幾多」、
-- 「加多一間店會唔會爆 5 GB 免費額」。
--
-- 所以由自己嘅 route 記帳：每次回 response 都知 bytes（`jsonWithEgressLog`），
-- 經 `pos_bump_egress()` 累加落呢張表。
--
-- ## 成本控制（呢張表本身唔可以變成流量來源）
--
-- `src/lib/pos/egress-meter-server.ts` 用「記憶體緩衝 + 節流 flush」：
-- 同一個 `store|day|route` 最多每 60 秒（或累積 25 次／512 KB）才寫一次 DB
-- ⇒ 1 個 RPC 換一大批請求。估算：單店每日 ≤ 1 500 個 RPC（多數情況遠低於此）。
--
-- ## 口徑（admin 頁要寫明）
--
-- 量到嘅係「Vercel Function → 瀏覽器／APK」嘅 response bytes；
-- Supabase 帳單官方口徑係「Supabase → Vercel Function」。方向相反、數量級一致，
-- 用嚟做**店與店之間、路徑之間嘅相對比較**同趨勢觀察足夠；
-- 要精確對帳單請睇 Supabase Dashboard。
--
-- ## 安全
--
-- · 只 `service_role` 可讀寫（`anon` / `authenticated` 一律 revoke）。
-- · `store_id` 冇 FK（店舖主檔唔喺呢個 schema），但查詢一律按 `store_id` 過濾。
-- · RPC 係 `security definer` + 只 grant 畀 `service_role` ⇒ 瀏覽器就算有 anon key
--   都寫唔到假數字（同 `pos_claim_print_jobs` 同一模式）。

-- ── A. 表 ──────────────────────────────────────────────────────────────────
create table if not exists public.pos_egress_daily (
  store_id   text        not null,
  -- 澳門日期（server 端 +8 計算，唔可以用 UTC 日期，否則跨午夜會記錯日）
  day        date        not null,
  -- 邏輯路徑（例如 `pos/state`、`pos/print-jobs/status`）
  route      text        not null,
  calls      bigint      not null default 0,
  bytes      bigint      not null default 0,
  updated_at timestamptz not null default now(),
  primary key (store_id, day, route)
);

comment on table public.pos_egress_daily is
  '每家店每日每路徑嘅 response bytes／次數（2026-09-22 admin 用量頁用）。只 service_role 可讀寫。';

-- admin 頁最常用：「最近 N 日，全部店」→ (day desc) 掃描
create index if not exists pos_egress_daily_day_idx
  on public.pos_egress_daily (day desc);
-- 單店 drill-down
create index if not exists pos_egress_daily_store_day_idx
  on public.pos_egress_daily (store_id, day desc);

-- ── B. RLS：只有 service_role ──────────────────────────────────────────────
alter table public.pos_egress_daily enable row level security;

drop policy if exists "pos_egress_daily service only" on public.pos_egress_daily;
create policy "pos_egress_daily service only"
  on public.pos_egress_daily for all to service_role using (true) with check (true);

revoke all on table public.pos_egress_daily from public, anon, authenticated;
grant all on table public.pos_egress_daily to service_role;

-- ── C. 原子累加 RPC（1 次呼叫 ＝ 1 個 upsert，唔會 race）────────────────────
create or replace function public.pos_bump_egress(
  p_store_id text,
  p_day      date,
  p_route    text,
  p_calls    bigint default 1,
  p_bytes    bigint default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 冇 store_id 一律唔記（避免污染報表：所有查詢都按店分組）
  if p_store_id is null or length(trim(p_store_id)) = 0 then
    return;
  end if;

  insert into public.pos_egress_daily as e (store_id, day, route, calls, bytes, updated_at)
  values (
    p_store_id,
    coalesce(p_day, (now() at time zone 'Asia/Macau')::date),
    coalesce(nullif(trim(p_route), ''), 'other'),
    greatest(coalesce(p_calls, 0), 0),
    greatest(coalesce(p_bytes, 0), 0),
    now()
  )
  on conflict (store_id, day, route)
  do update set calls      = e.calls + greatest(coalesce(p_calls, 0), 0),
                bytes      = e.bytes + greatest(coalesce(p_bytes, 0), 0),
                updated_at = now();
end;
$$;

revoke all on function public.pos_bump_egress(text, date, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.pos_bump_egress(text, date, text, bigint, bigint) to service_role;

-- ── D. 清理舊記錄（可選，手動跑）─────────────────────────────────────────────
-- 保留 180 日就夠（免費層每店每日每路徑一行，180 日 × 3 路徑 ≈ 540 行／店，
-- 體積可忽略）。要清就跑：
--   delete from public.pos_egress_daily
--    where day < (now() at time zone 'Asia/Macau')::date - interval '180 days';

-- ============================================================================
-- 驗收（貼完之後跑）
-- ============================================================================
--
-- 1. 表 + RLS
--   select relname, relrowsecurity from pg_class where relname = 'pos_egress_daily';
--   → relrowsecurity = true
--
-- 2. anon 冇權
--   select has_table_privilege('anon', 'public.pos_egress_daily', 'SELECT');       -- false
--   select has_function_privilege('anon', 'public.pos_bump_egress(text,date,text,bigint,bigint)', 'EXECUTE'); -- false
--   select has_function_privilege('service_role', 'public.pos_bump_egress(text,date,text,bigint,bigint)', 'EXECUTE'); -- true
--
-- 3. 累加正確（連續跑兩次應該變 calls=3, bytes=300）
--   select public.pos_bump_egress('__test__', current_date, 'pos/state', 1, 100);
--   select public.pos_bump_egress('__test__', current_date, 'pos/state', 2, 200);
--   select calls, bytes from public.pos_egress_daily
--    where store_id = '__test__' order by day desc;
--   delete from public.pos_egress_daily where store_id = '__test__';
