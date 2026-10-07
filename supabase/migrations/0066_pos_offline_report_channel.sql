-- 0066 · 報表加「渠道」維度（**方案 A：舊欄位還原 ＋ 線上另開新 key**）
-- =============================================================================
-- 契約：docs/integration/pos-offline-report-api.md（v1）
--       ＋ docs/integration/pos-offline-report-v1-addendum-2026-09-26.md
--       ＋ docs/integration/pos-offline-report-channel-addendum-2026-10-07.md（本檔對應）
-- 前身：0060_pos_offline_report_dishes_by_revenue.sql（**已上線**；本檔 create or replace 同一簽名）
-- 方案書：docs/154-ledger-offline-report-online-channel.md
--
-- 【為咩係新 migration 而唔係改 0060】
--   0060 已經喺 production 跑過。改檔唔會令已 apply 嘅環境重新執行
--   ⇒ 必須新開一支，用 `create or replace function` 覆蓋同一個簽名。
--   ⚠️ 簽名 `(text, date, date)` **完全不變** ⇒ grants 保留（下面照樣再 revoke/grant 雙保險）。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 【🔴🔴🔴 本 migration 最緊要嘅一條：舊欄位一個數字都唔可以變（方案 A）】
-- ═══════════════════════════════════════════════════════════════════════════
--   J 2026-10-07 22:30 拍板：「不能變」＝ **JSON 數據架構唔可以改**。
--   Ledger 已經照 `v:1` 現有架構砌好咗 UI ⇒ 任何欄位名／型別／層級／**數值**改動都會令佢哋壞。
--
--   ⚠️⚠️ **呢條鐵律要守三樣，唔係一樣**：
--      ① 欄位名　② 型別／層級　③ **數值**
--      只守 ①② 會漏掉「加咗欄位但順手改咗舊欄口徑」呢類最常見嘅違規 ——
--      2026-10-07 就係咁出事：舊 code 收到新 SQL 嘅 payload **唔會 503**（照送 200），
--      但 `dishes[].qty` 會由「淨線下」吸水變成「全渠道」、`orders[]` 由 74 張變 93 張
--      ⇒ Ledger 張已對數嘅卡即刻跳數。
--      ⚠️ 早期版本呢度寫死「42 變 54」—— **42／54 係虛構**，全店根本冇 qty=42 嘅菜。
--         數值只可作示意，**唔可以**當驗收基線（見檔尾 §教訓）。
--      （呢組 42/54/75/84000/108000 係當時寫落註解嘅**虛構值**，2026-10-07 產勘已證實
--        全店冇任何一行 qty === 42 或 revenueAvos === 84,000／108,000。真相係
--        `orders[]` 74 → 93；舊 dishes[] 淨額 → 全渠道。教訓見檔尾。）
--
--   【v1 口徑嘅真相：線下 ≠ 淨線下】
--      `kpi` 五欄嘅口徑係 `online_order_id is null`，而**外賣平台單冇 `online_order_id`**
--      （佢有 `external_order_id` + `source`）⇒ **平台單一直被包埋喺「線下」入面**。
--      實測 90 日（主店）：v1 `kpi` = 74 張 / MOP 5,471（線下 66 ＋ 平台 8）；
--      v1 `orders[]` = 74 張 / MOP 5,471（`orders[]` **會剔 `cancelled`**，所以嗰張 65 平台單唔喺入面）。
--      🔴 呢個檔案舊版曾寫「75 張 / MOP 5,536（包埋 1 張 cancelled 平台單）」—— 錯，
--         `orders[]` 嘅 `coalesce(btrim(o.status),'') <> 'cancelled'` 一直都有，
--         cancelled 單從來冇入過 `orders[]`。生產重算：74 張 / 547,100。
--      而 Ledger 自己嘅 `public.orders` 已經有平台單 ⇒ 佢哋今日重複計算緊嗰 699。
--
--   ⇒ 所以 **`kpi` 五欄、`byPayment`、`refunded`、`orders[]`、`dishes[]`
--      五段 SQL 全部同 0060 逐字相同**（`orders[]` 只係多咗一個 additive 嘅 `channel` 欄）。
--      絕對唔可以「順手修正」成 4,772：改咗佢張已對數嘅卡即刻跳數。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 【渠道判定：單一真源、三路 CASE】
-- ═══════════════════════════════════════════════════════════════════════════
--   case
--     when o.source in ('aomi', 'mfood')  then 'online_platform'   -- Grabber 推入
--     when o.online_order_id is not null  then 'online_projection' -- 掃碼／排位／快餐採納
--     else 'offline'
--   end
--
--   🔴 **唔可以用 `online_order_id is null` 當線下**（會漏平台單）
--   🔴 **唔可以淨係靠 `source`**（會將掃碼單當線下）
--   ⚠️ 順序有意義：`source` 判定放前面，因為平台單一定冇 `online_order_id`。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 【輸出 key 清單（舊 14 個逐字保留 ＋ 6 個新 key）】
-- ═══════════════════════════════════════════════════════════════════════════
--   ── 舊（0060 逐字，數值一個都唔改）──
--   found / from / to / clamped
--   orderCount / revenueAvos / refundedAvos / discountAvos / covers     ← v1 五欄
--   byPayment                                                            ← v1
--   ordersTotal / orders        = 74 張（`online_order_id is null`），每列 **＋channel**（additive）
--   dishesTotal / dishes        = 58 款（`online_order_id is null`），三欄原樣、**無拆欄**、金額倒序
--                                    ⚠️ 呢個 base ＝ offline **＋ online_platform**（平台單冇 online_order_id），
--                                       所以佢**唔會**同 `dishesByChannel[].offline*` 逐行相等（見檔尾說明）
--
--   ── 🆕 新（0066 方案 A：線上數據全部喺呢度）──
--   ① kpiByChannel            = {offline, online, onlinePlatform} 各 5 欄（全渠道精確拆分）
--   ② paymentBreakdown        = [{method,label,channel,orderCount,receivableAvos,paidAvos,diffAvos}]
--   ③ ordersByChannelTotal / ordersByChannel
--                              = **全渠道** 93 張，同 `orders[]` 每列三欄 ＋ channel
--                                （線上投影單淨係喺呢度出現；`orders[]` 永遠冇佢哋）
--   ④ dishesByChannelTotal / dishesByChannel
--                              = **全渠道** 63 款，同 `dishes[]` 每列 **＋ 四個拆欄**
--                                （offlineQty/offlineRevenueAvos/onlineQty/onlineRevenueAvos，
--                                  `qty`/`revenueAvos` = 總數）
--
--   🔴 ①②③④ 六個 key 要麼全有、要麼全無（route 用嚟降級；部分缺＝SQL 有 bug ⇒ 503）
--   ⚠️ **唔可以**因為 `dishes[]` 還原咗就喺佢上面加拆欄 ——
--      加拆欄而唔移除 `online_order_id is null` 過濾，`offlineQty` 會永遠等於 `qty`、
--      `onlineQty` 永遠 0 ⇒ 兩欄都係假資料，比唔加更壞。所以拆欄只喺新 key。
--
-- 【dishesByChannel[] 拆欄點解唔係「加兩節」】
--   Ledger 想要嘅係「同一款菜，線上／線下各幾多」，唔係兩張獨立榜單
--   ⇒ 內層 group by (dkey, channel)，外層 merge 成一行。
--   ⚠️ merge 後 `qty` = 線下 + 線上（總數）⇒ 舊 Ledger 根本唔讀呢個 key，唔影響佢。
--
-- 【paymentBreakdown 嘅翻譯層】
--   必須同 `src/lib/pos/payment-method-label.ts` 嘅 `posPaymentMethodLabel()` 逐字對齊
--   （SQL 冇 import 佢 ⇒ 雙份維護 ⇒ 守衛測試逐 key 對照，見 guard 第 10 條）。
--   🔴 `else` 分支必須原樣返回 store 自訂名（「Mpay」「中銀」…）—— 唔可以加 `cash`
--      類映射，store 可能自己叫「現金」，撞名會被改寫。
--
-- 【其他所有口徑保持不變】
--   · `stable`、`security invoker`、只 `grant service_role`、唔包 transaction。
--   · 90 日 clamp、`count(*) over ()` 喺 `LIMIT` 之前、上限 3000／300。
--   · 日歸屬四條時間腿 + Asia/Macau。
--   · `orders[]` 仍只剔除 `cancelled`（未結帳單照出）。
--   · `dishes[]` 仍只計 `settled`／`paid`、排除 `voided`。
--   · `dishes[]` 仍係**金額倒序**（0060 定案，唔准改返銷量倒序）。
--   · 唔回任何自由文字／顧客個資（`order_note` / item `note` / `raw_json` …）。
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
  k_max_label_len   constant int  := 32;    -- label 同 method 一樣要截（Ledger 兩邊都食 32）

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
  v_kpi_channel jsonb;
  v_pay_breakdown jsonb;
  v_orders_total bigint;
  v_orders      jsonb;
  v_dishes_total bigint;
  v_dishes      jsonb;
  v_orders_ch_total bigint;
  v_orders_ch   jsonb;
  v_dishes_ch_total bigint;
  v_dishes_ch   jsonb;
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

  -- ═════════════════════════════════════════════════════════════════════════
  -- KPI（v1 口徑）—— 🔴 邏輯同 0060 **逐字相同**，一個數字都唔可以變
  -- ═════════════════════════════════════════════════════════════════════════
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

  -- ═════════════════════════════════════════════════════════════════════════
  -- 支付方式 byPayment（v1 口徑）—— 🔴 邏輯同 0060 **逐字相同**
  --    ⚠️ 唔好「修正」成淨線下：bar 上嘅「外賣平台」條會突然消失。
  --       要分渠道睇 → 讀新 key `paymentBreakdown`。
  -- ═════════════════════════════════════════════════════════════════════════
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

  -- ── 退款總額（揭露值）—— 🔴 同 0060 逐字相同（v1 口徑）──
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

  -- ═════════════════════════════════════════════════════════════════════════
  -- orders[]：🔴 **0060 口徑逐字還原**（`online_order_id is null`）＋ additive `channel`
  --
  -- ⚠️ 0066 第一版曾經移除 `online_order_id is null`（送全渠道 93 張）
  --    ⇒ `orders.length` 由 74 變 93，舊 Ledger 張卡即刻跳數。已還原。
  --
  -- 狀態口徑不變：只剔除 `cancelled`（未結帳 draft／sent_to_kitchen／reopened 照出）。
  -- 🔴 三個舊欄位（orderNo／totalAvos／status）嘅**值**同 0060 逐位相同
  --    （`totalAvos` 仍然喺 `jsonb_build_object` 入面計，唔係喺 base CTE 提前計 —
  --    咁樣就唔會有「中間欄位加咗 greatest(0,…)」嗰種隱形口徑漂移）。
-- 🔴 `channel` 係**新增欄位**（舊 Ledger 唔讀就忽略）⇒ 純 additive。
--    ⚠️ 因為 `online_order_id is null`，呢度**永遠唔會出現** `online_projection`：
--       掃碼／排位單被呢個過濾排除咗。線上投影單淨係喺 `ordersByChannel[]` 出現。
--       `channel` 喺呢度嘅作用係分辨「店內落單」vs「Grabber 推入」—— 對 Ledger 有用
--       （佢需要知道邊啀單已經喺佢自己 DB 有一份）。
--
  --    `count(*) over ()` 喺 LIMIT 之前計算 ⇒ 一次掃描就同時拎到「總數」同「首 N 筆」。
  -- ═════════════════════════════════════════════════════════════════════════
  with base as (
    select
      left(o.local_order_no, k_max_orderno_len) as order_no,
      coalesce(nullif(btrim(o.status), ''), 'unknown') as status,
      o.total,
      case
        when o.source in ('aomi', 'mfood') then 'online_platform'
        when o.online_order_id is not null then 'online_projection'
        else 'offline'
      end as channel,
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
          'status',    left(p.status, k_max_status_len),
          'channel',   p.channel
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

  -- ═════════════════════════════════════════════════════════════════════════
  -- dishes[]：🔴 **0060 口徑逐字還原**（`online_order_id is null`、三欄原樣、金額倒序）
  --
  -- ⚠️ 0066 第一版曾經移除 `online_order_id is null` 並加四個拆欄
  --    ⇒ `qty` 變成全渠道總數、`revenueAvos` 亦然。已還原。
  --    （舊註解寫「42 → 54 / 84000 → 108000」係虛構值，見檔頭。）
  --
  -- 聚合 key 依然係 `menuItemId|名稱`（**下單當時快照**，唔對應當前餐牌）
  -- ⇒ 改咗名／改咗價嘅菜各自一行，歷史唔會因改名而「失蹤」。
  -- ⚠️ 兩處 ORDER BY 必須一致（jsonb_agg 決定陣列次序；子查詢＋limit 決定保留邊 300 款）。
  -- ═════════════════════════════════════════════════════════════════════════
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
        -- 🔴 金額倒序（0060 定案，唔准改返銷量倒序）；並列時按名稱升序保持穩定。
        order by r.revenue_avos desc, r.dname asc
      ),
      '[]'::jsonb
    )
  into v_dishes_total, v_dishes
  from (
    select a.*, count(*) over () as total_rows
    from agg a
    -- 🔴 金額倒序（0060 定案）—— 同上面 jsonb_agg 必須一致。
    order by a.revenue_avos desc, a.dname asc
    limit k_max_dishes
  ) r;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 🆕 kpiByChannel：精確拆分（舊 kpi 唔改，呢個先係準數）
  --
  -- 🔴 三段都係**全渠道**（已移除 `online_order_id is null`），所以：
  --      offline(66) + online(19) + onlinePlatform(8) = 93 張，大過舊 kpi 嘅 74 張
  --      （舊 kpi 包埋平台 8、排除線上投影 19）
  --    `refundedAvos` 分母亦都係各渠道自己嘅退款單。
  -- ═════════════════════════════════════════════════════════════════════════
  with base as (
    select
      case
        when o.source in ('aomi', 'mfood') then 'online_platform'
        when o.online_order_id is not null then 'online_projection'
        else 'offline'
      end as channel,
      -- 🔴🔴 `status` **必須**喺 select list：下面 `sale`／`ref` 兩個 CTE 都要
      --     `where status in (...)`。漏咗就係 42703「column status does not exist」，
      --     而且 `create or replace function` **唔會**報（只驗語法、唔驗欄位）
      --     ⇒ 要到**執行**先爆。2026-10-08 生產事故就係咁。
      o.status,
      o.total, o.discount_amount, o.table_id, o.party_size,
      o.refunded_amount, o.refund_records
    from public.pos_orders o
    where o.store_id = p_store_id
      and (coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at) at time zone k_tz)::date
            between v_from and v_to
      and o.status in ('settled', 'paid', 'refunded', 'partially_refunded')
  ),
  sale as (
    select channel, count(*) as n,
           coalesce(sum(round(coalesce(total, 0) * 100))::bigint, 0) as rev,
           coalesce(sum(round(coalesce(discount_amount, 0) * 100))::bigint, 0) as disc,
           coalesce(sum(case when table_id = 'counter' then 1 else greatest(1, coalesce(party_size, 1)) end)::bigint, 0) as cov
    from base
    where status in ('settled', 'paid')
    group by 1
  ),
  ref as (
    select channel,
           coalesce(sum(amount), 0) as amount
    from (
      select channel,
             greatest(
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
      where status in ('refunded', 'partially_refunded')
    ) x
    group by 1
  )
  select jsonb_build_object(
    'offline', jsonb_build_object(
      'orderCount',    coalesce((select n    from sale where channel = 'offline'), 0),
      'revenueAvos',   coalesce((select rev  from sale where channel = 'offline'), 0),
      'refundedAvos',  coalesce((select amount from ref where channel = 'offline'), 0),
      'discountAvos',  coalesce((select disc from sale where channel = 'offline'), 0),
      'covers',        coalesce((select cov  from sale where channel = 'offline'), 0)
    ),
    'online', jsonb_build_object(
      'orderCount',    coalesce((select n    from sale where channel = 'online_projection'), 0),
      'revenueAvos',   coalesce((select rev  from sale where channel = 'online_projection'), 0),
      'refundedAvos',  coalesce((select amount from ref where channel = 'online_projection'), 0),
      'discountAvos',  coalesce((select disc from sale where channel = 'online_projection'), 0),
      'covers',        coalesce((select cov  from sale where channel = 'online_projection'), 0)
    ),
    'onlinePlatform', jsonb_build_object(
      'orderCount',    coalesce((select n    from sale where channel = 'online_platform'), 0),
      'revenueAvos',   coalesce((select rev  from sale where channel = 'online_platform'), 0),
      'refundedAvos',  coalesce((select amount from ref where channel = 'online_platform'), 0),
      'discountAvos',  coalesce((select disc from sale where channel = 'online_platform'), 0),
      'covers',        coalesce((select cov  from sale where channel = 'online_platform'), 0)
    )
  )
  into v_kpi_channel;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 🆕 paymentBreakdown：全渠道支付方式分項（同 POS「支付方式分項」卡）
  --
  -- 欄位：method（raw，截 32）／label（翻譯後，截 32）／channel／orderCount／
  --       receivableAvos（應收）／paidAvos（實收）／diffAvos（應收 − 實收）
  --
  -- 🔴 應收口徑 ＝ Σ(item.price × qty) + 服務費 + 稅（同 POS `aggregate()` 逐字一致）
  -- 🔴 `diffAvos` **唔可以夾非負**：
  --      線下單 = 折扣（實收 ≤ 應收）；平台單 = 平台抽成（實收可能 **>** 應收）
  --      實測有 +27 嘅真資料，夾咗就變成假零。
  -- ═════════════════════════════════════════════════════════════════════════
  with base as (
    select
      case
        when o.source in ('aomi', 'mfood') then 'online_platform'
        when o.online_order_id is not null then 'online_projection'
        else 'offline'
      end as channel,
      left(coalesce(nullif(btrim(o.payment_method), ''), '未記錄'), k_max_method_len) as method,
      -- 🔴 翻譯層：必須同 src/lib/pos/payment-method-label.ts 逐字對齊
      case
        when btrim(coalesce(o.payment_method, '')) = '' then '未記錄'
        when lower(btrim(o.payment_method)) in ('in_store', 'online_in_store') then '到店付款'
        when lower(btrim(o.payment_method)) in ('balance', 'online_balance') then '餘額扣點'
        when lower(btrim(o.payment_method)) = 'member_balance' then '會員餘額'
        when lower(btrim(o.payment_method)) in ('online_paid', 'prepaid') then '線上已支付'
        else left(btrim(o.payment_method), k_max_label_len)   -- store 自訂名原樣返回
      end as label,
      o.total,
      coalesce(o.service_charge_amount, 0) + coalesce(o.tax_amount, 0) as addons,
      (
        select coalesce(sum(
                 case when (it ->> 'quantity') ~ '^-?[0-9]+(\.[0-9]+)?$' then (it ->> 'quantity')::numeric else 0 end
               * case when (it ->> 'price')    ~ '^-?[0-9]+(\.[0-9]+)?$' then (it ->> 'price')::numeric    else 0 end
               ), 0)
        from jsonb_array_elements(
          case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
        ) it
      ) as items_sum
    from public.pos_orders o
    where o.store_id = p_store_id
      and o.status in ('settled', 'paid')
      and (coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at) at time zone k_tz)::date
            between v_from and v_to
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'method',         b.method,
               'label',          left(b.label, k_max_label_len),
               'channel',        b.channel,
               'orderCount',     b.n::bigint,
               'receivableAvos', greatest(0, round(b.rec) * 100)::bigint,
               'paidAvos',       coalesce(round(b.paid) * 100, 0)::bigint,
               -- 🔴 可以負、唔夾：平台單實收可能 > 應收
               'diffAvos',       greatest(0, round(b.rec) * 100)::bigint - coalesce(round(b.paid) * 100, 0)::bigint
             )
             order by coalesce(round(b.paid) * 100, 0)::bigint desc, b.method asc, b.channel asc
           ),
           '[]'::jsonb
         )
  into v_pay_breakdown
  from (
    select channel, method, label,
           count(*) as n,
           coalesce(sum(coalesce(items_sum, 0) + coalesce(addons, 0)), 0) as rec,
           coalesce(sum(coalesce(total, 0)), 0) as paid
    from base
    group by 1, 2, 3
  ) b;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 🆕 ordersByChannel[]：**全渠道**訂單明細（93 張）＋ 每列 channel
  --
  -- 點解唔直接擴 `orders[]`：`orders[]` 一擴就由 74 變 93 ⇒ 舊 Ledger 張卡跳數（方案 A 禁止）。
--   （74 ＝ 非 cancelled 且 `online_order_id is null`；平臺單冇 online_order_id 所以包埋。）
  -- ⇒ 全渠道另開新 key。`orders[]` 嘅三個舊欄位 ＋ 74 張，一個數字都唔郁。
  --
  -- 🔴 欄位同 `orders[]` **完全一致**（orderNo／totalAvos／status／channel）
  --    ⇒ Ledger 可以用同一個 renderer 讀兩個 key，唔使寫第二套。
  -- ⚠️ 會出現 `orders[]` 有、但 `ordersByChannel[]` 冇嘅單（線上投影 19 張）
  --    —— 呢個係設計意圖，唔係漏。
  -- ═════════════════════════════════════════════════════════════════════════
  with base as (
    select
      left(o.local_order_no, k_max_orderno_len) as order_no,
      coalesce(nullif(btrim(o.status), ''), 'unknown') as status,
      o.total,
      case
        when o.source in ('aomi', 'mfood') then 'online_platform'
        when o.online_order_id is not null then 'online_projection'
        else 'offline'
      end as channel,
      coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at) as ev
    from public.pos_orders o
    where o.store_id = p_store_id
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
          'status',    left(p.status, k_max_status_len),
          'channel',   p.channel
        )
        order by p.ev desc nulls last
      ),
      '[]'::jsonb
    )
  into v_orders_ch_total, v_orders_ch
  from (
    select b.*, count(*) over () as total_rows
    from base b
    order by b.ev desc nulls last
    limit k_max_orders
  ) p;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 🆕 dishesByChannel[]：**全渠道**菜品排名（63 款）＋ 每列四個拆欄
  --
  --   `qty` / `revenueAvos`            = 總數（線下 + 線上）
  --   `offlineQty` / `onlineQty`       = 該渠道數量
  --   `offlineRevenueAvos` / `onlineRevenueAvos` = 該渠道金額
  --   ⚠️ `online*` ＝ `online_projection` + `online_platform` 兩者加埋
  --      （分開三渠道會令 6 個欄，contract 會爆；Ledger 想要三渠道就自己由
  --        `ordersByChannel[]`／`paymentBreakdown` 嘅 `channel` 欄交叉推。）
  --
  -- 做法：內層 `group by dkey, channel` → 外層 merge 成一行。
  -- 🔴 **加埋必須等於總數**（守衛測試會驗 `offlineQty + onlineQty === qty`）。
  -- ═════════════════════════════════════════════════════════════════════════
  with base as (
    select
      coalesce(nullif(btrim(e.it ->> 'menuItemId'), ''), '') || '|' ||
        coalesce(nullif(btrim(e.it ->> 'name'), ''), '(未命名)') as dkey,
      coalesce(nullif(btrim(e.it ->> 'name'), ''), '(未命名)') as dname,
      case
        when o.source in ('aomi', 'mfood') then 'online_platform'
        when o.online_order_id is not null then 'online_projection'
        else 'offline'
      end as channel,
      case when (e.it ->> 'quantity') ~ '^-?[0-9]+(\.[0-9]+)?$' then (e.it ->> 'quantity')::numeric else 0 end as qty,
      case when (e.it ->> 'price')    ~ '^-?[0-9]+(\.[0-9]+)?$' then (e.it ->> 'price')::numeric    else 0 end as price
    from public.pos_orders o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
    ) as e(it)
    where o.store_id = p_store_id
      and o.status in ('settled', 'paid')
      and (coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at) at time zone k_tz)::date
            between v_from and v_to
      and coalesce(e.it ->> 'voided', 'false') <> 'true'
  ),
  per_channel as (
    select dkey, channel,
           -- 🔴🔴 `dname` **必須**喺呢度帶落去：下面 `agg` 用 `min(dname)` 還原菜名。
           --    漏咗就係 42703「column dname does not exist」，而且 create function 唔會報。
           min(dname) as dname,
           greatest(0, round(sum(qty))::bigint) as qty_c,
           greatest(0, round(sum(price * qty) * 100)::bigint) as rev_c
    from base
    group by dkey, channel
  ),
  agg as (
    select
      dkey,
      min(dname) as dname,
      greatest(0, round(sum(qty_c))::bigint) as qty_total,
      greatest(0, round(sum(rev_c))::bigint) as revenue_avos,
      coalesce(max(qty_c) filter (where channel = 'offline'), 0) as qty_offline,
      coalesce(max(rev_c) filter (where channel = 'offline'), 0) as rev_offline,
      coalesce(sum(qty_c) filter (where channel <> 'offline'), 0) as qty_online,
      coalesce(sum(rev_c) filter (where channel <> 'offline'), 0) as rev_online
    from per_channel
    group by dkey
  )
  select
    coalesce(max(r.total_rows), 0),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'name',        left(r.dname, k_max_name_len),
          'qty',         r.qty_total,
          'revenueAvos', r.revenue_avos,
          'offlineQty',       r.qty_offline,
          'offlineRevenueAvos', r.rev_offline,
          'onlineQty',        r.qty_online,
          'onlineRevenueAvos', r.rev_online
        )
        -- 🔴 金額倒序（0060 定案，唔准改返銷量倒序）；並列時按名稱升序保持穩定。
        order by r.revenue_avos desc, r.dname asc
      ),
      '[]'::jsonb
    )
  into v_dishes_ch_total, v_dishes_ch
  from (
    select a.*, count(*) over () as total_rows
    from agg a
    order by a.revenue_avos desc, a.dname asc
    limit k_max_dishes
  ) r;

  return jsonb_build_object(
    'found',           v_found,
    'from',            to_char(v_from, 'YYYY-MM-DD'),
    'to',              to_char(v_to, 'YYYY-MM-DD'),
    'clamped',         v_clamped,
    -- 🔴 v1 口徑五欄（線下 + 平台單）—— 0060 逐字保留，Ledger 舊 UI 靠呢五個
    'orderCount',      v_order_count,
    'revenueAvos',     v_revenue,
    'refundedAvos',    v_refunded,
    'discountAvos',    v_discount,
    'covers',          v_covers,
    'byPayment',       v_by_payment,
    'ordersTotal',     v_orders_total,
    'orders',          v_orders,
    'dishesTotal',     v_dishes_total,
    'dishes',          v_dishes,
    -- 🆕 渠道增補（0066 方案 A）：線上數據全部喺呢六個新 key
    'kpiByChannel',        v_kpi_channel,
    'paymentBreakdown',    v_pay_breakdown,
    'ordersByChannelTotal', v_orders_ch_total,
    'ordersByChannel',     v_orders_ch,
    'dishesByChannelTotal', v_dishes_ch_total,
    'dishesByChannel',     v_dishes_ch
  );
end;
$$;

comment on function public.pos_offline_report(text, date, date) is
  'Ledger 報表頁嘅聚合來源（契約 v1 ＋ 2026-09-26 增補 ＋ 2026-10-05 排序修正 ＋ 2026-10-07 渠道增補）。'
  '【v1 口徑（0060 逐字保留，勿改）】orderCount／revenueAvos／refundedAvos／discountAvos／covers／byPayment：'
  '只計 status ∈ {settled,paid}、排除 online_order_id。⚠️ 口徑**包埋外賣平台單**（佢冇 online_order_id），'
  '所以呢組數**唔可以**再同 Ledger 自己嘅線上營業額相加。'
  'orders[]：**排除 online_order_id**（即唔含線上投影單）、只剔除 cancelled，回 {orderNo,totalAvos,status,channel}，事件時間倒序、上限 3000。'
  'dishes[]：**排除 online_order_id**，只計 {settled,paid}、排除已退菜，回 {name,qty,revenueAvos} 三欄、**金額倒序**、上限 300。'
  '【2026-10-07 新增（方案 A：舊欄一個數字都冇改，線上另開新 key）】'
  'kpiByChannel = {offline,online,onlinePlatform} 各 5 欄（精確拆分，全渠道）；'
  'paymentBreakdown = [{method,label,channel,orderCount,receivableAvos,paidAvos,diffAvos}]（全渠道；'
  'diffAvos ＝ 應收−實收，線下＝折扣、平台＝平台抽成，**可以為負**）；'
  'ordersByChannel = 全渠道訂單明細（欄位同 orders[] 完全一樣，Ledger 可用同一 renderer）；'
  'dishesByChannel = 全渠道菜品排名，回 {name,qty,revenueAvos,offlineQty,offlineRevenueAvos,onlineQty,onlineRevenueAvos}，'
  'qty／revenueAvos 為**總數**、金額倒序、offlineQty+onlineQty === qty。'
  'channel 三值：offline / online_projection（online_order_id NOT NULL）/ online_platform（source ∈ aomi,mfood）。'
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
-- ① 🔴🔴🔴 舊欄位一個數字都冇變（重點係**對數**，唔係對死數字）
--   select r ->> 'orderCount' as kpi_count, r ->> 'revenueAvos' as kpi_rev,
--          r ->> 'ordersTotal' as orders_total, r ->> 'dishesTotal' as dishes_total,
--          (select coalesce(sum((d ->> 'qty')::bigint), 0)
--             from jsonb_array_elements(r -> 'dishes') d) as dishes_qty,
--          (select coalesce(sum((d ->> 'revenueAvos')::bigint), 0)
--             from jsonb_array_elements(r -> 'dishes') d) as dishes_rev,
--          (select coalesce(sum((b ->> 'amountAvos')::bigint), 0)
--             from jsonb_array_elements(r -> 'byPayment') b) as byPayment_sum
--   from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r;
--   → **byPayment_sum = kpi_rev ＝ 唯一要守嘅等式**（同一批單、同一口徑）。
--
--   🔴🔴 唔好再對「dishesTotal / dishes_qty / dishes_rev」嘅**絕對值**：
--      呢三個數**隨日期滾動**（逐日新單入窗就變），寫死基數 = 寫死一個必然過期嘅鬧鐘。
--      本店 2026-10-07 實測：74 / 547100 / 74 / **58** / 198 / 549900。
--      🔴 呢組數之前喺本檔舊版被寫成「75 / 42 / 42 / 84000（凍檸茶）」⇒ **虛構值**：
--         PostgREST 逐字重算 0060 口徑（全店 94 張單、164 行 items、無日期上限）證實
--         · 全店冇任何一行 qty === 42、revenueAvos === 84,000 或 108,000
--         · 全店唯一含「茶」嘅菜品係「快闪菜（沙茶啫啫豆腐煲）」
--         · 最大單行 = 55,600（表嫂肉餅飯）
--         · Σrev / kpi.revenue = 549,900 / 547,100 = 1.0051（服務費／抹零差額，合理）
--         · 74 張單事件時間全部落喺 2026-10-05/06/07 ⇒ 唔存在「窗口差異」解釋
--
--   🔴🔴🔴 第二次踩坑（同一日）：取證腳本報過 `dishesTotal` **58 同 59**，
--      `dishesByChannelTotal` **63 同 64**，而 Σqty／Σrev 每次都一樣。
--      根因**唔係**數據變、**唔係**窗口、**唔係**聚合 key、**唔係**分頁漏行
--      （`Content-Range` 聲稱 94 == 抓到 94），而係**工具自己嘅 bug**：
--          r.on("data", (c) => (d += c));   ← 逐 chunk 個別 toString()
--      中文係 3 bytes UTF-8，一個字跨 chunk 邊界就切爛成 U+FFFD（`�`）
--      ⇒ 菜名變另一個字串 ⇒ 聚合多一行。
--      ✅ 正解：`Buffer.concat(chunks)` 後先 `toString("utf8")`。
--      修正後連跑 15 輪，全部穩定 58 / 63（`tools/_probe-offlinereport-truth-20261007.cjs`，
--      31 條恒等式全綠）。
--      ⇒ **教訓：唔好將任何取證工具嘅絕對值當基線。**
--
--   🔴🔴 契約恒等式修正：`dishesByChannel[].offline*` **≡ `dishes[]` 係錯嘅**，
--      永遠唔成立 ——
--        舊 `dishes[]`  base ＝ `online_order_id is null` ＝ offline **＋ online_platform**
--        新 `offline*`   base ＝ `channel = 'offline'`      ＝ 只有 offline
--      平台單冇 `online_order_id` ⇒ 佢哋喺舊 dishes[] 但唔喺新 offline*。
--      實測：Σqty 198 vs 184（差 14）、Σrev 549,900 vs 477,200（差 72,700）＝ 平台單菜品。
--      ✅ 正確 invariants（見 supabase/verify/0066_verify_production_20261007.sql 第 ⑧ 條）：
--         · 舊 dishes[] 每個 name 都喺新 key 出現
--         · 新 key 多出嘅名（純線上菜，實測 5 款）offlineQty / offlineRevenueAvos 必須 = 0
--         · 同名行：dishes[].qty ≥ dishesByChannel[].offlineQty
--      寫錯基數嘅代價：照住驗收會得出正確值，卻以為仲未修好。
--
--   ⚠️ 唔係 66 / 477200 —— 平台單已被 v1 口徑包埋，唔好喺呢版「修正」佢。
--   ⚠️ dishes_rev **唔會** = kpi_rev（服務費／抹零差額，實測約 1.005 倍）。
--   ⚠️ kpi_count **唔會** = orders_total（orders[] 連未結帳／reopened 都包）。
--   ⚠️ dishesTotal / ordersTotal **必須** = 對應 array 嘅 jsonb_array_length（= 0 gap）。
--
-- ①-bis 🔴🔴🔴 舊 dishes[] 出現拆欄 = 0066 加錯咗地方（第一版嘅特徵）
--   select count(*) as rows_total,
--          count(*) filter (where d ?| array[
--            'offlineQty','onlineQty','offlineRevenueAvos','onlineRevenueAvos','channel'
--          ]) as should_be_zero
--   from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r
--     cross join lateral jsonb_array_elements(r -> 'dishes') d;
--   → should_be_zero = 0（route 亦會因此 503 `rpc-dish-split-on-legacy`）
--
-- ② 🔴 orders[] 唔可以有 `online_projection`（因為還原咗 `online_order_id is null`）
--   select p ->> 'channel' as channel, count(*) as n
--   from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r
--     cross join lateral jsonb_array_elements(r -> 'orders') p
--   group by 1 order by 1;
--   → 只有 offline / online_platform 兩行；**零行 online_projection ＝ 正確**。
--
-- ③ 🆕 kpiByChannel 拆分 ＋ 對數（offline + onlinePlatform ＝ 舊 kpi）
--   select
--     (r -> 'kpiByChannel' -> 'offline'        ->> 'orderCount')::bigint as off_n,
--     (r -> 'kpiByChannel' -> 'offline'        ->> 'revenueAvos')::bigint as off_rev,
--     (r -> 'kpiByChannel' -> 'online'         ->> 'orderCount')::bigint as on_n,
--     (r -> 'kpiByChannel' -> 'online'         ->> 'revenueAvos')::bigint as on_rev,
--     (r -> 'kpiByChannel' -> 'onlinePlatform' ->> 'orderCount')::bigint as pf_n,
--     (r -> 'kpiByChannel' -> 'onlinePlatform' ->> 'revenueAvos')::bigint as pf_rev,
--     (r ->> 'orderCount')::bigint as legacy_kpi_n
--   from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r;
--   → ✅ off_n + pf_n = legacy_kpi_n（v1 包埋平台、排除線上投影）
--   → ⚠️ 絕對值**唔好寫死**（滾動窗口）；2026-10-07 實測 offline 66 / online 19 / platform 8。
--
-- ④ 🆕 ordersByChannel[]：total = jsonb_array_length；差額完全由線上投影單構成
--   select (r ->> 'ordersTotal')::bigint as legacy_total,
--          (r ->> 'ordersByChannelTotal')::bigint as all_total,
--          (r ->> 'ordersByChannelTotal')::bigint - (r ->> 'ordersTotal')::bigint as online_only,
--          (select count(*) from jsonb_array_elements(r -> 'ordersByChannel')
--            where p ->> 'channel' = 'online_projection') as n_projection
--   from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r;
--   → ✅ online_only = n_projection；all_total = jsonb_array_length(r -> 'ordersByChannel')
--
-- ⑤ 🆕 dishesByChannel[] 拆欄自洽 ＋ 七欄齊
--   select count(*) as rows_total,
--          count(*) filter (where (d ->> 'offlineQty')::bigint + (d ->> 'onlineQty')::bigint
--                                <> (d ->> 'qty')::bigint) as qty_mismatch,
--          count(*) filter (where (d ->> 'offlineRevenueAvos')::bigint
--                              + (d ->> 'onlineRevenueAvos')::bigint
--                                <> (d ->> 'revenueAvos')::bigint) as rev_mismatch,
--          count(*) filter (where d ?| array['name','qty','revenueAvos',
--                            'offlineQty','offlineRevenueAvos','onlineQty','onlineRevenueAvos']) as complete
--   from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r
--     cross join lateral jsonb_array_elements(r -> 'dishesByChannel') d;
--   → qty_mismatch = 0、rev_mismatch = 0、complete = rows_total
--
-- ⑥ 🔴🔴 舊 dishes[] 必須係新 dishesByChannel[]「線下部分」嘅完全子集
--   （呢條先係「舊欄冇因為加新欄而順手改口徑」嘅直接證據）
--   with r as (select public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') j),
--   legacy as (
--     select (d ->> 'name') as name, (d ->> 'qty')::bigint as qty,
--            (d ->> 'revenueAvos')::bigint as revenue
--     from r, jsonb_array_elements(j -> 'dishes') d
--   ),
--   ch as (
--     select (d ->> 'name') as name, (d ->> 'offlineQty')::bigint as qty,
--            (d ->> 'offlineRevenueAvos')::bigint as revenue
--     from r, jsonb_array_elements(j -> 'dishesByChannel') d
--     where (d ->> 'offlineQty')::bigint > 0 or (d ->> 'offlineRevenueAvos')::bigint > 0
--   )
--   select (select count(*) from legacy) as legacy_rows,
--          (select count(*) from ch) as ch_offline_rows,
--          (select count(*) from (select * from legacy except select * from ch) x) as only_in_legacy,
--          (select count(*) from (select * from ch except select * from legacy) y) as only_in_ch;
--   → ✅ only_in_legacy = 0、only_in_ch = 0
--
-- ⑦ paymentBreakdown：ΣpaidAvos ＝ 舊 kpi.revenueAvos（捉漏 bucket）
--   select
--     (select coalesce(sum((b ->> 'paidAvos')::bigint), 0)
--        from jsonb_array_elements(r -> 'paymentBreakdown') b) as pb_paid,
--     (r ->> 'revenueAvos')::bigint as kpi_rev
--   from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r;
--   → 兩欄相等
--
-- ⑧ 🔴 paymentBreakdown 嘅 diffAvos 真的可以為負（平台抽成）
--   select b ->> 'method' as method, b ->> 'channel' as channel,
--          (b ->> 'receivableAvos')::bigint - (b ->> 'paidAvos')::bigint as diff
--   from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r
--     cross join lateral jsonb_array_elements(r -> 'paymentBreakdown') b
--   where (b ->> 'paidAvos')::bigint > (b ->> 'receivableAvos')::bigint;
--   → 至少一行（平台單實收 > 應收）；零行＝你啱啱夾咗非負，唔啱。
--
-- ⑨ 🔴 六個新 key 要麼全有、要麼全無
--   select
--     (r ? 'kpiByChannel') as c1, (r ? 'paymentBreakdown') as c2,
--     (r ? 'ordersByChannel') as c3, (r ? 'ordersByChannelTotal') as c4,
--     (r ? 'dishesByChannel') as c5, (r ? 'dishesByChannelTotal') as c6
--   from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r;
--   → 六個都係 true
--
-- ⑩ 菜品排序單調不升（機器驗證；舊 dishes[] 同新 dishesByChannel[] 都要驗）
--   select 'legacy' as which, bool_and(rev >= lag(rev) over () or lag(rev) over () is null) as ok
--   from (select (d ->> 'revenueAvos')::bigint as rev
--         from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r
--           cross join lateral jsonb_array_elements(r -> 'dishes') d) a
--   union all
--   select 'byChannel', bool_and(rev >= lag(rev) over () or lag(rev) over () is null)
--   from (select (d ->> 'revenueAvos')::bigint as rev
--         from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r
--           cross join lateral jsonb_array_elements(r -> 'dishesByChannel') d) b;
--   → 兩行都 true
--
-- ⑪ 權限：anon 應該被拒
--   set role anon;
--   select public.pos_offline_report('<STORE>', null, null);   -- 期望：permission denied
--   reset role;
--
-- ============================================================================
-- 📄 完整 14 條 production 驗收（inline 值、可直接貼 SQL Editor）
--    ⇒ supabase/verify/0066_verify_production_20261007.sql
--    ⚠️ 呢份係**權威**版本：上面呢啲註解只列最易錯嗰幾條。
--       驗收一律以「自我一致／對數」判定，唔好再對死數字（見 ① 嘅警告）。
--    ⚠️ 權威檔**唔喺 migrations/**（避免被 db push 用 postgres role 執行而失敗），
--       改路徑時記得同步更新 tools/check-offline-sql.py 嘅 TARGETS。
-- ============================================================================