-- 0077 · 訂位（reservation）+ 預點菜 + 預付
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 背景
-- ─────────────────────────────────────────────────────────────────────────────
-- 商家要一個「訂位」功能：
--   ① 客人（會員通）或店員（POS／商家後台）可以先訂位，並預先選好菜（預點菜）；
--   ② 預點菜可套用會員折扣，餘額足夠可即時扣款（預付）；
--   ③ 到店掃碼 → 店員確認 → 入座開枱，預點菜帶入正式 POS 訂單。
--
-- 設計口徑（見 deliverables/gstack/feature-dev-reservation-2026-11-06.md）：
--   · 訂位單**不是**訂單，永不寫入 pos_orders；只有「入座開枱」才生成 PosOrder。
--   · 預付**不算營業額**，係預收款；開枱後作為訂單「已付」抵扣。
--   · 預點菜只存快照（菜名／規格／當時價），到店按當日菜牌重算。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ 兩張表都係 anon / authenticated **完全不可讀**（含電話，屬個人資料）
--    前端一律經 server route 讀寫（service_role 繞過 RLS）。
--    POS 前端唔會直連、唔會訂閱 Realtime（避免多一條常駐 channel）。
-- ─────────────────────────────────────────────────────────────────────────────

-- ============================================================================
-- 1) 訂位設置（每店一行）
-- ============================================================================

create table if not exists public.pos_reservation_settings (
  store_id text primary key,

  /** 接受訂位總開關。關閉後客人不可提交新訂位，已存在的照舊處理。 */
  enabled boolean not null default false,

  /** 訂位須知，客人端原樣顯示。 */
  notice text,

  /** 最多提前幾天可訂。 */
  lead_days_max integer not null default 14,
  /** 最遲要提前幾分鐘（少於此值不可自訂）。 */
  lead_minutes_min integer not null default 30,

  /** 時段間隔（分鐘）：15 / 30 / 60。 */
  slot_interval_minutes integer not null default 30,
  /** 每格最多幾組（配額制，不做翻枱推演）。 */
  slot_quota integer not null default 5,
  /** 用餐時長（分鐘），用於提示離座時間。 */
  turn_minutes integer not null default 90,

  min_party_size integer not null default 1,
  max_party_size integer not null default 20,
  /** 達此人數轉人工確認（即使 auto_confirm 開著）。 */
  large_party_threshold integer not null default 8,

  /** 客人提交即確認。 */
  auto_confirm boolean not null default true,
  /** 到店寬限（分鐘），超過標「逾時」。 */
  grace_minutes integer not null default 15,
  /** 自行取消截止（開始前幾分鐘）。 */
  cancel_cutoff_minutes integer not null default 120,

  /** 需要訂金（只作標記，線下收取）。 */
  deposit_required boolean not null default false,

  /** 預點菜是否可用餘額即時付款。 */
  prepay_enabled boolean not null default false,
  /** 預付範圍：全額 / 只收訂金。 */
  prepay_mode text not null default 'full',
  /** prepay_mode = 'deposit' 時的金額。 */
  deposit_amount numeric(12,2) not null default 0,
  /** 預付可全額退款的截止（開始前幾分鐘）。 */
  refund_cutoff_minutes integer not null default 120,

  /**
   * 每週營業時段。key = 1..7（1 = 週一，ISO），value = {"open":"17:30","close":"22:30"}。
   * close < open 代表跨日（例如 20:00–02:00），該時段的訂位歸前一營業日。
   * 空物件 = 未設定 → 用 slot_interval 由 00:00 起算（不推薦，只作 fallback）。
   */
  service_hours jsonb not null default '{}'::jsonb,

  updated_at timestamptz not null default now(),

  constraint pos_reservation_settings_interval_check
    check (slot_interval_minutes in (15, 30, 60)),
  constraint pos_reservation_settings_quota_check
    check (slot_quota between 1 and 50),
  constraint pos_reservation_settings_lead_check
    check (lead_days_max between 1 and 60 and lead_minutes_min between 0 and 1440),
  constraint pos_reservation_settings_party_check
    check (min_party_size between 1 and 99 and max_party_size between 1 and 99
           and min_party_size <= max_party_size),
  constraint pos_reservation_settings_prepay_check
    check (prepay_mode in ('full', 'deposit'))
);

comment on table public.pos_reservation_settings is
  '訂位設置（每店一行）。anon/authenticated 全禁，只經 server route 讀寫。見 migration 0077。';


-- ============================================================================
-- 2) 訂位單
-- ============================================================================

create table if not exists public.pos_reservations (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,

  /** 給客人的訂位碼，例如 R1106-018（每日重編）。 */
  code text not null,

  /** 營業日（不是自然日）—— 夜宵 01:30 的訂位屬前一天。 */
  biz_date date not null,
  /** 到店時間。 */
  slot_at timestamptz not null,

  party_size integer not null,

  guest_name text not null default '',
  guest_phone text not null default '',
  guest_note text,

  status text not null default 'pending',

  /** 來源：店員代訂 / 會員通 / 電話 / 現場。 */
  source text not null default 'pos',

  /** 入座後的枱與訂單。 */
  table_id text,
  table_name text,
  order_id text,
  order_no text,

  /**
   * 預點菜快照（jsonb array）。每項：
   * { menuItemId, name, specText, specs, qty, unitPrice, originalUnitPrice,
   *   memberPrice, discountRate, snapshotAt }
   * ⚠️ 快照價只用於顯示與對帳，結帳一律按到店當日現價。
   */
  items jsonb not null default '[]'::jsonb,
  /** 快照原價合計。 */
  items_subtotal numeric(12,2) not null default 0,
  /** 會員折扣金額（正數）。 */
  discount_amount numeric(12,2) not null default 0,
  /** 應付 = 小計 − 折扣。 */
  payable_amount numeric(12,2) not null default 0,

  /** 已預付金額（0 = 未預付）。 */
  paid_amount numeric(12,2) not null default 0,
  paid_at timestamptz,
  /** 交易號 TXN-xxxx，出事時對帳用。 */
  payment_ref text,
  /** balance | cash | none */
  payment_method text,

  refund_amount numeric(12,2) not null default 0,
  refunded_at timestamptz,
  refund_ref text,

  /** Ledger 會員 id（若有）。 */
  member_id text,
  /** 下單當刻的會員折扣率快照（例如 90 = 9 折）。 */
  member_discount_rate integer,

  created_by text,

  confirmed_at timestamptz,
  arrived_at timestamptz,
  seated_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pos_reservations_status_check check (
    status in ('pending', 'confirmed', 'arrived', 'seated', 'completed', 'canceled', 'no_show', 'waitlist')
  ),
  constraint pos_reservations_source_check check (
    source in ('pos', 'ledger', 'phone', 'walkin')
  ),
  constraint pos_reservations_party_check check (party_size between 1 and 99),
  constraint pos_reservations_paid_check check (paid_amount >= 0 and refund_amount >= 0)
);

comment on table public.pos_reservations is
  '訂位單（含預點菜快照與預付）。永不寫入 pos_orders；入座開枱才生成 PosOrder。見 migration 0077。';

/** 訂位碼在「同店同日」唯一。 */
create unique index if not exists pos_reservations_store_bizdate_code_uidx
  on public.pos_reservations (store_id, biz_date, code);

/** 同一店、同一時段、同一手機號只准一張未取消的訂位（防重複提交）。 */
create unique index if not exists pos_reservations_dup_guard_uidx
  on public.pos_reservations (store_id, slot_at, guest_phone)
  where guest_phone <> '' and status not in ('canceled', 'no_show');

/** 列表熱路徑：某店某營業日。 */
create index if not exists pos_reservations_store_slot_idx
  on public.pos_reservations (store_id, slot_at);

/** 客人端按訂位碼查（server route 用）。 */
create index if not exists pos_reservations_code_idx
  on public.pos_reservations (code);

/** 未完成訂位（紅點 / 待確認計數）。 */
create index if not exists pos_reservations_open_idx
  on public.pos_reservations (store_id, status)
  where status in ('pending', 'confirmed', 'arrived');


-- ============================================================================
-- 3) 建立訂位 RPC —— 配額在 DB 層原子扣，前端永不參與判斷
-- ============================================================================
--
-- 為什麼要 advisory lock：
--   兩個客人在 18:00 同時按提交，各自讀到「剩 1 組」→ 兩張都寫入 = 超賣。
--   鎖粒度用 (store_id, biz_date)：同時覆蓋「當日組數」與「訂位碼序號」兩件事，
--   避免不同時段並發時生成同一個 code（code 有唯一索引，撞了會直接 500）。
--

create or replace function public.create_reservation(
  p_store_id text,
  p_biz_date date,
  p_slot_at timestamptz,
  p_party_size integer,
  p_guest_name text,
  p_guest_phone text,
  p_guest_note text,
  p_source text,
  p_items jsonb,
  p_items_subtotal numeric,
  p_discount_amount numeric,
  p_payable_amount numeric,
  p_member_id text,
  p_member_discount_rate integer,
  p_created_by text,
  p_force_status text default null
) returns public.pos_reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.pos_reservation_settings;
  v_used integer;
  v_seq integer;
  v_code text;
  v_status text;
  v_row public.pos_reservations;
begin
  -- 同店同日串行化（見上面註釋）
  perform pg_advisory_xact_lock(hashtext(p_store_id || ':' || p_biz_date::text));

  select * into v_settings
    from public.pos_reservation_settings
   where store_id = p_store_id;

  if not found then
    raise exception 'reservation_disabled' using errcode = 'P0001';
  end if;
  if not v_settings.enabled then
    raise exception 'reservation_disabled' using errcode = 'P0001';
  end if;

  if p_party_size < v_settings.min_party_size or p_party_size > v_settings.max_party_size then
    raise exception 'party_size_out_of_range' using errcode = 'P0001';
  end if;

  -- 配額：同一 slot 未取消的組數
  select count(*) into v_used
    from public.pos_reservations
   where store_id = p_store_id
     and slot_at = p_slot_at
     and status not in ('canceled', 'no_show');

  if v_used >= v_settings.slot_quota then
    raise exception 'slot_full' using errcode = 'P0001';
  end if;

  -- 訂位碼序號（當日累計；用 count+1 而非 max，避免刪單後跳號）
  select count(*) into v_seq
    from public.pos_reservations
   where store_id = p_store_id and biz_date = p_biz_date;

  v_code := 'R' || to_char(p_biz_date, 'MMDD') || '-' || lpad((v_seq + 1)::text, 3, '0');

  -- 狀態：呼叫方可強制（店員代訂可指定），否則按設置
  if p_force_status is not null then
    v_status := p_force_status;
  elsif v_settings.auto_confirm and p_party_size < v_settings.large_party_threshold then
    v_status := 'confirmed';
  else
    v_status := 'pending';
  end if;

  insert into public.pos_reservations (
    store_id, code, biz_date, slot_at, party_size,
    guest_name, guest_phone, guest_note,
    status, source,
    items, items_subtotal, discount_amount, payable_amount,
    member_id, member_discount_rate, created_by,
    confirmed_at
  ) values (
    p_store_id, v_code, p_biz_date, p_slot_at, p_party_size,
    coalesce(p_guest_name, ''), coalesce(p_guest_phone, ''), p_guest_note,
    v_status, coalesce(p_source, 'pos'),
    coalesce(p_items, '[]'::jsonb),
    coalesce(p_items_subtotal, 0), coalesce(p_discount_amount, 0), coalesce(p_payable_amount, 0),
    p_member_id, p_member_discount_rate, p_created_by,
    case when v_status = 'confirmed' then now() else null end
  )
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.create_reservation is
  '建立訂位（原子扣配額 + 生成訂位碼）。呼叫方必須先自行核價，唔信前端傳嚟嘅金額口徑以外的任何東西。';

revoke all on function public.create_reservation from anon, authenticated;


-- ============================================================================
-- 4) 時段餘量（讀）
-- ============================================================================
--
-- 回傳某店某營業日、每個 slot 的已用組數，前端用 slot_quota 相減即可。
-- 只回聚合數字，不回客人個資。

create or replace function public.reservation_slot_usage(
  p_store_id text,
  p_from timestamptz,
  p_to timestamptz
) returns table (slot_at timestamptz, used integer, guests integer)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.slot_at,
    count(*)::integer as used,
    coalesce(sum(r.party_size), 0)::integer as guests
  from public.pos_reservations r
  where r.store_id = p_store_id
    and r.slot_at >= p_from
    and r.slot_at < p_to
    and r.status not in ('canceled', 'no_show')
  group by r.slot_at;
$$;

revoke all on function public.reservation_slot_usage from anon, authenticated;


-- ============================================================================
-- 5) RLS —— 兩張表對 anon / authenticated 完全關閉
-- ============================================================================
--
-- 不建任何 policy = RLS 生效時一律拒絕；service_role 繞過 RLS，
-- 所以 server route（getSupabaseWriteClient）照樣讀寫。

alter table public.pos_reservation_settings enable row level security;
alter table public.pos_reservations enable row level security;

revoke all on public.pos_reservation_settings from anon, authenticated;
revoke all on public.pos_reservations from anon, authenticated;


-- ============================================================================
-- 6) 驗收
-- ============================================================================
--
-- 6.1 兩張表存在
--   select table_name from information_schema.tables
--    where table_schema='public' and table_name like 'pos_reservation%';
--   → pos_reservation_settings / pos_reservations
--
-- 6.2 anon 讀不到（必須報錯或 0 行）
--   set role anon;
--   select count(*) from public.pos_reservations;   -- → permission denied
--   reset role;
--
-- 6.3 配額生效（quota=2 時，第三次必須失敗）
--   select create_reservation(...);  -- 第 1、2 次成功
--   select create_reservation(...);  -- 第 3 次 → ERROR: slot_full
--
-- 6.4 訂位碼連續且唯一
--   select code, biz_date from public.pos_reservations
--    where store_id = '<uuid>' order by created_at;
--   → R1107-001, R1107-002, ...
--
-- 6.5 重複訂位被擋（同手機同時段）
--   同一手機、同一 slot 再插一次 → duplicate key value violates unique constraint
--   "pos_reservations_dup_guard_uidx"
-- ============================================================================
