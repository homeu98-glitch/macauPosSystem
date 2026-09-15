-- =============================================================================
-- 2026-09-15 · 唯讀診斷：打印中心見到「失敗」但「失敗原因 —」，到底係咩事？
--
-- 🔴 症狀（商家截圖）：8 行全部「失敗」，但「失敗原因」欄全部係「—」。
--    程式碼對應（print-center.tsx:1849）：
--       失敗原因欄 = job.status === "failed" && job.lastError ? 原文 : 「—」
--    ⇒ 「—」代表 lastError 為空。而 status 又係 failed。
--
--    正常情況下 failed 一定有 last_error（AGENT_FAILED: ... / VOID_STALE: ... / 作廢：...）。
--    「failed 但冇 last_error」只可能係：
--      a) 救援 SQL 舊版本寫入（唔會，佢一定寫 last_error）
--      b) 人手 update（例如你自己跑過「我已跑」嘅 SQL）
--      c) 🔴 某條路徑把 status 改 failed 但冇寫 last_error（要揪出嚟）
--
-- 🔴 本檔完全唯讀 —— 冇任何 UPDATE / DELETE。跑完貼結果返嚟就得。
-- ⚠️ 一定要喺 **POS 專案**（iyrywzormzisyppkokbi）嘅 SQL Editor 跑，唔係 Ledger。
-- =============================================================================


-- ── §1 今日（澳門）全部打印任務：status / attempts / last_error 一覽 ────────
-- 重點睇：failed 行嘅 last_error 係唔係空、attempts 係幾多。
select
  to_char(created_at at time zone 'Asia/Macau', 'MM-DD HH24:MI') as 建立,
  status,
  coalesce(attempts, 0)                                          as 次數,
  coalesce(claimed_by, '-')                                      as 認領機,
  case when finished_at is null then '-' else '有' end            as 已出紙,
  coalesce(substring(last_error, 1, 60), '（空）')                as 失敗原因,
  coalesce(order_no, '?')                                        as 單號,
  store_id
from public.pos_print_jobs
where created_at at time zone 'Asia/Macau' >= date_trunc('day', now() at time zone 'Asia/Macau')
order by created_at desc
limit 100;


-- ── §2 🔴 揪出「failed 但 last_error 係空」嘅行（＝截圖嗰批？）──────────────
select count(*) as failed_但冇原因
  from public.pos_print_jobs
 where status = 'failed'
   and (last_error is null or btrim(last_error) = '');

-- 逐張睇（含 attempts，睇係唔係 5 = 被作廢）
select
  to_char(created_at at time zone 'Asia/Macau', 'MM-DD HH24:MI') as 建立,
  attempts,
  claimed_by,
  claimed_at,
  finished_at,
  updated_at,
  order_no,
  ticket_type,
  printer_name
from public.pos_print_jobs
where status = 'failed'
  and (last_error is null or btrim(last_error) = '')
order by created_at desc
limit 50;


-- ── §3 仍然未印完（＝中繼機一上線就會爆紙嘅張數）─────────────────────────
-- 🔴 跑完 §2 之後最重要嘅一條：如果呢度係 0，代表救援已經生效／冇積壓。
select status, count(*) as 張數
  from public.pos_print_jobs
 where status in ('pending', 'printing')
 group by status order by status;

-- 逐張（只列出仍然會被 claim 嘅：attempts < 5）
select
  to_char(created_at at time zone 'Asia/Macau', 'MM-DD HH24:MI') as 建立,
  status,
  attempts,
  claimed_by,
  order_no,
  printer_name
from public.pos_print_jobs
where status in ('pending', 'printing')
  and coalesce(attempts, 0) < 5
order by created_at
limit 100;


-- ── §4 打印任務總覽（24 小時窗）───────────────────────────────────────────
select status,
       count(*)                                              as 張數,
       count(*) filter (where last_error is null)             as 冇原因,
       min(created_at at time zone 'Asia/Macau')              as 最早,
       max(created_at at time zone 'Asia/Macau')              as 最新
  from public.pos_print_jobs
 where created_at > now() - interval '24 hours'
 group by status order by status;


-- ── §5 中繼機心跳（睇佢係唔係終於回來了）──────────────────────────────────
select agent_id,
       store_id,
       to_char(last_seen_at at time zone 'Asia/Macau', 'MM-DD HH24:MI:SS') as 最後心跳,
       round(extract(epoch from (now() - last_seen_at)) / 60)              as 幾分鐘前
  from public.pos_print_agents
 order by last_seen_at desc
 limit 10;


-- ── §6 0042 有冇跑（決定 P2 分段式生唔生效）───────────────────────────────
select prosrc like '%6 minutes%'        as 同機6分鐘,
       prosrc like '%90 seconds%'       as 跨機90秒,
       prosrc like '%finished_at is null%' as 已成功守衛
  from pg_proc where proname = 'pos_claim_print_jobs';

-- sweep function 喺唔喺度（0042 §D）
select count(*) as sweep_function存在
  from pg_proc where proname = 'pos_void_stale_print_jobs';

-- =============================================================================
-- 判讀指引
--   §2 有數（failed 但冇原因）→ 就係截圖見到嘅事。睇 attempts：
--        attempts = 5  → 係「作廢」類（救援 SQL 或 sweep），只係 last_error 被清走
--        attempts < 5  → 🔴 有條路徑把 status 改 failed 但漏寫 last_error，要修
--   §3 = 0        → ✅ 冇積壓，中繼機上線唔會爆紙（唔需要再跑救援 SQL）
--   §5 分鐘數細   → ✅ 中繼機已回來
--   §6 三個 true  → ✅ 0042 已跑，P2 分段式生效
-- =============================================================================
