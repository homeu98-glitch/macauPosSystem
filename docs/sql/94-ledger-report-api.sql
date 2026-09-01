-- =============================================================================
-- Macau POS → Ledger 報表「一次性 API」：report_ro.build_full_report()
-- 配套文檔：docs/94-ledger-report-api.md
--
-- 執行者  ：macau-pos 管理員（Supabase Dashboard → SQL Editor）
-- 引擎    ：PostgreSQL 15+（Supabase）
-- 冪等性  ：全部語句可重複執行（create or replace + if not exists + 顯式 grant）
--
-- 前置條件：**必須先跑過** docs/sql/83-ledger-readonly-access.sql
--           （Part A 建 ledger_report_ro、Part B 建 report_ro 22 個 View）
--
-- 做緊啲乜：
--   加一個 Postgres function，Ledger 用**現有嗰條唯讀連線** call 一次，
--   就攞到餐飲報表嘅全部可得內容（一個 jsonb），唔使再自己寫 20 條 SQL。
--      select report_ro.build_full_report('macau-store-a', '2026-09-01', '2026-09-01');
--      select report_ro.build_full_report('macau-store-a');            -- 預設今日
--      select report_ro.build_full_report('macau-store-a', null, null, 30);  -- 上限 30 日
--
-- 設計原則：
--   1. **口徑唯一**：所有聚合直接由 83 號嗰 22 個 View 砌出嚟，
--      **冇喺呢個 function 入面重新計一次數**（避免同前端報表分叉）。
--   2. **security invoker**：用 ledger_report_ro 自己嘅權限行，
--      讀唔到未授權嘅表（同 83 號一致）。唔用 definer，唔開後門。
--   3. **只讀**：標 stable，入面全部 select，冇任何 DML / DDL。
--   4. **範圍硬上限 90 日**（可調，見 p_max_days），超出自動截斷並喺
--      meta.clamped 標明，唔會靜默俾錯範圍嘅數。
--
-- ⚠️ 跑完記得做 Part C 驗收。
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- Part A · 建立 function
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function report_ro.build_full_report(
  p_store_id  text,
  p_from      date default null,   -- 起日（澳門日期），null = p_to
  p_to        date default null,    -- 止日（澳門日期），null = 今日
  p_max_days  int  default 90,      -- 區間上限（會夾到 1..366）
  p_top_n     int  default 50       -- dishes / tables / lowStock 每榜最多幾條
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, report_ro
as $$
declare
  -- ── 常數 ────────────────────────────────────────────────────────────────
  k_tz           constant text := 'Asia/Macau';
  k_version      constant text := '1.0';

  -- 用 DB 計唔到嘅欄位（一條 API 都變唔出嚟；前端報表有，但數據唔喺 macau-pos）
  k_base_gaps    constant jsonb := jsonb_build_array(
    'footfall',                 -- 人流：收銀端 localStorage 手動記錄，無硬件
    'soldOut',                  -- 沽清：pos_soldout 表程式無寫入，全空
    'ingredientConsumption',    -- 食材消耗：BOM 配方喺收銀端 localStorage
    'grossProfit',              -- 毛利：買貨成本喺 expenseRecorder（第三方）
    'memberTopup',              -- 會員充值：喺 Ledger 自己 DB（佢哋自己 merge）
    'memberCount',              -- 會員數：同上
    'onlineBalancePaid',        -- 線上餘額扣減：同上
    'salon'                     -- 美容院模組：本版範圍外（B1–B15 唔包）
  );

  -- 前端有、但呢個 function 計唔到嘅建議規則（俾 Ledger 自己補，連閾值一齊畀）
  k_unavail_rules constant jsonb := jsonb_build_array(
    jsonb_build_object(
      'rule', 'soldOutCount',
      'reason', '沽清狀態存於收銀端 localStorage，未上雲',
      'threshold', '沽清 >= 3 款 → level r'
    ),
    jsonb_build_object(
      'rule', 'memberTopupDrop',
      'reason', '會員充值金額喺 Ledger 自己嘅 DB，POS 側無從取得',
      'threshold', '本期充值 < 前 7 日日均 x 0.7 → level o'
    ),
    jsonb_build_object(
      'rule', 'grossProfit',
      'reason', '買貨成本喺 expenseRecorder（第三方），未同步至 macau-pos',
      'threshold', '毛利 = 營業額 − 買貨成本（已付）'
    )
  );

  -- ── 變數 ────────────────────────────────────────────────────────────────
  v_today       date;
  v_from_req    date;
  v_to_req      date;
  v_from        date;
  v_to          date;
  v_days        int;
  v_clamped     boolean := false;
  v_max_days    int;
  v_top_n       int;
  v_has_ps      boolean := false;   -- pos_orders.party_size 係咪存在（0017）
  v_gaps        jsonb := k_base_gaps;
  v_covers      bigint;
  v_tbl_covers  jsonb;
  v_result      jsonb;
  v_sugg        jsonb := '[]'::jsonb;
  v_sugg_sorted jsonb;

  v_revenue        numeric;
  v_online_share   numeric;
  v_disc_ratio     numeric;
  v_void_rate      numeric;
  v_daily_rev_avg  numeric;   -- 本期日均營業額
  v_base_rev_avg   numeric;   -- 前 7 日日均營業額
  v_base_onl_share numeric;   -- 前 7 日線上佔比
begin
  -- ── 0. 參數正規化 ───────────────────────────────────────────────────────
  if p_store_id is null or btrim(p_store_id) = '' then
    raise exception 'p_store_id 唔可以為空。請傳門店 store_id（可查 select distinct store_id from report_ro.v_pos_orders）。';
  end if;

  v_today    := (timezone(k_tz, now()))::date;
  v_to_req   := coalesce(p_to, v_today);
  v_from_req := coalesce(p_from, v_to_req);

  if v_from_req > v_to_req then
    raise exception 'p_from（%）唔可以晚過 p_to（%）。', v_from_req, v_to_req;
  end if;

  v_max_days := least(greatest(coalesce(p_max_days, 90), 1), 366);
  v_top_n    := least(greatest(coalesce(p_top_n, 50), 1), 500);

  v_from := v_from_req;
  v_to   := v_to_req;

  -- 超出上限 → 由 v_to 倒推截斷，並喺 meta.clamped 標明（唔靜默俾錯數）
  if (v_to - v_from + 1) > v_max_days then
    v_from    := v_to - (v_max_days - 1);
    v_clamped := true;
  end if;

  v_days := v_to - v_from + 1;

  -- 覆蓋人數要 pos_orders.party_size（migration 0017）。未跑 → covers 一律 null，
  -- 並喺 meta.gaps 標多一項，等對方 UI 顯示「—」而唔係當 0。
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'pos_orders'
      and column_name  = 'party_size'
  ) into v_has_ps;

  if not v_has_ps then
    v_gaps := v_gaps || jsonb_build_array('covers');
  end if;

  -- ── 1. 主查詢：一次過砌好全份報表 ───────────────────────────────────────
  -- 所有聚合都嚟自 report_ro.* View（83 號 Part B），口徑同前端報表一致。
  with o as (
    select *
    from report_ro.v_pos_orders
    where store_id = p_store_id
      and is_closed
      and biz_date between v_from and v_to
  ),

  store as (
    select store_name, currency
    from public.pos_bootstrap_config
    where store_id = p_store_id
    limit 1
  ),

  kpi as (
    select
      coalesce(sum(total), 0)                                        as revenue,
      count(*)                                                       as order_count,
      coalesce(sum(discount_amount), 0)                              as discount_amount,
      coalesce(sum(case when is_online then total else 0 end), 0)    as online_revenue,
      coalesce(sum(case when not is_online then total else 0 end), 0) as offline_revenue,
      coalesce(sum(sold_qty), 0)                                     as sold_qty,
      coalesce(sum(void_qty), 0)                                     as void_qty,
      coalesce(sum(void_amount), 0)                                  as void_amount
    from o
  ),

  -- 每日趨勢（零填充：範圍內冇單嘅日子照出 0，方便手機畫折線圖）
  days as (
    select generate_series(v_from::timestamp, v_to::timestamp, interval '1 day')::date as d
  ),
  daily_src as (
    select
      biz_date,
      count(*)                                     as c,
      sum(total)                                   as rev,
      sum(case when is_online then total else 0 end) as onl,
      sum(discount_amount)                         as disc,
      sum(sold_qty)                                as sq,
      sum(void_qty)                                as vq
    from o
    group by biz_date
  ),
  daily as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'bizDate',        to_char(d.d, 'YYYY-MM-DD'),
             'orderCount',     coalesce(s.c, 0),
             'revenue',        round(coalesce(s.rev, 0), 2),
             'onlineRevenue',  round(coalesce(s.onl, 0), 2),
             'discountAmount', round(coalesce(s.disc, 0), 2),
             'soldQty',        coalesce(s.sq, 0),
             'voidQty',        coalesce(s.vq, 0),
             'avgTicket',      round(coalesce(s.rev, 0) / nullif(s.c, 0), 2)
           ) order by d.d), '[]'::jsonb) as j
    from days d
    left join daily_src s on s.biz_date = d.d
  ),

  -- 尖峰時段（24 格零填充）
  hourly_src as (
    select order_hour, count(*) as c, sum(total) as rev
    from o
    group by order_hour
  ),
  hourly as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'hour',       g.h,
             'orderCount', coalesce(s.c, 0),
             'revenue',    round(coalesce(s.rev, 0), 2)
           ) order by g.h), '[]'::jsonb) as j
    from generate_series(0, 23) as g(h)
    left join hourly_src s on s.order_hour = g.h
  ),

  -- 菜品銷售排行（前端排法：offlineQty + onlineQty 降序；退菜唔計）
  dishes as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'menuItemId', i.menu_item_id,
             'name',       i.item_name,
             'totalQty',   i.total_qty,
             'offlineQty', i.offline_qty,
             'onlineQty',  i.online_qty,
             'revenue',    round(i.revenue, 2),
             'channel',    i.channel
           )), '[]'::jsonb) as j
    from (
      select
        menu_item_id,
        max(item_name)                                        as item_name,
        sum(quantity)                                         as total_qty,
        sum(case when is_online then quantity else 0 end)     as online_qty,
        sum(case when not is_online then quantity else 0 end) as offline_qty,
        sum(line_amount)                                      as revenue,
        case
          when sum(case when is_online then quantity else 0 end) > 0
           and sum(case when not is_online then quantity else 0 end) > 0 then 'mix'
          when sum(case when is_online then quantity else 0 end) > 0     then 'online'
          else 'offline'
        end                                                   as channel
      from report_ro.v_pos_order_items
      where store_id = p_store_id
        and is_closed
        and not is_voided
        and biz_date between v_from and v_to
      group by menu_item_id
      order by sum(quantity) desc
      limit v_top_n
    ) i
  ),

  -- 桌台排行（前端排法：單數降序；covers 視 0017 有冇跑而定）
  table_rank as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tableId',    t.table_id,
             'name',       t.table_name,
             'orderCount', t.order_count,
             'revenue',    round(t.revenue, 2),
             'covers',     null
           )), '[]'::jsonb) as j
    from (
      select
        table_id,
        max(table_name) as table_name,
        count(*)        as order_count,
        sum(total)      as revenue
      from o
      group by table_id
      order by count(*) desc
      limit v_top_n
    ) t
  ),

  -- 出餐時間：前端 servingMinutes() 嘅還原
  --   measured = sent_to_kitchen_at + served_at 都有（實測）
  --   fallback = 缺時間戳時用 落單→結帳 估算（DB 冇 original_settled_at，退到 updated_at）
  --   p95 用前端同一個離散索引：sorted[ ceil(0.95*n) - 1 ]（0-based）＝ arr[ ceil(0.95*n) ]（1-based）
  --   中位數用 percentile_cont(0.5)，同前端 medianOf()（雙數取中間兩條平均）一致
  serv_src as (
    select
      coalesce(serving_minutes_measured, serving_minutes_fallback) as m,
      (serving_minutes_measured is null)                           as est
    from o
  ),
  serv_agg as (
    select
      count(*)::int                                                    as n,
      avg(m)                                                           as avg_min,
      percentile_cont(0.5) within group (order by m::double precision) as med_min,
      array_agg(m order by m)                                          as arr,
      coalesce(bool_or(est), false)                                    as est
    from serv_src
  ),
  serv as (
    select
      n, avg_min, med_min, est,
      arr[least(n, greatest(1, ceil(0.95 * n)::int))] as p95_min
    from serv_agg
  ),

  -- 前 7 日基線（用嚟跑「跌超過 20%」「線上佔比上升」兩條建議規則）
  baseline as (
    select
      coalesce(sum(total), 0) / 7.0                                     as daily_revenue_avg,
      case when coalesce(sum(total), 0) > 0
           then coalesce(sum(case when is_online then total else 0 end), 0) / sum(total)
      end                                                               as online_share_7d
    from report_ro.v_pos_orders
    where store_id = p_store_id
      and is_closed
      and biz_date between (v_from - 7) and (v_from - 1)
  ),

  -- 低庫存預警（即時快照，唔受日期範圍影響）
  lowstock as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'productId',   p.product_id,
             'name',        p.name,
             'category',    p.category,
             'unit',        coalesce(p.unit, ''),
             'currentQty',  p.current_qty,
             'reorderLevel', p.reorder_level,
             'shortfall',   p.shortfall
           )), '[]'::jsonb) as j
    from (
      select *
      from report_ro.v_inv_low_stock
      where store_id = p_store_id
      order by shortfall desc, name
      limit v_top_n
    ) p
  )

  select jsonb_build_object(
    'meta', jsonb_build_object(
      'schemaVersion', k_version,
      'industry', 'restaurant',
      'storeId', p_store_id,
      'storeName', (select store_name from store),
      'currency', coalesce((select currency from store), 'MOP'),
      'timezone', k_tz,
      'range', jsonb_build_object(
        'from', to_char(v_from, 'YYYY-MM-DD'),
        'to',   to_char(v_to,   'YYYY-MM-DD'),
        'days', v_days
      ),
      'requestedRange', jsonb_build_object(
        'from', to_char(v_from_req, 'YYYY-MM-DD'),
        'to',   to_char(v_to_req,   'YYYY-MM-DD')
      ),
      'clamped', v_clamped,
      'maxDays', v_max_days,
      'topN', v_top_n,
      'generatedAt', to_char(timezone(k_tz, now()), 'YYYY-MM-DD"T"HH24:MI:SS+08'),
      'source', 'report_ro.build_full_report v' || k_version,
      'gaps', v_gaps,
      'unavailableSuggestionRules', k_unavail_rules
    ),

    'kpi', jsonb_build_object(
      'revenue',        round(k.revenue, 2),
      'orderCount',     k.order_count,
      'avgTicket',      round(k.revenue / nullif(k.order_count, 0), 2),
      'covers',         null,                       -- 下面按 0017 有冇跑再補
      'discountAmount', round(k.discount_amount, 2),
      'discountRatio',  round(k.discount_amount / nullif(k.revenue, 0), 4),
      'onlineRevenue',  round(k.online_revenue, 2),
      'offlineRevenue', round(k.offline_revenue, 2),
      'onlineShare',    round(k.online_revenue / nullif(k.revenue, 0), 4),
      'soldQty',        k.sold_qty,
      'voidQty',        k.void_qty,
      'voidAmount',     round(k.void_amount, 2),
      'voidRate',       round(k.void_qty / nullif(k.sold_qty, 0), 4)
    ),

    'daily',       d.j,
    'hourly',      h.j,
    'dishes',      di.j,
    'tables',      ta.j,
    'lowStock',    ls.j,

    'serving', jsonb_build_object(
      'sampleCount',   sv.n,
      'measuredCount', (select count(*) from o where serving_minutes_measured is not null),
      'estimated',     sv.est,
      'avgMin',        round(coalesce(sv.avg_min, 0), 1),
      'medianMin',     round(coalesce(sv.med_min, 0)::numeric, 1),
      'p95Min',        round(coalesce(sv.p95_min, 0), 1),
      'p95Warn',       coalesce(sv.p95_min, 0) > 15
    ),

    'baselines', jsonb_build_object(
      'baselineFrom',      to_char(v_from - 7, 'YYYY-MM-DD'),
      'baselineTo',        to_char(v_from - 1, 'YYYY-MM-DD'),
      'dailyRevenueAvg7d', round(coalesce(b.daily_revenue_avg, 0), 2),
      'onlineShare7d',     round(coalesce(b.online_share_7d, 0), 4)
    ),

    'suggestions', '[]'::jsonb   -- 下面 plpgsql 逐條砌
  )
  into v_result
  from kpi k, baseline b, daily d, hourly h, dishes di, table_rank ta, serv sv, lowstock ls;

  -- ── 2. 覆蓋人數（covers）：只喺 pos_orders.party_size 存在時先補 ─────────
  -- 用 dynamic SQL，因為欄位唔存在時靜態 SQL 會直接 plan 失敗。
  if v_has_ps then
    execute $q$
      select coalesce(sum(party_size), 0)::bigint
      from public.pos_orders
      where store_id = $1
        and status in ('settled', 'partially_refunded', 'refunded')
        and timezone('Asia/Macau', coalesce(updated_at, created_at))::date between $2 and $3
    $q$
    into v_covers
    using p_store_id, v_from, v_to;

    v_result := jsonb_set(v_result, '{kpi,covers}', to_jsonb(coalesce(v_covers, 0)), true);

    -- 逐枱 covers：merge 返入 tables 陣列（用 tableId 對照），
    -- 避免喺兩個地方各寫一次 table row 嘅砌法。
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'tableId', table_id,
               'covers',  covers
             )), '[]'::jsonb)
      from (
        select table_id, sum(coalesce(party_size, 0))::bigint as covers
        from public.pos_orders
        where store_id = $1
          and status in ('settled', 'partially_refunded', 'refunded')
          and timezone('Asia/Macau', coalesce(updated_at, created_at))::date between $2 and $3
        group by table_id
      ) s
    $q$
    into v_tbl_covers
    using p_store_id, v_from, v_to;

    v_result := jsonb_set(
      v_result,
      '{tables}',
      coalesce((
        select jsonb_agg(tbl || coalesce(cv, '{}'::jsonb)
                         order by (tbl ->> 'orderCount')::int desc)
        from jsonb_array_elements(v_result -> 'tables') as tbl
        left join jsonb_array_elements(v_tbl_covers) as cv
          on cv ->> 'tableId' = tbl ->> 'tableId'
      ), '[]'::jsonb),
      true
    );
  end if;

  -- ── 3. 自動化優化建議（淨係計 DB 計到嗰幾條）───────────────────────────
  -- 前端係「本期總營業額 vs 前 7 日日均」；Range 可以係多日，呢度統一改成
  -- 「本期日均 vs 前 7 日日均」。單日範圍時兩者完全等價。
  v_revenue        := coalesce((v_result #>> '{kpi,revenue}')::numeric, 0);
  v_online_share   := coalesce((v_result #>> '{kpi,onlineShare}')::numeric, 0);
  v_disc_ratio     := coalesce((v_result #>> '{kpi,discountRatio}')::numeric, 0);
  v_void_rate      := coalesce((v_result #>> '{kpi,voidRate}')::numeric, 0);
  v_daily_rev_avg  := v_revenue / nullif(v_days, 0);
  v_base_rev_avg   := coalesce((v_result #>> '{baselines,dailyRevenueAvg7d}')::numeric, 0);
  v_base_onl_share := coalesce((v_result #>> '{baselines,onlineShare7d}')::numeric, 0);

  -- r · 營業額較前 7 日日均跌超過 20%
  if v_base_rev_avg > 0 and v_daily_rev_avg < v_base_rev_avg * 0.8 then
    v_sugg := v_sugg || jsonb_build_array(jsonb_build_object(
      'level',  'r',
      'title',  '營業額較前 7 日日均跌超過 20%',
      'action', '推限時優惠或喚醒沉睡會員，拉升淡日營收。'
    ));
  end if;

  -- o · 線上渠道佔比上升超過 5 個百分點
  if v_online_share - v_base_onl_share > 0.05 then
    v_sugg := v_sugg || jsonb_build_array(jsonb_build_object(
      'level',  'o',
      'title',  format('線上渠道佔比上升（%s%%，前 7 日 %s%%）',
                       round(v_online_share * 100), round(v_base_onl_share * 100)),
      'action', '加強線上推廣，並確保廚房產能跟到外送單。'
    ));
  end if;

  -- o · 退菜率高於 3%
  if v_void_rate > 0.03 then
    v_sugg := v_sugg || jsonb_build_array(jsonb_build_object(
      'level',  'o',
      'title',  format('退菜率 %s%%（高於 3%% 閾值）', round(v_void_rate * 100)),
      'action', '檢視退菜原因，加強落單確認與出餐品質培訓。'
    ));
  end if;

  -- o · 折扣佔比高於 15%
  if v_disc_ratio > 0.15 then
    v_sugg := v_sugg || jsonb_build_array(jsonb_build_object(
      'level',  'o',
      'title',  format('折扣佔比 %s%%（高於 15%% 閾值）', round(v_disc_ratio * 100)),
      'action', '檢討優惠門檻，避免無謂折讓蠶食毛利。'
    ));
  end if;

  -- i · 使用偏低嘅枱（排行榜最後一張）
  if jsonb_array_length(v_result -> 'tables') > 0 then
    v_sugg := v_sugg || jsonb_build_array(jsonb_build_object(
      'level',  'i',
      'title',  format('「%s」使用偏低（%s 單）',
                       v_result #>> array['tables', (jsonb_array_length(v_result -> 'tables') - 1)::text, 'name'],
                       v_result #>> array['tables', (jsonb_array_length(v_result -> 'tables') - 1)::text, 'orderCount']),
      'action', '檢視該區擺位／排枱，必要時重新規劃或併枱。'
    ));
  end if;

  -- 同前端一樣排序：立即(r) → 關注(o) → 資訊(i)
  select coalesce(jsonb_agg(x order by case x ->> 'level'
                                        when 'r' then 0
                                        when 'o' then 1
                                        else 2 end), '[]'::jsonb)
  into v_sugg_sorted
  from jsonb_array_elements(v_sugg) x;

  v_result := jsonb_set(v_result, '{suggestions}', coalesce(v_sugg_sorted, '[]'::jsonb), true);

  return v_result;
end;
$$;

comment on function report_ro.build_full_report(text, date, date, int, int) is
  'Ledger 報表一次性 API（docs/94）：一次 call 攞到餐飲報表全部可得內容（jsonb）。'
  '只讀・security invoker・範圍硬上限 90 日（超出自動截斷並標 meta.clamped）。'
  '口徑全部由 report_ro.* View 砌出嚟，同前端 /reports 一致。'
  'covers 需要 migration 0017（pos_orders.party_size），未跑則回傳 null 並列喺 meta.gaps。';


-- ═══════════════════════════════════════════════════════════════════════════
-- Part B · 授權（View 嘅 default privileges 唔包 function，要顯式 grant）
-- ═══════════════════════════════════════════════════════════════════════════

grant execute on function report_ro.build_full_report(text, date, date, int, int)
  to ledger_report_ro;

-- 日後喺 report_ro 新增 function 自動授權
alter default privileges in schema report_ro
  grant execute on functions to ledger_report_ro;


-- ═══════════════════════════════════════════════════════════════════════════
-- Part C · 驗收（用 ledger_report_ro 連線執行）
-- ═══════════════════════════════════════════════════════════════════════════

-- C1. 今日全份報表
--   select jsonb_pretty(report_ro.build_full_report('macau-store-a'));
--   預期：一個 JSON，meta.schemaVersion = '1.0'，kpi / daily / dishes / tables /
--         hourly / serving / lowStock / baselines / suggestions 九個 key 齊晒。

-- C2. 指定區間（30 日）
--   select report_ro.build_full_report('macau-store-a', '2026-08-01', '2026-08-30');
--   預期：meta.range.days = 30，meta.clamped = false。

-- C3. 超出上限要有截斷提示（重要：唔可以靜默俾錯範圍）
--   select report_ro.build_full_report('macau-store-a', '2020-01-01', '2026-09-01');
--   預期：meta.clamped = true，meta.range.from = 2026-09-01 倒推 89 日，
--         meta.requestedRange.from = '2020-01-01'。

-- C4. 確認仍然寫唔到（必須報錯）
--   select report_ro.build_full_report('macau-store-a') -> 'x';
--   （呢條本身會成功，用嚟對照；真正要試嘅係 83 號 Part C3 嗰四條 DML）

-- C5. 確認冇偷到未授權表（function 係 security invoker，同連線角色一樣權限）
--   select count(*) from public.salon_customers;
--   預期：ERROR: permission denied for table salon_customers

-- C6. covers 有冇值（視 0017 有冇跑）
--   select report_ro.build_full_report('macau-store-a') #>> '{kpi,covers}';
--   預期：數字（0017 已跑）或 null（未跑，同時 meta.gaps 會多一項 'covers'）

-- C7. 對數：同一日同一間店，function 嘅 kpi.revenue 要等於
--   select round(sum(total), 2) from report_ro.v_pos_daily_summary
--   where store_id = 'macau-store-a' and biz_date = current_date;
--   （前端報表「今日」篩選都應該係同一個數）


-- ═══════════════════════════════════════════════════════════════════════════
-- Part D · 可選：90 日查詢慢先加嘅 index
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 背景：視圖 report_ro.v_pos_orders 嘅 biz_date 用
--         (coalesce(updated_at, created_at) at time zone 'Asia/Macau')::date
--       而 migration 0017 建嘅 index 用
--         timezone('Asia/Macau', coalesce(updated_at, created_at))::date
--       兩者語義一樣但 textual 唔同，PG 唔會當同一個 expression → 0017 嗰個
--       index 對呢個 function **幫唔到手**。目前靠 pos_orders_store_idx（store_id）
--       先過濾門店再算 biz_date，細店資料量足以應付。
--
-- 如果 90 日區間查詢慢（statement_timeout 30s 頂唔順），先試下面呢個：
--
--   create index if not exists pos_orders_store_bizdate_atz_idx
--     on public.pos_orders (store_id,
--         ((coalesce(updated_at, created_at) at time zone 'Asia/Macau')::date));
--
-- ⚠️ 若報 "functions in index expression must be marked IMMUTABLE"，改用
--    timezone() 寫法（同 0017），並同步改 83 號 SQL 入面 v_pos_orders /
--    v_pos_order_items 嘅 biz_date / order_date 定義，等兩邊 expression 一致：
--
--   create index if not exists pos_orders_store_bizdate_tz_idx
--     on public.pos_orders (store_id,
--         (timezone('Asia/Macau', coalesce(updated_at, created_at))::date));


-- ═══════════════════════════════════════════════════════════════════════════
-- 撤銷 / 升級
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 停用（保留定義）：
--   revoke execute on function report_ro.build_full_report(text, date, date, int, int)
--     from ledger_report_ro;
--
-- 完全移除：
--   drop function if exists report_ro.build_full_report(text, date, date, int, int);
--
-- 升級（改邏輯）：
--   成段 Part A 重新貼一次就得（create or replace）。
--   ⚠️ 改動影響輸出格式時，記得同步 meta.schemaVersion 同 docs/94 §3 嘅 payload 表，
--      並事先通知 Ledger —— 佢哋手機端係照住 schemaVersion 解 JSON 嘅。
-- =============================================================================
