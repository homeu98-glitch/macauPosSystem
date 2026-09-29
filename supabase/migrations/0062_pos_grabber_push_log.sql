-- 0062_pos_grabber_push_log.sql
--
-- 目的：為外賣平台（澳覓 / MFOOD）插件嘅**每一次推送**留一筆稽核，
--       令「呢張單到底有冇送過黎、入咗幾張、點解冇」事後查得到。
--
-- ── 為什麼要呢張表（2026-09-29 真機排查結論）─────────────────────────
--   商家問：「24/09 嗰批測試單而家全部被發送過黎咗，但 grabber 端完全冇 trace。」
--   排查時撞到**三層死牆**，全部都係「先天冇持久化」：
--
--   ① POS 側零稽核：`/api/integration/grabber/orders` 全程得一次
--      `upsert(..., ignoreDuplicates)` ＋ 回傳幾個計數，**冇寫任何 log**。
--      ⇒ 只要插件冇保存嗰次回應，就冇任何方法事後知道「送過咩」。
--   ② 插件側會被裁剪：`GRAB_LOG_MAX = 300`、`GRAB_ORDERS_MAX = 120`
--      （`background.js:28 / 394`）⇒ 舊記錄自然淘汰，幾日後一定查唔到。
--   ③ `counters.pushFailures` **只係個計數**，冇明細；
--      而 LevelDB 係 per-profile，重裝／profile 重置即消失。
--
--   ⇒ 要根治只可以喺**伺服器側**落一筆。呢張表就係嗰一筆。
--
-- ── 粒粒度：一次推送一筆（唔係一張單一筆）────────────────────────────
--   插件係**批次**推送（一次可能 1–20 張）。逐單開一列會令寫入放大 N 倍，
--   而排查時要嘅係「嗰一批發生咩事」⇒ 一筆 + `jsonb` 存明細就夠，
--   亦只會多 **1 個請求／次推送**（egress 可預算）。
--
-- ── 🔴 零影響原則（同 0056 / 0057 / 0060 / 0061 一致）───────────────
--   · 純加法：可以重複執行
--   · 全部 nullable / 有 DEFAULT → 舊 bundle 完全唔知呢張表存在，零影響
--   · **冇任何 FK**，亦唔改 `pos_orders` 任何欄位
--   · 🔴 未跑呢個 migration 之前，route 必須**自動降級**（寫唔到就 `auditLogged:false`
--     照常入單，**唔可以**因為稽核寫唔到就成批失敗 —— 入單係主業，稽核係副產品）
--
-- ── 🔴 權限：service_role only ──────────────────────────────────────
--   呢張表有外賣平台單號、金額，屬營運數據 ⇒ **唔可以**畀 anon / authenticated 讀。
--   開 RLS 但**唔建任何 anon／authenticated policy** ⇒ 兩個 role 一律食閉門羹；
--   service_role 本身 bypass RLS，照寫照讀。
--
-- 🔴 俾商家跑嘅 SQL **唔好用 begin;…commit;**（2026-09-24 教訓：商家會理解成
--    git commit ⇒ rollback ⇒ 靜默冇改）。本檔全部語句即時生效。

create table if not exists public.pos_grabber_push_log (
  id                 uuid primary key default gen_random_uuid(),

  store_id           uuid,
  source             text,
  client_version     text,

  -- 計數（同 route 回傳嘅欄位同名，方便對照）
  received_count     integer,
  created_count      integer,
  skipped_count      integer,
  rejected_count     integer,

  -- 明細：呢一批帶咩單號、拒收咗邊張、乜原因
  external_order_ids jsonb,
  local_order_nos    jsonb,
  rejected_detail    jsonb,

  captured_at        timestamptz,
  created_at         timestamptz not null default now()
);

-- 索引：排查一定係「最近／某間店／某個平台」呢三種切法
create index if not exists pos_grabber_push_log_created_at_idx
  on public.pos_grabber_push_log (created_at desc);

create index if not exists pos_grabber_push_log_store_created_idx
  on public.pos_grabber_push_log (store_id, created_at desc);

create index if not exists pos_grabber_push_log_source_created_idx
  on public.pos_grabber_push_log (source, created_at desc);

-- ── RLS：service_role only（見檔頭「權限」一節）──────────────────────
alter table public.pos_grabber_push_log enable row level security;

revoke all on table public.pos_grabber_push_log from anon, authenticated;
grant all on table public.pos_grabber_push_log to service_role;

drop policy if exists "pos_grabber_push_log service only" on public.pos_grabber_push_log;
create policy "pos_grabber_push_log service only" on public.pos_grabber_push_log
  for all to service_role using (true) with check (true);


-- =============================================================================
-- 🔴 回滾 SQL
-- =============================================================================
-- drop policy if exists "pos_grabber_push_log service only" on public.pos_grabber_push_log;
-- drop table if exists public.pos_grabber_push_log;


-- =============================================================================
-- 驗收查詢（貼入 SQL Editor）
-- =============================================================================
-- (1) 確認表同政策存在
-- select policyname, cmd, roles::text
--   from pg_policies
--  where schemaname = 'public' and tablename = 'pos_grabber_push_log';
--
-- (2) 最近 20 次推送（要喺插件推過單之後先有數）
-- select created_at, source, store_id, received_count, created_count,
--        skipped_count, rejected_count, client_version
--   from public.pos_grabber_push_log
--  order by created_at desc
--  limit 20;
--
-- (3) 🔴 查「某張單有冇送過黎」—— 呢個就係本表嘅存在意義
-- select created_at, source, created_count, skipped_count, rejected_detail
--   from public.pos_grabber_push_log
--  where external_order_ids @> to_jsonb('202609291313345883658'::text)
--  order by created_at desc;
--
-- (4) 只有被拒收嘅批次
-- select created_at, source, rejected_detail
--   from public.pos_grabber_push_log
--  where rejected_count > 0
--  order by created_at desc
--  limit 20;
-- =============================================================================
