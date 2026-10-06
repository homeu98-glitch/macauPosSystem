-- 0064_pos_grabber_inbox_and_capability.sql
--
-- 目的：承接 **Android 商戶 APK** 嘅抓單上送（取代 Chrome 插件路線），
--       並為「小店預設完全隱藏」提供**每店旗標**。
--
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 為什麼係呢張表（而唔係直接寫 pos_orders）
-- ══════════════════════════════════════════════════════════════════════
-- APK 同插件嘅送單邏輯有一個**本質分別**：
--
--   插件：見到新單就即推，body 只含「一張單嘅投影欄位」。
--   APK  ：抓完一批之後**先**上送，而且要帶**原始 JSON**
--         （平台回應可能隨時改版，冇 raw 就事後完全無法重播／對帳）。
--
-- 所以呢度加一張 **inbox（原始落地）**，唔直接入 pos_orders：
--   1. 冪等層：`(store_id, platform, kind, dedup_key)` 唯一鍵
--      ⇒ 重送同一單**唔會**重複入、亦**唔會**覆蓋店員已推進嘅狀態。
--   2. 髒資料隔離：單列解析失敗只標 `parse_ok=false` + `reject_reason`，
--      **唔會**令成批失敗（插件舊版就係成批掛 = 一張都唔入）。
--   3. 可重播：`raw jsonb` 保留 N 日，之後即使平台改版都查得返。
--   4. 投影可延後：入 pos_orders 由 worker / 後續步驟做，inbox 先收。
--
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 零影響原則（同 0056/0057/0060/0061/0062 一致）
-- ══════════════════════════════════════════════════════════════════════
--   · 純加法：可以重複執行（全部 `if not exists` / `drop policy if exists`）
--   · **唔改 pos_orders 任何欄位**、**冇任何 FK**、**唔改既有 route**
--   · 未跑呢個 migration 之前，`/api/pos/grabber/*` 必須**自動降級**：
--     ingest 回 503（明確講「未初始化」），count / capability 回「未知」，
--     **絕對唔可以**因為新功能未初始化就影響出單／列印（print-agent 零改動）。
--
-- 🔴 俾商家跑嘅 SQL **唔好用 begin;…commit;**（2026-09-24 教訓：
--    商家會理解成 git commit ⇒ rollback ⇒ 靜默冇改）。本檔全部語句即時生效。

-- =============================================================================
-- 1) 原始落地表
-- =============================================================================
create table if not exists public.pos_grabber_inbox (
  id            uuid primary key default gen_random_uuid(),

  -- 🔴 綁店：呢個係**資料隔離嘅唯一真源**。
  --    跨店讀取（另一間店送單寫入本機 store_id）必須喺 route 層擋，
  --    唔可以靠 RLS（service_role bypass RLS）。
  store_id      uuid not null,

  -- 'mfood' | 'aomi' | 'mpay'（對應 APK 嘅 GrabberPlatform.key）
  platform      text not null,
  -- 'order' | 'settlement' | 'finance'
  kind          text not null,

  -- 🔴 冪等鍵：建議 `${platform}:${orderId}`（訂單）/
  --    `${platform}:${weekId}:${tradeNo}`（對帳明細）。
  --    唯一鍵令重送變成「更新」而唔係「新插入」。
  dedup_key     text not null,

  -- 投影後真正入 pos_orders 用嘅單號（由 worker / route 填）
  local_order_no text,

  -- 原始回應（整批一列，逐單喺 raw_items 內）—— 保留期見下方 TTL 註解
  raw           jsonb,

  -- 逐單解析結果：[{ dedupKey, ok, reason }]
  parse_result  jsonb,

  parse_ok      boolean,
  reject_reason text,

  -- 平台側時間（訂單建立／結算時間），cut-off 過濾用
  occurred_at   timestamptz,
  captured_at   timestamptz,

  -- 已投影標記（等於 pos_orders 出現咗同一單）
  projected_at  timestamptz,
  project_error text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 🔴 冪等核心。DO NOTHING / upsert 都靠佢。
create unique index if not exists pos_grabber_inbox_dedup_uniq
  on public.pos_grabber_inbox (store_id, platform, kind, dedup_key);

-- count 端點同 worker 掃描用
create index if not exists pos_grabber_inbox_store_created_idx
  on public.pos_grabber_inbox (store_id, created_at desc);

create index if not exists pos_grabber_inbox_pending_idx
  on public.pos_grabber_inbox (store_id, projected_at, created_at desc);

-- 查「呢張單有冇送過」
create index if not exists pos_grabber_inbox_local_order_idx
  on public.pos_grabber_inbox (store_id, local_order_no)
  where local_order_no is not null;

-- =============================================================================
-- 2) 每店能力旗標（第 1 層開關：看不看得到）
-- =============================================================================
--
-- 🔴 為什麼用**獨立表**而唔係加欄落 pos_online_order_settings：
--   · 呢個係「**跨專案**」嘅開關（會員通 APK 問 POS），唔係 POS 自己嘅功能開關；
--   · 加欄落 existing 表要改該表 migration（已生產）⇒ 風險遠高於新表；
--   · 唔加 FK ⇒ 完全唔碰既有表，符合零影響。
create table if not exists public.pos_grabber_capability (
  store_id        uuid primary key,

  -- 🔴 呢個值就係 APK `GrabberVisibility` 讀嘅 `grabberEnabled`
  grabber_enabled boolean not null default false,

  -- 原因／備註（俾 Joe 將來喺 dashboard 顯示）
  note            text,

  -- 誰喺幾時改（審計）
  updated_by      text,
  updated_at      timestamptz not null default now()
);

-- 🔴 預設關係**雙重**保險：
--   ① 呢度 default false
--   ② route 讀唔到 row ⇒ 當 false（fail-closed）
-- 小店永遠唔會因為「row 唔存在」而見到入口。

-- =============================================================================
-- 3) RLS：service_role only（兩個表都係）
-- =============================================================================
-- 理由：inbox 有外賣平台單號、金額、客人資料 ⇒ 營運／個人資料。
--       開 RLS 但**唔建任何 anon／authenticated policy** ⇒ 兩個 role 食閉門羹；
--       service_role 本身 bypass RLS，照寫照讀。
alter table public.pos_grabber_inbox      enable row level security;
alter table public.pos_grabber_capability enable row level security;

revoke all on table public.pos_grabber_inbox      from anon, authenticated;
revoke all on table public.pos_grabber_capability from anon, authenticated;
grant  all on table public.pos_grabber_inbox      to service_role;
grant  all on table public.pos_grabber_capability to service_role;

drop policy if exists "pos_grabber_inbox service only" on public.pos_grabber_inbox;
create policy "pos_grabber_inbox service only" on public.pos_grabber_inbox
  for all to service_role using (true) with check (true);

drop policy if exists "pos_grabber_capability service only" on public.pos_grabber_capability;
create policy "pos_grabber_capability service only" on public.pos_grabber_capability
  for all to service_role using (true) with check (true);


-- =============================================================================
-- 🔴 回滾 SQL
-- =============================================================================
-- drop policy if exists "pos_grabber_capability service only" on public.pos_grabber_capability;
-- drop policy if exists "pos_grabber_inbox service only" on public.pos_grabber_inbox;
-- drop table if exists public.pos_grabber_inbox;
-- drop table if exists public.pos_grabber_capability;


-- =============================================================================
-- 驗收查詢（貼入 SQL Editor）
-- =============================================================================
-- (1) 確認表／索引／政策都存在
-- select tablename, policyname, cmd, roles::text
--   from pg_policies
--  where schemaname = 'public'
--    and tablename in ('pos_grabber_inbox','pos_grabber_capability');
--
-- (2) 🔴 開放某間店（大店）—— Joe 由 dashboard 做，呢度只作手動測試
-- insert into public.pos_grabber_capability (store_id, grabber_enabled, note, updated_by)
-- values ('<STORE_UUID>', true, '首批試點', 'manual-sql')
-- on conflict (store_id) do update
--   set grabber_enabled = true, updated_at = now();
--
-- (3) 睇而家有邊幾間店開放咗
-- select c.store_id, c.grabber_enabled, c.updated_at,
--        (select count(*) from public.pos_grabber_inbox i where i.store_id = c.store_id) as inbox_rows
--   from public.pos_grabber_capability c
--  where c.grabber_enabled;
--
-- (4) APK 送過之後：最近 20 批
-- select created_at, platform, kind, parse_ok, reject_reason, dedup_key
--   from public.pos_grabber_inbox
--  where store_id = '<STORE_UUID>'
--  order by created_at desc
--  limit 20;
--
-- (5) 🔴 查「有邊啲單解析失敗」—— 呢個係單列隔離嘅驗證
-- select created_at, platform, dedup_key, reject_reason
--   from public.pos_grabber_inbox
--  where store_id = '<STORE_UUID>' and parse_ok is false
--  order by created_at desc
--  limit 20;
-- =============================================================================

-- =============================================================================
-- 🔴 RAW 保留期（TTL）—— 執行者須知
-- =============================================================================
-- 上面**冇**自動清理 raw 嘅 trigger／pg_cron，係刻意嘅：
--   · 自動刪 raw 屬「破壞性」行為，唔應該靜靜哋發生；
--   · 保留期係**營運決策**（涉及對帳申訴時限），要 Joe 拍板。
-- 建議喺確定窗口後再加，例如：
--
--   -- create extension if not exists pg_cron;
--   -- select cron.schedule('pos-grabber-raw-ttl', '17 4 * * *', $$
--   --   update public.pos_grabber_inbox
--   --      set raw = null
--   --    where raw is not null
--   --      and coalesce(occurred_at, created_at) < now() - interval '90 days';
--   -- $$);
--
-- 現階段（未拍板前）做法：raw 一直留，容量問題由 ops 監控。
-- =============================================================================
