-- 0020 · 雲端列印中繼（iPad / web POS → Supabase → Sunmi APK → 打印機）
-- 對應 docs/96 §5，客戶端：C:\dev\print-agent-android（v1.1.0 / versionCode 5）
--
-- 背景：iPad 跑 web POS（HTTPS）冇辦法直連 LAN 打印機（HTTP:9100）——
-- active mixed content 一定被擋；被動內容（<img>）遇到 IP literal 亦會被擋。
-- 所以由一部 Android 中繼機（Sunmi V2）訂閱 Supabase，拎單出紙。
--
-- ───────────────────────────────────────────────────────────
-- ⚠️ 寫咗 migration ≠ 跑咗 migration（已踩兩次：0018、0019）
--    本機冇 .env.local / DB 連線 / supabase/config.toml → `supabase db push` 跑唔到，
--    要人手去 Supabase Dashboard → SQL Editor 貼呢段，貼完用下面 §驗收 做 curl 驗證。
-- ───────────────────────────────────────────────────────────
-- 全部 idempotent（if not exists / create or replace），可以重複貼。

-- ── A. pos_print_jobs 加欄位 ───────────────────────────────
alter table public.pos_print_jobs
  add column if not exists printer        jsonb,      -- 完整 DevicePrinterConfig（ip/lanPort/charset/kanjiEnlarge/copies…）
  add column if not exists kind           text,       -- receipt|kitchen|label|test
  add column if not exists store_name     text,
  add column if not exists payment_method text,
  add column if not exists total          numeric,
  add column if not exists qr             jsonb,      -- {size, bits}（POS 端 encode 好，三倉共用同一個矩陣）
  add column if not exists qr_url         text,
  add column if not exists copies         int,
  add column if not exists ttl            bigint,     -- epoch millis；過期就唔好再印（避免隔夜單突然出紙）
  add column if not exists updated_at     timestamptz,
  add column if not exists claimed_by     text,
  add column if not exists claimed_at     timestamptz,
  add column if not exists attempts       int default 0,
  add column if not exists last_error     text,
  add column if not exists finished_at    timestamptz;

create index if not exists pos_print_jobs_queue_idx
  on public.pos_print_jobs (store_id, status, created_at);

-- ── B. 中繼機登記 ──────────────────────────────────────────
create table if not exists public.pos_print_agents (
  agent_id     text primary key,
  store_id     text not null,
  name         text,
  token_hash   text not null,          -- 只存 hash（sha256），明文 token 只喺配對嗰一刻交付一次
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists pos_print_agents_store_idx
  on public.pos_print_agents (store_id);

-- 0016 已經回收 default privileges，但新表都要顯式上鎖，唔好靠 default。
alter table public.pos_print_agents enable row level security;
revoke all on table public.pos_print_agents from anon, authenticated;
grant all on table public.pos_print_agents to service_role;
drop policy if exists "pos_print_agents service only" on public.pos_print_agents;
create policy "pos_print_agents service only"
  on public.pos_print_agents for all to service_role using (true) with check (true);

-- ── C. 原子拎單（防重複打印）────────────────────────────────
-- 點解一定要 `for update skip locked`：兩部中繼機同時收到 INSERT 事件時，
-- 第一個拎走並鎖住，第二個直接 skip → 物理上唔可能重複打印。
-- `attempts < 5` 對齊現有 MAX_SYNC_ATTEMPTS = 5 嘅「失敗留底」語義。
-- `claimed_at < now() - 60s`：認領咗但冇回報（機死咗）→ 60s 後畀第啲機接手。
create or replace function public.pos_claim_print_jobs(
  p_store_id text,
  p_agent_id text,
  p_limit    int default 5
)
returns setof public.pos_print_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select j.id
      from public.pos_print_jobs j
     where j.store_id = p_store_id
       and j.status in ('pending', 'failed')
       and coalesce(j.attempts, 0) < 5
       and (j.ttl is null or j.ttl > (extract(epoch from now()) * 1000)::bigint)
       and (j.claimed_by is null or j.claimed_at < now() - interval '60 seconds')
     order by j.created_at
     for update skip locked
     limit greatest(p_limit, 1)
  )
  update public.pos_print_jobs j
     set claimed_by  = p_agent_id,
         claimed_at  = now(),
         status      = 'printing',
         attempts    = coalesce(j.attempts, 0) + 1,
         updated_at  = now()
    from picked p
   where j.id = p.id
  returning j.*;
end;
$$;

revoke all on function public.pos_claim_print_jobs(text, text, int) from public, anon;
grant execute on function public.pos_claim_print_jobs(text, text, int) to service_role;

-- ============================================================================
-- 驗收（貼完之後跑）
-- ============================================================================
--
-- 1. 新欄位喺度
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='pos_print_jobs'
--      and column_name in ('printer','kind','store_name','payment_method','total',
--                          'qr','qr_url','copies','ttl','updated_at','claimed_by',
--                          'claimed_at','attempts','last_error','finished_at');
--   → 15 行
--
-- 2. 中繼機表喺度 + RLS 上咗鎖
--   select relname, relrowsecurity from pg_class where relname = 'pos_print_agents';
--   → relrowsecurity = true
--
-- 3. RPC 喺度，而且 anon 冇權
--   select has_function_privilege('anon', 'public.pos_claim_print_jobs(text,text,int)', 'EXECUTE');
--   → false
--   select has_function_privilege('service_role', 'public.pos_claim_print_jobs(text,text,int)', 'EXECUTE');
--   → true
--
-- 4. 空跑一次（唔會報錯，淨係返 0 行）
--   select count(*) from public.pos_claim_print_jobs('__no_such_store__', 'probe', 5);
--   → 0
-- ============================================================================
