-- 0035 · 修正「認領咗但冇回報」嘅打印任務永久卡死（2026-09-12 實案）
--
-- ───────────────────────────────────────────────────────────
-- 🔴 病症（商家 2026-09-12 實測）
--    線上單落單後，打印記錄幾張 job 全部顯示「已發送」（綠），但**一張紙都冇出**，
--    而且狀態永遠唔會變（冇紅標、冇自我修正）。
--
-- 🔴 根因：`pos_claim_print_jobs`（0020）只揀
--        `j.status in ('pending','failed')`
--    但 claim 成功會將 status 寫成 **`printing`**。
--    ⇒ 一旦中繼 APK claim 咗之後**冇成功回報**（渲染／出紙拋錯、APK 中途被殺、
--      result POST 失敗），嗰行就**永遠停留 `printing`**：
--        · `printing` 唔喺 claim 嘅 filter 內 → 冇任何機可以再認領佢；
--        · 0020 原本寫住「`claimed_at < now() - 60s`：認領咗但冇回報 → 60s 後畀第啲機接手」
--          —— 因為 status filter 已經排除咗 `printing`，呢個 60 秒重排條件**係死代碼**；
--        · `attempts < 5` 亦永遠唔會再增加 → 唔會自動退役、唔會報錯。
--    ⇒ 4 張 job 全部係咁，就係用戶見到嘅「全部卡已發送、印唔出、零錯誤」。
--
--    同時 `GET /api/pos/print-jobs/status` 只回 `printed` / `failed`
--    → POS 端永遠收唔到任何消息 → 本地狀態永遠停留「已發送」。
--
-- ✅ 修法：讓「已認領但超過 60 秒冇回報」嘅 `printing` 行重新可被認領
--    （仍然受 `attempts < 5` 同 `ttl` 保護，唔會無限重試）。
--
-- ⚠️ 寫咗 migration ≠ 跑咗 migration（已踩兩次：0018、0019、0020）
--    本機冇 DB 連線 → 要人手去 Supabase Dashboard → SQL Editor 貼呢段。
--    全部 idempotent（create or replace），可以重複貼。
--
-- ⚠️ 貼之前，如果想即刻救返已經卡死嗰批單，先跑一次 §C 嘅補救 UPDATE。
-- ───────────────────────────────────────────────────────────

-- ── A. 修正 claim：stale `printing` 可以重排 ─────────────────
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
       -- 重試上限（避免一張永遠印唔到嘅單無限搶機）
       and coalesce(j.attempts, 0) < 5
       -- ✅ 新增 `printing`：認領咗但冇回報（機死咗 / render 拋錯）要可以再排
       and j.status in ('pending', 'failed', 'printing')
       -- ⚠️ 但**正在印**嘅唔可以搶：`printing` 要超過 60 秒冇更新先放行
       and (
         j.status <> 'printing'
         or j.claimed_at is null
         or j.claimed_at < now() - interval '60 seconds'
       )
       -- ttl 過期就唔好再印（避免隔夜單突然出紙）
       and (j.ttl is null or j.ttl > (extract(epoch from now()) * 1000)::bigint)
       -- 原本嘅「搶單保護」：同一部機認領中（60 秒內）唔可以被另一部搶走（for update skip locked 亦會擋）
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

-- ── B. 索引：狀態過濾已經用 pos_print_jobs_queue_idx(store_id, status, created_at) ──
-- （0020 已建，唔使再加）

-- ── C. 一次性補救：救返已經卡死喺 printing 嘅單 ──────────────
-- 貼咗 §A 之後，卡死嘅單會喺 60 秒後自動被重新認領（前提：中繼機在線）。
-- 如果想**即刻**重新出紙，執行下面呢句（會將所有 stale printing 打返 pending 並清零 attempts）：
--
--   update public.pos_print_jobs
--      set status = 'pending', claimed_by = null, claimed_at = null, attempts = 0, updated_at = now()
--    where status = 'printing'
--      and claimed_at < now() - interval '60 seconds'
--      and coalesce(attempts, 0) >= 5;      -- 只清「已經用完 5 次」嗰批；未用完嘅會自動重排
--
-- 想睇清楚有咩卡住（唔改任何嘢）：
--
--   select id, order_no, printer_name, status, attempts, claimed_at, last_error
--     from public.pos_print_jobs
--    where status in ('pending', 'printing')
--    order by created_at desc
--    limit 50;
--
-- ── 驗收 ───────────────────────────────────────────────────
-- 1. RPC 有冇更新（應該見到 'printing' 喺 filter 內）：
--   select prosrc like '%''printing''%' as has_printing
--     from pg_proc where proname = 'pos_claim_print_jobs';
--   → true
-- 2. 空跑唔會報錯：
--   select count(*) from public.pos_claim_print_jobs('__no_such_store__', 'probe', 5);
--   → 0
-- 3. anon 冇權：
--   select has_function_privilege('anon', 'public.pos_claim_print_jobs(text,text,int)', 'EXECUTE');
--   → false
