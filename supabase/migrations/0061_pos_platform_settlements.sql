-- 0061_pos_platform_settlements.sql
--
-- 目的：存**帳期級**平台結算金額（應收／實收／服務費），令報表三格一定有位取數。
--
-- ── 為什麼要另開一張表（2026-09-28，真機驗證後嘅結論）──────────────────
-- 0060 嘅做法係「逐單」：平台 transaction 帶 `tradeNo`，配 `pos_orders.external_order_id`，
-- 逐張訂單 UPDATE 實收金額。呢個口徑無問題，但**實測配對唔上**：
-- 平台財務頁 transaction 嘅 tradeNo 同 POS 記錄嘅平台單號唔一致
-- ⇒ 每次都係 `received: 0, notFound: [全部]` ⇒ 報表三格永遠「待對帳」。
--
-- 而平台頁面**一載入就已經有**帳期級金額（`/summarys/summary/_list` 回應自帶）：
--   storeBusinessAmtn       1803.34   ← 營業額（應收）
--   storeReceiveAmtn        1353.17   ← 實收（扣平台服務費後）
--   subsidyStoreReceiveAmtn 1212.37   ← 補貼後實收（＝實際到帳）
--   platformServiceFee       490.83
-- ⇒ 逐單口徑配唔上唔應該拖死整件事：**帳期級數字一定有，報表就用佢**。
--
-- ── 兩個口徑並存，唔互相取代 ─────────────────────────────────────────
--   逐單（0060 `pos_orders.platform_*`）：抓到就顯示單張訂單實收（詳情／收據用）
--   帳期（本表）：報表 MFOOD 區塊三格用 —— 保證有數，唔受配對成敗影響
--   🔴 兩者口徑唔同（帳期含平台側雜項），**唔可以相加**，報表要標明用咗邊個。
--
-- ── 唯一鍵（store_id, source, period）──────────────────────────────
--   同一間店、同一個來源、同一個帳期 = 一筆。重抓 = 覆蓋（最新為準），
--   所以 route 用 upsert（on_conflict）。
--
--   ⚠️ 唔用 `store_id` 單獨做鍵：同一間店可能同時有 mfood 同澳覓兩個帳期。
--   ⚠️ `source` 用 text 而唔係 enum：同 pos_orders.source 一致（見 0054），
--      加新平台唔使改 schema。
--
-- ── 🔴 零影響原則（同 0056 / 0057 / 0060 一致）─────────────────────
--   · 全部 nullable、冇 DEFAULT → 舊 bundle 完全唔知呢張表存在，零影響
--   · 純加法：可以重複執行
--   · 冇任何 FK 指向 pos_orders（帳期係平台側嘅聚合，唔屬於單張訂單）
--
-- 🔴 俾商家跑嘅 SQL **唔好用 begin;…commit;**（2026-09-24 教訓：商家會理解成
--    git commit ⇒ rollback ⇒ 靜默冇改）。本檔全部語句即時生效。

create table if not exists public.pos_platform_settlements (
  id           uuid primary key default gen_random_uuid(),
  store_id     text not null,
  -- 平台來源：'mfood' / 'aomi'（同 pos_orders.source 同一套值）
  source       text not null,
  -- 帳期識別：用平台回嘅日期區間做字串（例 "2026-09-16 ~ 2026-09-30"）。
  -- ⚠️ 唔用平台內部 id（`weekId`）做主鍵一部分 —— 嗰個 id 平台會改版，
  --    日期區間係人睇得明、亦穩定。
  period       text not null,

  -- ── 金額（一律「元」，同 platform_* 欄位一致；mfood 元、澳覓分已在插件側對齊）──
  -- 應收＝平台側營業額（storeBusinessAmtn）
  should_amount   numeric(12,2),
  -- 實收＝扣平台服務費後（storeReceiveAmtn）
  receive_amount  numeric(12,2),
  -- 補貼後實收＝實際到帳（subsidyStoreReceiveAmtn）；冇補貼時等於 receive_amount
  subsidy_amount  numeric(12,2),
  -- 平台服務費（platformServiceFee）
  service_fee     numeric(12,2),

  -- 平台回嘅原始物件（審計用：事後核對「呢個數字點嚟」）
  raw          jsonb,
  -- 抓取當刻（覆蓋時同步更新）
  fetched_at   timestamptz not null default now(),

  constraint pos_platform_settlements_period_key unique (store_id, source, period)
);

comment on table public.pos_platform_settlements is
  '帳期級外賣平台結算金額（應收／實收／服務費）。寫入唯一路徑 = /api/integration/grabber/settlement（插件抓平台財務頁）。與 0060 嘅逐單 platform_* 欄位**口徑唔同、唔可以相加**。見 migration 0061。';

comment on column public.pos_platform_settlements.period is
  '帳期日期區間字串（例 "2026-09-16 ~ 2026-09-30"）。連同 store_id + source 做唯一鍵；重抓同一帳期係覆蓋（最新為準）。';

comment on column public.pos_platform_settlements.should_amount is
  '帳期應收＝平台側營業額（mfood storeBusinessAmtn）。null ＝ 平台冇回呢個數（UI 要顯示「—」，唔可以填 0）。';

comment on column public.pos_platform_settlements.receive_amount is
  '帳期實收＝扣平台服務費後（mfood storeReceiveAmtn）。null ＝ 未對帳。';

comment on column public.pos_platform_settlements.subsidy_amount is
  '帳期補貼後實收＝實際到帳（mfood subsidyStoreReceiveAmtn）。冇補貼時等於 receive_amount。';

-- 報表查詢：按店 + 時間倒序攞最新帳期
create index if not exists pos_platform_settlements_store_idx
  on public.pos_platform_settlements (store_id, source, fetched_at desc);

-- ============================================================================
-- RLS：同 pos_orders 睇齊（anon 讀唔到敏感財務數字，只有 service role 寫）
-- ============================================================================
-- ⚠️ 用 `enable row level security` 而**唔加** anon policy：
--    呢張表有平台抽成數字，係商家財務資料，唔應該經 anon key 外洩。
--    入站 route 用 service role 寫（bypass RLS），POS 客戶端暫時唔讀呢張表
--    （報表由 /api/pos/* 伺服器端查）。
alter table public.pos_platform_settlements enable row level security;

-- ============================================================================
-- 驗證（貼完之後逐條跑，全部唯讀；唔好用 begin;…commit;）
-- ============================================================================
-- ① 表存在 + 欄位（should_amount / receive_amount 應該 is_nullable = YES）
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema='public' and table_name='pos_platform_settlements'
--   order by ordinal_position;
--
-- ② 唯一鍵存在
--   select conname from pg_constraint
--   where conrelid = 'public.pos_platform_settlements'::regclass;
--   → 應該見到 pos_platform_settlements_period_key
--
-- ③ RLS 已開（rowsecurity = true）
--   select relname, relrowsecurity from pg_class
--   where relname = 'pos_platform_settlements';
--
-- ④ 現有資料零影響（新表一定係 0 行）
--   select count(*) from public.pos_platform_settlements;
--
-- 【降級回滾】唔想用？
--   drop table if exists public.pos_platform_settlements;
