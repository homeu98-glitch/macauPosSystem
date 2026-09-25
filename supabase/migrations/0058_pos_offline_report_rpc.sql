-- 0058 · Ledger「線下營業摘要」聚合函數 `public.pos_offline_report()`
-- =============================================================================
-- 契約：docs/integration/pos-offline-report-api.md（v1，2026-09-24，Ledger 發出）
-- 審視：docs/integration/pos-offline-report-contract-review-2026-09-25.md
-- 實作：docs/150-ledger-offline-report-route.md
-- 呼叫方：`GET /api/integration/ledger/offline-report`（HMAC 驗簽後用 service_role call）
--
-- 【為咩要寫 SQL，唔喺 route 內用 PostgREST 加總】
--   ① egress：90 日窗口逐行拉落 Vercel 再加總 ＝ 每次報表載入 1～9 個請求、約 1–2 MB，
--      而本專案嘅 egress 紀律係「少拉」唔係「拉細」（docs/reviews/egress-optimization-plan-2026-09-21.md）。
--   ② 口徑唯一：聚合只喺一個地方寫一次，唔會同前端 `aggregate()` 分叉出第二套。
--   ③ PostgREST 冇 GROUP BY（支付方式分項一定要 function 才砌得出），呢點同 docs/94 §1.2 一致。
--
-- 【⚠️ 同 docs/94 嘅分別（唔可以照抄 94）】
--   94 嘅 `report_ro.build_full_report()` body 引用 83 號嘅 22 個 `report_ro.v_*` view，
--   而 83（`ledger_report_ro` 角色 + `report_ro` schema）**從未在 production 建立**
--   ⇒ 冇跑 83 就 create 唔到，改用 security definer 都救唔到（問題係 view 唔存在）。
--   本函數**直接讀 `public.pos_orders`**，零依賴 83／94，亦唔會拉重整套唯讀角色落嚟。
--
-- 【口徑（唯一真源，逐項對齊 POS `/reports`）】
--   計入      ：`status in ('settled','paid')`；`refunded` / `partially_refunded` 整張剔除
--               （＝ `isSaleCountable()`；2026-09-25 用戶拍板「線下 `paid` 要計」）
--   排除      ：`online_order_id is not null`（線上投影單，Ledger 自己已有該筆線上數）
--   日歸屬    ：`coalesce(settled_at, reopened_at, updated_at, created_at)` 轉 `Asia/Macau`
--               （＝ `orderEventInstant()`；`settled_at` 0057 排最前，重推唔會漂）
--   人流      ：`table_id = 'counter'` 一單 1 人，否則 `greatest(1, party_size)`
--               （＝「當日人流」卡 `restaurant-footfall.ts`，**唔係**報表 `Agg.covers` 嘅 Σ party_size）
--   金額      ：DB 內已經換成 **avos 整數**（MOP × 100，`round`），非負
--   退款      ：`kpi.refundedAvos` 只係「呢段期間退過幾多」嘅揭露值；
--               `flags.refundsNetted = false` ⇒ 營業額係**未扣退款**嘅毛額（同 POS 報表一致）
--
-- 【唯讀 ＋ 權限】
--   stable、security invoker（唔提升權限，同 0046 一致）、body 內全部 select。
--   revoke anon/authenticated ⇒ 只有 service_role 叫得（否則 anon 可以跨店讀全期聚合，
--   繞過 0041 嘅 72 小時 anon 時間窗）。
--
-- 【範圍】上限 90 個日曆日（含首尾）。超出**唔報錯**，由 `p_to` 倒推 89 日並回 `clamped=true`
--   （同 docs/94 §3 一致；Ledger 會核對 clamp 是否恰等於 `to − 89 日`）。
-- =============================================================================

create or replace function public.pos_offline_report(
  p_store_id text,
  p_from     date default null,
  p_to       date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  k_tz        constant text := 'Asia/Macau';
  k_max_days  constant int  := 90;
  k_max_method_len constant int := 32;   -- 契約：method 超過 32 字會被 Ledger 整包拒收 ⇒ 呢邊先截斷

  v_to          date;
  v_from        date;
  v_clamped     boolean := false;
  v_found       boolean;
  v_order_count bigint;
  v_revenue     bigint;
  v_discount    bigint;
  v_covers      bigint;
  v_refunded    bigint;
  v_by_payment  jsonb;
begin
  if p_store_id is null or btrim(p_store_id) = '' then
    raise exception 'p_store_id 必填' using errcode = '22023';
  end if;

  -- ── 範圍：預設今日（澳門），超 90 日由 to 倒推 89 日 ──
  v_to := coalesce(p_to, (now() at time zone k_tz)::date);
  v_from := coalesce(p_from, v_to);
  if v_from > v_to then
    v_from := v_to;              -- 防禦：route 已回 400，呢度唔好 raise
  end if;
  if (v_to - v_from) >= k_max_days then
    v_from := v_to - (k_max_days - 1);
    v_clamped := true;
  end if;

  -- ── 店是否存在：唔加時間／狀態條件（契約：從未出現在 pos_orders 就係 404）──
  select exists (
    select 1 from public.pos_orders o where o.store_id = p_store_id
  ) into v_found;

  -- ── KPI（線下、可計銷售單）──
  with base as (
    select o.total, o.discount_amount, o.table_id, o.party_size
    from public.pos_orders o
    where o.store_id = p_store_id
      and o.online_order_id is null
      and o.status in ('settled', 'paid')
      and (coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at) at time zone k_tz)::date
            between v_from and v_to
  )
  select
    count(*),
    coalesce(sum(round(coalesce(total, 0) * 100))::bigint, 0),
    coalesce(sum(round(coalesce(discount_amount, 0) * 100))::bigint, 0),
    coalesce(sum(case when table_id = 'counter' then 1 else greatest(1, coalesce(party_size, 1)) end)::bigint, 0)
  into v_order_count, v_revenue, v_discount, v_covers
  from base;

  -- ── 支付方式分項（同 KPI 同一批單、同一口徑；ΣamountAvos = kpi.revenueAvos）──
  with base as (
    select o.total, o.payment_method
    from public.pos_orders o
    where o.store_id = p_store_id
      and o.online_order_id is null
      and o.status in ('settled', 'paid')
      and (coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at) at time zone k_tz)::date
            between v_from and v_to
  )
  select coalesce(
           jsonb_agg(jsonb_build_object('method', m.method, 'amountAvos', m.amount_avos) order by m.amount_avos desc),
           '[]'::jsonb
         )
  into v_by_payment
  from (
    select left(coalesce(nullif(btrim(payment_method), ''), '未記錄'), k_max_method_len) as method,
           coalesce(sum(round(coalesce(total, 0) * 100))::bigint, 0) as amount_avos
    from base
    group by 1
  ) m;

  -- ── 退款總額（揭露值）──
  -- 取值同 `refund-net.ts refundAmountOf()` 一致：`refunded_amount` 有正值先用，
  -- 否則累加 `refund_records[].amount`（舊單／未跑 0049 嘅環境）。
  with base as (
    select o.refunded_amount, o.refund_records
    from public.pos_orders o
    where o.store_id = p_store_id
      and o.online_order_id is null
      and o.status in ('refunded', 'partially_refunded')
      and (coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at) at time zone k_tz)::date
            between v_from and v_to
  ),
  raw as (
    select greatest(
             0,
             coalesce(
               nullif(refunded_amount, 0),
               (
                 select coalesce(sum(
                   case when (r ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$' then (r ->> 'amount')::numeric else 0 end
                 ), 0)
                 from jsonb_array_elements(
                   case when jsonb_typeof(refund_records) = 'array' then refund_records else '[]'::jsonb end
                 ) r
               )
             )
           ) as amount
    from base
  )
  select coalesce(sum(round(amount * 100))::bigint, 0) into v_refunded from raw;

  return jsonb_build_object(
    'found',       v_found,
    'from',        to_char(v_from, 'YYYY-MM-DD'),
    'to',          to_char(v_to, 'YYYY-MM-DD'),
    'clamped',     v_clamped,
    'orderCount',  v_order_count,
    'revenueAvos', v_revenue,
    'refundedAvos', v_refunded,
    'discountAvos', v_discount,
    'covers',      v_covers,
    'byPayment',   v_by_payment
  );
end;
$$;

comment on function public.pos_offline_report(text, date, date) is
  'Ledger 報表頁「店內 POS（線下）」卡嘅聚合來源（契約 v1）。只計 status ∈ {settled,paid}、'
  '排除 online_order_id（線上投影單）、日歸屬 = coalesce(settled_at, reopened_at, updated_at, created_at) '
  '轉 Asia/Macau、金額回 avos 整數、上限 90 個日曆日並回 clamped。唯讀 stable、唔提升權限、只 grant service_role。';

-- ── 權限：只有 service_role 叫得 ──
-- 🔴 唔可以開畀 anon／authenticated：呢支函數一次回全店任意區間嘅聚合，
--    會繞過 0041 對 anon 嘅 72 小時讀取窗（等於把入站窗口變成全期報表）。
revoke all on function public.pos_offline_report(text, date, date) from public, anon, authenticated;
grant execute on function public.pos_offline_report(text, date, date) to service_role;

-- ── 可選：90 日窗口慢先加（同 0044 重疊，一般唔需要）──
-- create index if not exists pos_orders_store_settled_idx on public.pos_orders (store_id, settled_at desc)
--   where status in ('settled', 'paid') and online_order_id is null;
