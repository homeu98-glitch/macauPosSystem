-- =============================================================================
-- 0076 · POS 外送派單（pos_delivery_jobs）
--
-- 對應：docs/mockups/delivery-dispatch-2026-10-31.html（v5 確認稿）
-- 日期：2026-10-31
--
-- 為何要一張新表、而唔係喺 pos_orders 加欄：
--   ① 派單資料（送貨地址／聯絡人／車手費／代收）**唔屬於訂單本身**，
--      平台單／店內單／線上單都會有，但生命週期同訂單唔同（可取消再派）。
--   ② 客人個資唔應該散落喺 pos_orders（該表 already 有 RLS 時間窗、多處投影）。
--   ③ 一張 job 對一張單，`(store_id, order_source, order_ref)` 唯一，
--      重派就更新同一行（同 Ledger `order_delivery_dispatch` 嘅 onConflict: order_id 一致）。
--
-- 關聯口徑（跨 DB，冇 FK）：
--   order_source = 'ledger' → order_ref = Ledger `orders.id`（線上單）
--   order_source = 'pos'    → order_ref = POS `pos_orders.id`（店內／平台單）
--
-- ⚠️ 呢張表**只經 server route 讀寫**（service_role），
--    anon / authenticated 一個權限都唔畀 —— 同 `pos_staff` 同一慣例。
--    前端唔會訂閱呢張表（零 Realtime channel、零 polling），
--    「外送」tab 只會喺開啟時按需拉一次 + 手動刷新。
--
-- 安全性：全部 `if not exists`，可重複執行。
-- ⚠️ migration 已寫 ≠ 已跑 —— 要人手去 POS Supabase（iyrywzormzisyppkokbi）
--    → SQL Editor 貼。未跑之前 API 會回 `tableReady:false`，UI 顯示提示而唔會爆。
-- =============================================================================

create table if not exists public.pos_delivery_jobs (
  id                    uuid primary key default gen_random_uuid(),
  -- = Ledger `merchants.id` / `pos_orders.store_id`（同一個 UUID 口徑）
  store_id              text        not null,

  -- ── 關聯 ──────────────────────────────────────────────────────────────
  -- 'ledger' = 會員通線上單；'pos' = POS 本地／平台單
  order_source          text        not null,
  order_ref             text        not null,
  -- 落單當刻嘅顯示單號（取餐碼 018／外賣 003／澳覓 463403）；單號本身唔改
  order_no_snapshot     text        not null default '',
  -- 平台單先有：aomi / mfood
  platform              text,

  -- 落單當刻嘅配送方式快照（見 src/lib/pos/delivery/delivery-mode.ts）
  delivery_mode         text        not null default 'unknown',

  -- ── 派送渠道 ──────────────────────────────────────────────────────────
  provider              text        not null default 'siteb',
  -- SiteB 回傳嘅訂單 id（uuid 字串）
  provider_order_id     text,
  -- Ledger 側紀錄 id（order_delivery_dispatch.id 或 merchant_external_dispatches.id）
  ledger_dispatch_id    uuid,
  -- draft = 本地草稿（未送出）；queued = 已排隊等推送；
  -- 其餘對齊 SiteB 狀態
  status                text        not null default 'draft',
  last_event            text,
  last_payload          jsonb,

  -- ── 送貨快照（客人資料；暫不自動清除）────────────────────────────────
  customer_name         text,
  customer_phone        text,
  customer_address      text,
  customer_lat          double precision,
  customer_lng          double precision,
  customer_note         text,

  -- ── 錢 ────────────────────────────────────────────────────────────────
  fee_amount_avos       bigint      not null default 0,
  fee_paid_by           text        not null default 'shop',
  -- 貨到付款（車手代收）；平台單一般 0（客人已喺平台付款）
  cod_amount_avos       bigint      not null default 0,

  -- ── 審計 ──────────────────────────────────────────────────────────────
  created_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  delivered_at          timestamptz,

  constraint pos_delivery_jobs_source_check
    check (order_source in ('ledger', 'pos')),
  constraint pos_delivery_jobs_status_check
    check (status in ('draft', 'queued', 'new', 'accepted', 'picked_up',
                      'delivered', 'canceled', 'failed')),
  constraint pos_delivery_jobs_mode_check
    check (delivery_mode in ('platform', 'merchant', 'pickup', 'unknown')),
  constraint pos_delivery_jobs_fee_check
    check (fee_amount_avos >= 0),
  constraint pos_delivery_jobs_cod_check
    check (cod_amount_avos >= 0),
  constraint pos_delivery_jobs_paid_by_check
    check (fee_paid_by in ('shop', 'customer')),
  constraint pos_delivery_jobs_provider_check
    check (provider in ('siteb'))
);

comment on table public.pos_delivery_jobs is
  'POS 外送派單紀錄。一單一筆；order_source+order_ref 跨 DB 關聯（冇 FK）。2026-10-31。';
comment on column public.pos_delivery_jobs.order_ref is
  'ledger → Ledger orders.id；pos → pos_orders.id。單號顯示用 order_no_snapshot。';
comment on column public.pos_delivery_jobs.delivery_mode is
  '落單當刻嘅配送方式：platform（平台專送，唔准派）／merchant（商家自送）／pickup（自取）／unknown。';
comment on column public.pos_delivery_jobs.status is
  'draft=本地草稿、queued=已排隊未推送；其餘對齊 SiteB：new/accepted/picked_up/delivered/canceled/failed。';

-- 一單一筆（重派＝更新同一行，唔會累積重複 job）
create unique index if not exists pos_delivery_jobs_order_uidx
  on public.pos_delivery_jobs (store_id, order_source, order_ref);

-- 「外送」tab 列表：按店、按更新時間倒序
create index if not exists pos_delivery_jobs_store_updated_idx
  on public.pos_delivery_jobs (store_id, updated_at desc);

-- 進行中嘅派單（卡片顯示「已派送」／防止重複派）
create index if not exists pos_delivery_jobs_active_idx
  on public.pos_delivery_jobs (store_id, status)
  where status in ('draft', 'queued', 'new', 'accepted', 'picked_up');


-- ---------------------------------------------------------------------------
-- RLS：service_role only（前端永遠唔會直接讀，冇 Realtime 訂閱）
-- ---------------------------------------------------------------------------
alter table public.pos_delivery_jobs enable row level security;

drop policy if exists "pos_delivery_jobs service only" on public.pos_delivery_jobs;
create policy "pos_delivery_jobs service only"
  on public.pos_delivery_jobs
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.pos_delivery_jobs from anon, authenticated;
grant all on public.pos_delivery_jobs to service_role;
