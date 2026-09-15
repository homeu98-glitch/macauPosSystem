-- 0042 · 打印任務認領窗口：分段式（P2）＋ 已成功行退出搶單池
--
-- 對應 docs/print-timeout-p2-claim-window-2026-09-15.md
--
-- ───────────────────────────────────────────────────────────
-- 🔴 病症一（現行 code 已有嘅真實漏洞，唔係新引入）
--    0035 第 62 行寫住：
--      and (j.claimed_by is null or j.claimed_at < now() - interval '60 seconds')
--    呢句嘅**意圖**係「同一部機認領中唔可以被搶」，但實際條件
--    **完全冇比對 `p_agent_id`** ⇒ 同一部機 60 秒後可以合法地
--    重新 claim 返自己嗰張。
--
--    真實觸發：`pos_claim_print_jobs` 一次拎 5 張（claim/route.ts 預設 p_limit=5），
--    APK 串行逐張印。收據熱敏 + 二維碼點陣，5 張長單串行 = 60–120 秒。
--    第 1 張過咗 60 秒仲未回報，APK 又 call 一次 claim
--    → 同一部機再拎返自己嗰張 → **重複出紙**。
--
-- 🔴 病症二（「機死咗」同「正常但慢」用同一判準）
--    純 90 秒 → 會撞上面嘅重複出紙；
--    純 6 分鐘 → 機真係死咗要等 6 分鐘先有人接手（收銀高峯唔可接受）。
--    兩個純方案都唔合格。
--
-- ✅ 修法：分段式
--    · 同一部機（claimed_by = p_agent_id）→ 6 分鐘先可以重拎（長單／多張串行安全）
--    · 其他機（claimed_by <> p_agent_id）→ 90 秒接手（機死咗快速恢復）
--    · `finished_at is null` → 已成功出過紙嘅行永遠退出搶單池
--
-- ⚠️ 手動重印：走 `POST /api/pos/print-jobs/retry`（P3），佢會清
--    `finished_at` / `attempts` / `status='pending'`，所以唔會被上面條件擋死。
--
-- ⚠️ 寫咗 migration ≠ 跑咗 migration（已踩過 0018/0019/0020/0040）
--    本機冇 DB 連線 → 要人手去 Supabase Dashboard → SQL Editor 貼呢段。
--    全部 idempotent（create or replace），可以重複貼。
-- ───────────────────────────────────────────────────────────

-- ── A. claim RPC：分段式認領窗口 ─────────────────────────────
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
       -- printing 亦要可重排（0035：認領咗但冇回報）
       and j.status in ('pending', 'failed', 'printing')
       -- 🆕 已成功出過紙嘅（finished_at 有值）永遠唔再 claim。
       --    人工重印要經 P3 端點（會清 finished_at），唔會被呢句擋死。
       and j.finished_at is null
       -- stale printing 重排窗（由 0035 嘅 60 秒對齊到 90 秒，同跨機窗一致）
       and (
         j.status <> 'printing'
         or j.claimed_at is null
         or j.claimed_at < now() - interval '90 seconds'
       )
       -- ttl 過期就唔好再印（避免隔夜單突然出紙；ttl 由 P1 寫入）
       and (j.ttl is null or j.ttl > (extract(epoch from now()) * 1000)::bigint)
       -- 🔴 P2 核心：分段式搶單保護
       --    同機：6 分鐘（長單／5 張串行印得完，唔會被自己重複拎 → 零重複出紙）
       --    跨機：90 秒（前者死咗／斷網，快速接手 → 唔使等 6 分鐘）
       and (
         j.claimed_by is null
         or (j.claimed_by  = p_agent_id and j.claimed_at < now() - interval '6 minutes')
         or (j.claimed_by <> p_agent_id and j.claimed_at < now() - interval '90 seconds')
       )
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

-- ── B. 索引：防止「印花過期舊單」掃描變慢 ─────────────────────
-- finished_at is null 嘅過濾行數極少（大部分 job 早已成功），加部分索引令 claim 更快。
create index if not exists pos_print_jobs_open_idx
  on public.pos_print_jobs (store_id, created_at)
  where finished_at is null
    and status in ('pending', 'failed', 'printing');

-- ── C. 一次性補救：把「已成功但 status 被改返 pending」嘅行收返做 printed ──
-- （如果之前有並發重複造成重印，可先睇清楚有幾多張：
--   select count(*) from public.pos_print_jobs
--    where finished_at is not null and status in ('pending','printing');
--  呢啲行唔會再被 claim（A 段已擋），想佢哋喺 UI 顯示返「成功」就跑下面：）
--
--   update public.pos_print_jobs
--      set status = 'printed', claimed_by = null, updated_at = now()
--    where finished_at is not null
--      and status in ('pending', 'printing');

-- ── D. P1 隔夜作廢 sweep（配合 ttl / 營業日邊界）────────────────
-- `ttl` 由 P1 寫入（`/api/pos/sync` → `PRINT_JOB_CREATED`，= min(建單+12h, 當日 23:59)）。
-- A 段 claim 條件已擋住過期 job（`j.ttl > now_ms`），但**唔會令 UI 見到**：
-- 張單會永遠停留 `pending`，打印中心顯示「未認領」而唔知係「過期作廢」。
--
-- 所以加一個 lazy sweep：把「ttl 已過 + 仍然未印完」嘅行標成 failed 並寫原因碼。
-- ⚠️ 刻意**唔用 pg_cron**（Supabase 免費層未必開；亦唔想為一個衛生工作加外部依賴）。
--    改為由 `GET /api/pos/print-jobs/status` 每次被叫時 best-effort 執行
--    （見 status route 嘅 sweepStalePrintJobs()；失敗唔影響主查詢）。
--
-- 呢個 function 係 sweep 本體。要手動跑一次都得：
--   select public.pos_void_stale_print_jobs('your-store-id');
create or replace function public.pos_void_stale_print_jobs(p_store_id text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  update public.pos_print_jobs
     set status      = 'failed',
         last_error  = 'VOID_STALE: 已逾有效期或跨營業日，系統不會補印（如需補印請用「補打帳單」）',
         claimed_by  = null,
         claimed_at  = null,
         updated_at  = now()
   where store_id = p_store_id
     and finished_at is null
     and status in ('pending', 'failed', 'printing')
     -- 只有真係改咗狀態先算 affected（唔好把已經 failed 嘅重複掃）
     and (
       (ttl is not null and ttl <= (extract(epoch from now()) * 1000)::bigint)
     );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.pos_void_stale_print_jobs(text) from public, anon, authenticated;
grant execute on function public.pos_void_stale_print_jobs(text) to service_role;

-- ── 驗收 ───────────────────────────────────────────────────
-- 1. RPC 有否更新（應該見到 6 minutes / 90 seconds / finished_at is null）：
--   select prosrc like '%6 minutes%'    as has_same_agent,
--          prosrc like '%90 seconds%'   as has_cross_agent,
--          prosrc like '%finished_at is null%' as has_finished_guard
--     from pg_proc where proname = 'pos_claim_print_jobs';
--   → true / true / true
--
-- 2. 唔會因為同名重載而報 ambiguous：
--   select count(*) from pg_proc
--    where proname = 'pos_claim_print_jobs' and pronargs = 3;
--   → 1
--
-- 3. 空跑唔會報錯：
--   select count(*) from public.pos_claim_print_jobs('__no_such_store__', 'probe', 5);
--   → 0
--
-- 4. anon 冇權：
--   select has_function_privilege('anon', 'public.pos_claim_print_jobs(text,text,int)', 'EXECUTE');
--   → false
--
-- 5. sweep function 喺度 + anon 冇權：
--   select has_function_privilege('anon', 'public.pos_void_stale_print_jobs(text)', 'EXECUTE');
--   → false
--   select public.pos_void_stale_print_jobs('__no_such_store__');
--   → 0
