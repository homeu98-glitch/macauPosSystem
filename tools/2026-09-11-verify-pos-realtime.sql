-- =============================================================================
-- 2026-09-11 · 驗證「POS 專案本身」係唔係 realtime-ready
-- 對應：收銀台「即時通知未生效，新單唔會自動彈出」P0
--
-- ⚠️ 一定要喺 **POS 自有專案**（= server 端 SUPABASE_URL 嗰個）嘅 SQL Editor 跑，
--    唔係 Ledger 專案。下面 §0 就係用嚟自我識別「你係咪跑喺 POS 專案」。
--
-- 背景：server 寫單去 POS 專案，但瀏覽器 Realtime 經 `NEXT_PUBLIC_SUPABASE_URL`
--       訂緊 Ledger 專案（`zymdemjflsckicwcinxl`，冇 pos_orders）→ 靜默收唔到推送。
--       本檔只負責證明「POS 專案本身冇問題、加完 env 之後一定通」。
-- =============================================================================


-- ── §0 專案自我識別（唔係 POS 專案會即刻見到）────────────────────────────
-- 預期：三張表都存在且有數；Ledger 專案會直接拋 relation does not exist。
select 'pos_orders'            as tbl, count(*) as rows from public.pos_orders
union all
select 'pos_print_jobs',               count(*) from public.pos_print_jobs
union all
select 'pos_soldout',                  count(*) from public.pos_soldout
union all
select 'pos_online_order_settings',    count(*) from public.pos_online_order_settings
order by tbl;


-- ── §1 publication：三張表有冇入 supabase_realtime（← 目前唯一未確認項）──
-- 預期：pos_orders / pos_print_jobs 一定要喺度；pos_soldout 視乎 0010 有冇跑。
-- ⚠️ 唔喺度就係「永遠收唔到推送」嘅第二個原因（即使 env 改對都唔會通）。
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;


-- ── §1b 若 §1 見到有缺：補入 publication（idempotent，重跑安全）────────
-- ⚠️ 要逐條跑，加已存在嘅表會報 "already member of publication"（無害）。
-- alter publication supabase_realtime add table public.pos_orders;
-- alter publication supabase_realtime add table public.pos_print_jobs;
-- alter publication supabase_realtime add table public.pos_soldout;

-- 或者用動態版本一次過補齊（推薦，唔會因已存在而報錯）：
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['pos_orders','pos_print_jobs','pos_soldout'] loop
--     if to_regclass('public.' || t) is null then
--       raise notice 'skip %（表唔存在）', t;
--       continue;
--     end if;
--     if exists (
--       select 1 from pg_publication_tables
--       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
--     ) then
--       raise notice 'ok %（已在 publication）', t;
--       continue;
--     end if;
--     execute format('alter publication supabase_realtime add table public.%I', t);
--     raise notice 'added %', t;
--   end loop;
-- end $$;


-- ── §2 RLS + anon 讀取權（Realtime 以 anon role 過 RLS，冇 SELECT 就唔會推）──
-- 預期：
--   · pos_orders        → policy `pos_orders anon read recent`（0016 §3a，近 14 日）
--   · pos_print_jobs    → policy（0021，近 24 小時）
--   · pos_soldout       → policy（0016 §3a，近 14 日）
select tablename, policyname, roles, cmd, qual
from pg_policies
where schemaname = 'public'
  and tablename in ('pos_orders', 'pos_print_jobs', 'pos_soldout')
order by tablename, policyname;

-- anon 只應該有 SELECT（唔可以 INSERT/UPDATE/DELETE）
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('pos_orders', 'pos_print_jobs', 'pos_soldout')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;


-- ── §3 若 §2 見到 pos_orders 冇 anon SELECT（即 0016 未跑／被覆蓋）──────
-- ⚠️ 只重跑 0016 §3 呢一段就夠，唔好成個 0016 重跑（§2 嗰段係破壞性）。
-- revoke all on table public.pos_orders from anon, authenticated;
-- grant select on table public.pos_orders to anon;
-- drop policy if exists "pos_orders anon read recent" on public.pos_orders;
-- create policy "pos_orders anon read recent" on public.pos_orders
--   for select to anon
--   using (coalesce(created_at, now()) >= now() - interval '14 days');


-- =============================================================================
-- 本檔只讀（§1b / §3 預設註解）。跑完 §0–§2 之後：
--   · §0 有數 + §1 有 pos_orders + §2 anon 有 SELECT  → POS 專案冇問題，
--     去 Vercel 加 NEXT_PUBLIC_POS_SUPABASE_URL / _ANON_KEY 並重新部署即可。
--   · 之後用 tools/2026-09-11-check-pos-realtime.mjs --watch 20 做 end-to-end 驗證。
-- =============================================================================
