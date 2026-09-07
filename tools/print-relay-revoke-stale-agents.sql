-- 清理「同一間店有多部未撤銷中繼機」造成嘅 /pair-status 500
-- ---------------------------------------------------------------------------
-- 背景（2026-09-07）：
--   `pos_print_agents` 嘅 PK 係 `agent_id`，`store_id` **冇 unique constraint**，
--   所以換機 / 重裝 APK 會產生新 agent_id，舊嗰條只要未 revoke 就仲喺度。
--   `/api/pos/print-agent/pair-status` 舊碼用 `.maybeSingle()` 按 store_id 查，
--   撞到 2 行會出「JSON object requested, multiple (or no) rows returned」→ 500
--   → web 顯示「配對失敗」，但其實中繼機一早配對成功、打印正常。
--
--   代碼層已經修好（改咗 `.order(last_seen_at desc).limit(1)`），呢段 SQL 係**數據清理**：
--   將同店非最近活躍嘅舊 agent 全部 revoke，還原「一店一部」嘅語義。
--
-- 用法：Supabase Dashboard → SQL Editor → 貼上去跑。
--   §1 係**只讀診斷**，一定要先跑，睇清楚邊啲係垃圾先好跑 §2。
--   §2 係**破壞性**（寫 revoked_at），跑之前建議先備份／確認 §1 結果。
-- ===========================================================================

-- ── §1 只讀診斷：列出所有「多部未撤銷中繼機」嘅店 ──────────────────────────
select
  store_id,
  count(*)                                        as active_agents,
  array_agg(agent_id order by last_seen_at desc nulls last) as agent_ids,
  array_agg(coalesce(name, '(unnamed)') order by last_seen_at desc nulls last) as agent_names,
  max(last_seen_at)                               as newest_last_seen,
  min(last_seen_at)                               as oldest_last_seen
from public.pos_print_agents
where revoked_at is null
group by store_id
having count(*) > 1
order by count(*) desc;

-- 想睇特定一間店（例如出事嗰間）嘅全部 agent（含已 revoke），用下面呢段：
-- select agent_id, store_id, name, created_at, last_seen_at, revoked_at
--   from public.pos_print_agents
--  where store_id = 'd564b932-0c91-45e9-86fd-0ec8e2711f13'
--  order by last_seen_at desc nulls last;

-- ── §2 清理：同店只保留最近活躍嗰部，其餘 revoke ──────────────────────────
-- ⚠️ 破壞性：會寫 revoked_at。跑完舊機再 claim 會驗唔過（401）→ 自動返配對畫面。
-- 建議先跑 §1 確認清單，再逐間店做（唔想全店一次過就將 where 換成指定 store_id）。
--
-- begin;   -- 想原子化就拆 comment，確認 affected rows 數字合理先 commit

update public.pos_print_agents a
   set revoked_at = now()
 where a.revoked_at is null
   and exists (
     select 1
       from public.pos_print_agents b
      where b.store_id = a.store_id
        and b.revoked_at is null
        and (
          b.last_seen_at > a.last_seen_at
          or (b.last_seen_at is null and a.last_seen_at is not null)
          or (b.last_seen_at is null and a.last_seen_at is null and b.created_at > a.created_at)
          or (b.last_seen_at is null and a.last_seen_at is null and b.created_at = a.created_at and b.agent_id > a.agent_id)
        )
   );

-- 只清某一間店嘅話，用呢段（replace store id）：
-- update public.pos_print_agents a
--    set revoked_at = now()
--  where a.revoked_at is null
--    and a.store_id = 'd564b932-0c91-45e9-86fd-0ec8e2711f13'
--    and a.agent_id <> (
--      select agent_id from public.pos_print_agents
--       where store_id = a.store_id and revoked_at is null
--       order by last_seen_at desc nulls last
--       limit 1
--    );

-- commit;

-- ── §3 驗收：跑完 §2 之後，§1 應該返 0 行 ─────────────────────────────────
-- （再跑一次 §1 個 query 就係驗收）
