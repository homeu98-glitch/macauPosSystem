-- 0026 · pos_queue_events 保留期 + 清理函數
-- 對應 docs/111（同步隊列 outbox 化）。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 背景（點解要呢個 migration）
-- ─────────────────────────────────────────────────────────────────────────────
-- `pos_queue_events` 係 client outbox 事件嘅**雲端審計日誌**：每條事件推送時 upsert 一次
-- （onConflict: id），之後再冇人更新過。因此：
--
--   1. `status` 欄永遠係 client 推送嗰刻嘅值（實務上永遠係 "pending"）——
--      舊 client 每次 pull state 會將呢啲「pending」事件 merge 返落本地 queue，
--      令第二部收銀機無故多咗一堆「未同步」（「100 筆」嘅一半來源）。
--   2. 張表只增不減：冇任何清理機制，長期落去會無限膨脹。
--
-- 2026-09-08 outbox 化（docs/111）之後：
--   - client **唔再**消費 `/api/pos/state` 派發嘅 queue（`pos-app.tsx` 嘅 merge 已閂，
--     feature flag `macau-pos/sync-outbox-v2` 設 "0" 可以還原）；
--   - queue 變成純審計日誌 → 可以安全咁定保留期。
--
-- 本 migration 只加清理函數 + 索引，**唔刪任何現有數據**（清理要人手 call 或者排 cron）。
-- 冇 drop 任何嘢，`if not exists` / `create or replace` 守門，可重複執行。
-- ============================================================================

-- ============================================================================
-- 1) 清理函數：剷走 N 日之前嘅 queue 事件
--
--    security definer：等 cron / 維修人員用低權限角色都 call 得到（service_role
--    本身已經 bypass RLS，但 pg_cron job 嘅執行身份唔一定係 service_role）。
--    search_path 鎖死 public，防 search_path 注入。
-- ============================================================================
create or replace function public.pos_prune_queue_events(p_keep_days int default 7)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz := now() - make_interval(days => greatest(coalesce(p_keep_days, 7), 1));
  v_deleted bigint;
begin
  delete from public.pos_queue_events where created_at < v_cutoff;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.pos_prune_queue_events(int) is
  '清理 pos_queue_events 嘅舊事件（默认保留 7 日）。outbox 化（docs/111）之後呢張表'
  '淨係審計日誌，client 唔會再消費。建議每日排一次 cron，見 migration 尾部說明。';


-- ============================================================================
-- 2) 索引：清理係按 created_at 範圍 delete，行數多嗰陣全表掃會好慢
--    （0022 嗰個係 (store_id, created_at desc)，對「純按時間清理」用唔到前綴）
-- ============================================================================
create index if not exists pos_queue_events_created_at_idx
  on pos_queue_events (created_at);


-- ============================================================================
-- 3) 排程（要人手做，本 migration 唔會自動開 cron —— 唔假設 pg_cron 已啟用）
-- ============================================================================
--
-- 3.1 Supabase Dashboard：Database → Extensions 開 `pg_cron`，之後：
--
--       select cron.schedule(
--         'pos-prune-queue-events',
--         '17 4 * * *',                       -- 每日 04:17（澳門時間＝UTC+8，即 UTC 20:17）
--         $$select public.pos_prune_queue_events(7)$$
--       );
--
--     ⚠️ Supabase 嘅 cron 時區係 UTC：澳門凌晨 04:00 = UTC 20:00（前一日），
--        想喺澳門時間 04:17 跑就要寫 '17 20 * * *'。
--
-- 3.2 冇 pg_cron 嘅話：喺release 流程 / 运维 script 度 call：
--
--       select public.pos_prune_queue_events(7);
--
-- 3.3 想停：select cron.unschedule('pos-prune-queue-events');
--
-- ============================================================================
-- 4) 驗收
-- ============================================================================
--
-- 4.1 函數存在
--   select proname from pg_proc where proname = 'pos_prune_queue_events';
--
-- 4.2 乾跑（先睇會刪幾多，唔好直接刪）
--   select count(*) from pos_queue_events
--   where created_at < now() - interval '7 days';
--
-- 4.3 第一次人手清理（建議先用 30 日，確認冇影響先收到 7 日）
--   select public.pos_prune_queue_events(30);
--
-- 4.4 清理後大小
--   select pg_size_pretty(pg_total_relation_size('pos_queue_events'));
-- ============================================================================
