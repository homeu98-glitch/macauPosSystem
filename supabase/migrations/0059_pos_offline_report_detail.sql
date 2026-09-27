-- 0059 · 線下報表增補：`orders[]`（訂單明細）+ `dishes[]`（菜品排名）
-- =============================================================================
-- 契約：docs/integration/pos-offline-report-api.md（v1，2026-09-24，Ledger 發出）
--       ＋ 增補：docs/integration/pos-offline-report-v1-addendum-2026-09-26.md
-- 實作：docs/151-ledger-offline-report-orders-dishes.md
-- 前身：0058_pos_offline_report_rpc.sql（**已上線**；本檔 create or replace 同一簽名）
-- 呼叫方：`GET /api/integration/ledger/offline-report`（HMAC 驗簽後用 service_role call）
--
-- 【為咩係新 migration 而唔係改 0058】
--   0058 已經喺 production 跑過（2026-09-25 單日對數已通過），改檔唔會令商家重新執行。
--   本檔 `create or replace function` **簽名完全不變**（text, date, date）⇒
--   grants 會保留（下面照樣再 revoke/grant 做雙保險）；輸出 jsonb 只係多幾個 key，
--   舊 client（Ledger 尚未讀新欄位）行為不變。
--
-- 【本檔新增嘅 key（全部 additive，v 仍然係 1）】
--   ordersTotal         int     ：符合條件嘅線下單總數（**未截斷前**）
--   orders[]            array   ：`{orderNo, totalAvos, status}`，**事件時間倒序**（最新喺前）
--   dishesTotal         int     ：不同菜品款數（未截斷前）
--   dishes[]            array   ：`{name, qty, revenueAvos}`，**銷量倒序**（並列時按名稱）
--
--   ⇒ `flags.ordersTruncated` / `flags.dishesTruncated` **唔喺呢度回**：
--     route 用 `ordersTotal > orders.length` 推出（兩者來自同一支 SQL ⇒ 唔會分叉）。
--     呢個係刻意的：SQL 係「總數」嘅唯一權威，route 只准**核對 + 推導**。
--
-- 【口徑：orders[] 同 dishes[] **唔係同一批單**（好易搞錯，特此寫死）】
--   · `orders[]`  ＝ 該區間嘅**全部線下單**，包括未結帳（draft / sent_to_kitchen / reopened）
--                    同已收錢（settled / paid）同退款（refunded / partially_refunded）。
--                    因為商家要睇「邊張未埋單」。⇒ `orders.length` **唔等於** `kpi.orderCount`。
--                    唯一剔除：`status = 'cancelled'`（作廢單唔係營業事件）。
--   · `dishes[]`  ＝ **只計 status in ('settled','paid')**（同 KPI 同一批單），
--                    同 POS `/reports` 菜品排行口徑一致（`isSaleCountable()`）。
--   · 兩者都排除 `online_order_id is not null`（線上投影單）。
--
-- 【🔴 唔可以回自由文字／個資】
--   `order_note`、items 嘅 `note`、`discount_note`、`comp_note` 一律**唔出**：
--   呢啲係店員手打，可能寫咗「陳先生」「13xxxxxx」等顧客識別資訊。
--   契約 v1 明文「不是訂單明細／顧客個資」，增補後仍然守呢條線。
--   （運氣好：`pos_orders` 根本冇收銀員欄 —— `settledBy`/`settledByName` 只存本機
--     `types.ts`，唔喺 `POS_ORDER_DB_COLUMNS` ⇒ 雲端零員工姓名。）
--
-- 【排序同截斷：權威在 SQL】
--   同 90 日 clamp 同一原則（見 docs/113「權威只可以有一個」）：截斷**只喺呢度做**，
--   route 收到 `ordersTruncated` 只可以照樣 echo 同核對，**唔可以自己再截一次**。
--   截斷保留**最新**嘅（倒序取頭 N）——因為查報表嘅人最關心近期。
--
-- 【金額】一律 avos 整數（MOP × 100）。DB 內 `greatest(0, round(...))` 夾非負
--   （契約：金額一律非負整數；正常資料唔會有負，呢層純屬防禦）。
--
-- 【唯讀 ＋ 權限】同 0058：stable、security invoker、只 grant service_role。
--   anon 叫得到就等於繞過 0041 嘅 72 小時讀取窗。
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
  k_tz              constant text := 'Asia/Macau';
  k_max_days        constant int  := 90;
  k_max_method_len  constant int  := 32;    -- 契約：method > 32 字會被整包拒收
  k_max_orders      constant int  := 3000;  -- 90 日實測約 2 880 張 ⇒ 正常唔會截
  k_max_dishes      constant int  := 300;   -- 餐牌款數量級（含改名遺留）遠低於此
  k_max_name_len    constant int  := 64;
  k_max_status_len  constant int  := 32;
  k_max_orderno_len constant int  := 64;

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
  v_orders_total bigint;
  v_orders      jsonb;
  v_dishes_total bigint;
  v_dishes      jsonb;
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

  -- ── 訂單明細（orders[]）：全部線下單（含未結帳），事件時間倒序，上限 k_max_orders ──
  -- 🔴 欄位刻意只有三個（2026-09-26 用戶拍板「就訂單號、價格、狀態就夠，唔使回所有嘢」）。
  --    唔好「好心」加 items／備註／時間：備註係自由文字（可能藏顧客識別資訊），
  --    而 payload 每加一欄 × 2 880 張單就會反映喺 Ledger 嗰邊嘅 3 秒 timeout。
  --    `count(*) over ()` 喺 LIMIT 之前計算 ⇒ 一次掃描就同時拎到「總數」同「首 N 筆」。
  with base as (
    select
      left(o.local_order_no, k_max_orderno_len) as order_no,
      coalesce(nullif(btrim(o.status), ''), 'unknown') as status,
      o.total,
      coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at) as ev
    from public.pos_orders o
    where o.store_id = p_store_id
      and o.online_order_id is null
      -- 只剔除作廢單；未結帳（draft／sent_to_kitchen／reopened）同退款單照出
      and coalesce(btrim(o.status), '') <> 'cancelled'
      and (coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at) at time zone k_tz)::date
            between v_from and v_to
  )
  select
    coalesce(max(p.total_rows), 0),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'orderNo',   p.order_no,
          'totalAvos', greatest(0, round(coalesce(p.total, 0) * 100))::bigint,
          'status',    left(p.status, k_max_status_len)
        )
        order by p.ev desc nulls last
      ),
      '[]'::jsonb
    )
  into v_orders_total, v_orders
  from (
    select b.*, count(*) over () as total_rows
    from base b
    order by b.ev desc nulls last
    limit k_max_orders
  ) p;

  -- ── 菜品排名（dishes[]）：只計可計銷售單、排除已退菜、銷量倒序，上限 k_max_dishes ──
  -- 聚合 key 同 POS `/reports` 一致：`menuItemId|名稱`（**下單當時快照**，
  -- 唔對應當前餐牌）⇒ 改咗名／改咗價嘅菜各自一行，歷史唔會因改名而「失蹤」。
  with base as (
    select
      coalesce(nullif(btrim(e.it ->> 'menuItemId'), ''), '') || '|' ||
        coalesce(nullif(btrim(e.it ->> 'name'), ''), '(未命名)') as dkey,
      coalesce(nullif(btrim(e.it ->> 'name'), ''), '(未命名)') as dname,
      case when (e.it ->> 'quantity') ~ '^-?[0-9]+(\.[0-9]+)?$' then (e.it ->> 'quantity')::numeric else 0 end as qty,
      case when (e.it ->> 'price')    ~ '^-?[0-9]+(\.[0-9]+)?$' then (e.it ->> 'price')::numeric    else 0 end as price
    from public.pos_orders o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
    ) as e(it)
    where o.store_id = p_store_id
      and o.online_order_id is null
      and o.status in ('settled', 'paid')
      and (coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at) at time zone k_tz)::date
            between v_from and v_to
      -- 已退菜唔計（同 POS `aggregate()` 一致：voided 只入 voidQty，唔入菜品銷售）
      and coalesce(e.it ->> 'voided', 'false') <> 'true'
  ),
  agg as (
    select
      dkey,
      min(dname) as dname,
      greatest(0, round(sum(qty))::bigint) as qty_total,
      greatest(0, round(sum(price * qty) * 100)::bigint) as revenue_avos
    from base
    group by dkey
  )
  select
    coalesce(max(r.total_rows), 0),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'name',        left(r.dname, k_max_name_len),
          'qty',         r.qty_total,
          'revenueAvos', r.revenue_avos
        )
        order by r.qty_total desc, r.dname asc
      ),
      '[]'::jsonb
    )
  into v_dishes_total, v_dishes
  from (
    select a.*, count(*) over () as total_rows
    from agg a
    order by a.qty_total desc, a.dname asc
    limit k_max_dishes
  ) r;

  return jsonb_build_object(
    'found',           v_found,
    'from',            to_char(v_from, 'YYYY-MM-DD'),
    'to',              to_char(v_to, 'YYYY-MM-DD'),
    'clamped',         v_clamped,
    'orderCount',      v_order_count,
    'revenueAvos',     v_revenue,
    'refundedAvos',    v_refunded,
    'discountAvos',    v_discount,
    'covers',          v_covers,
    'byPayment',       v_by_payment,
    'ordersTotal',     v_orders_total,
    'orders',          v_orders,
    'dishesTotal',     v_dishes_total,
    'dishes',          v_dishes
  );
end;
$$;

comment on function public.pos_offline_report(text, date, date) is
  'Ledger 報表頁「店內 POS（線下）」卡嘅聚合來源（契約 v1 ＋ 2026-09-26 增補）。'
  'KPI／byPayment：只計 status ∈ {settled,paid}、排除 online_order_id（線上投影單）。'
  'orders[]：該區間全部線下單（含未結帳，只剔除 cancelled），回 {orderNo,totalAvos,status}，事件時間倒序、上限 3000。'
  'dishes[]：只計 {settled,paid}、排除已退菜，回 {name,qty,revenueAvos}，銷量倒序、上限 300。'
  '日歸屬 = coalesce(settled_at, reopened_at, updated_at, created_at) 轉 Asia/Macau；'
  '金額回 avos 整數；上限 90 個日曆日並回 clamped；'
  '唔回任何自由文字／顧客個資。唯讀 stable、唔提升權限、只 grant service_role。';

-- ── 權限：只有 service_role 叫得 ──
-- 🔴 唔可以開畀 anon／authenticated：呢支函數一次回全店任意區間嘅聚合＋明細，
--    會繞過 0041 對 anon 嘅 72 小時讀取窗（等於把入站窗口變成全期報表）。
revoke all on function public.pos_offline_report(text, date, date) from public, anon, authenticated;
grant execute on function public.pos_offline_report(text, date, date) to service_role;

-- ============================================================================
-- 驗收（貼完之後逐條跑；全部唯讀；🔴 唔好用 begin;…commit;）
-- ============================================================================
-- ① 三個新 key 都在，且型別正確
--   select jsonb_typeof(r -> 'orders'), jsonb_typeof(r -> 'ordersTotal'),
--          jsonb_typeof(r -> 'dishes'), jsonb_typeof(r -> 'dishesTotal')
--   from public.pos_offline_report('<STORE>', '2026-09-01', '2026-09-30') r;
--   → array / number / array / number
--
-- ② KPI 同 ordersTotal 對得上（orders 含未結帳 ⇒ ordersTotal ≥ orderCount）
--   select r -> 'orderCount' as kpi_count, r -> 'ordersTotal' as orders_total,
--          jsonb_array_length(r -> 'orders') as orders_len
--   from public.pos_offline_report('<STORE>', '2026-09-01', '2026-09-30') r;
--   → orders_len = orders_total（未截斷時）；orders_total ≥ kpi_count
--
-- ③ 已被截斷嘅極端情況（若 orders_len < orders_total ⇒ 有截斷）
--   select (r ->> 'ordersTotal')::int > jsonb_array_length(r -> 'orders') as truncated
--   from public.pos_offline_report('<STORE>', '2026-01-01', '2026-09-30') r;
--
-- ④ 菜品排名加總 ≈ KPI 營業額（差異 = 服務費／稅／全單折扣／抹零）
--   select r -> 'revenueAvos' as kpi_revenue,
--          (select coalesce(sum((d ->> 'revenueAvos')::bigint), 0)
--             from jsonb_array_elements(r -> 'dishes') d) as dishes_revenue
--   from public.pos_offline_report('<STORE>', '2026-09-24', '2026-09-24') r;
--
-- ⑤ 權限：anon 應該被拒
--   set role anon;
--   select public.pos_offline_report('<STORE>', null, null);   -- 期望：permission denied
--   reset role;
--
-- ⑥ 唔應該有任何自由文字欄（orders／dishes 嘅 key 只有指定幾個）
--   select distinct jsonb_object_keys(o) from public.pos_offline_report('<STORE>', null, null) r
--     cross join lateral jsonb_array_elements(r -> 'orders') o;
--   → 只可以係 orderNo / totalAvos / status
