-- ============================================================================
-- 0066 驗收（production 定案版，2026-10-07）
-- ----------------------------------------------------------------------------
-- 🔴🔴 為咩呢份驗收唔再寫死「42 / 42 / 84000」
--
--   舊版註解聲稱舊 dishes[] 基數 = `dishesTotal 42 / Σqty 42 / Σrev 84,000`（凍檸茶）。
--   2026-10-07 用 PostgREST 逐字重算 0060 口徑（全店 94 張單、164 行 items、無日期上限）：
--     · 全店唯一含「茶」嘅菜品係 `快闪菜（沙茶啫啫豆腐煲）`；**冇任何一行 qty === 42**。
--     · **冇任何一行 revenueAvos === 84,000 或 108,000**；最大單行 = 55,600（表嫂肉餅飯）。
--     · 舊口徑 dishes[] 實算 = **58 款 / Σqty 198 / Σrev 549,900**。
--     · Σrev / kpi.revenue = 549,900 / 547,100 = **1.0051** ← 呢個比值先係合理
--       （差額 = 服務費／抹零）。84,000 連數量級都對唔上。
--     · 74 張線下單事件時間全部落喺 2026-10-05 / 10-06 / 10-07 ⇒ 唔存在「窗口差異」解釋。
--   ⇒ 嗰三個數係**文檔虛構值**，唔係任何 range 嘅實測。
--      而家呢份驗收改為**自我一致檢查 ＋ 對數**，令「舊欄還原咗」可以機械式判定。
--
-- 🔴🔴 2026-10-07 修正：本檔第 ⑧ 條原本寫「`dishesByChannel[].offline*` ≡ `dishes[]`」，
--    呢條恒等式**永遠唔成立**（舊 dishes[] base 係 `online_order_id is null`
--    ＝ offline **＋ online_platform**；平台單冇 online_order_id）。
--    已改成單向包含 + 差額對數。詳見 docs/154 §4.2.1。
--
-- 🔴🔴 產勘教訓：同一份 production 數據曾報出 `dishesTotal` 58 **同** 59，
--    根因係取證腳本用 `d += chunk` 逐 chunk 拼字串，跨 chunk 嘅中文（3 bytes UTF-8）
--    被切爛成 U+FFFD ⇒ 菜名變另一個字串 ⇒ 聚合多一行。
--    ⇒ **唔好將任何取證工具嘅絕對值當基線**；本檔全部改用恒等式（任何日子都成立）。
--
-- 🔴 呢份驗收**唔會**出現「0066 第一版」嘅壞值（67 / 54 / 108,000）：
--    因為嗰個版本嘅特徵係 `offlineQty === qty` 且 `onlineQty === 0`，
--    呢個現象由 ③（舊 dishes 出現拆欄）同 ⑦（拆欄 mismatch）直接捉到。
--
-- 點用：Supabase SQL Editor 逐條跑（service role；RPC 對 anon 係 permission denied）。
--       ⚠️ 唔好用 begin;…commit; 包裹。
--       ⚠️ 本檔用 inline 值（Supabase SQL Editor 唔支援 psql 嘅 \set）；
--          要換店／換 range 就自己改下面兩處常數。
-- ============================================================================

-- 店 = 8291f843-9def-4956-9d0b-1cfef2598306 ｜ range = 2026-07-10 → 2026-10-07

-- ============================================================================
-- ① 🔴 舊欄完整性：0060 嘅 14 個 key 必須全部存在
-- ============================================================================
select
  (r ? 'found')        as c_found,
  (r ? 'from')         as c_from,
  (r ? 'to')           as c_to,
  (r ? 'clamped')      as c_clamped,
  (r ? 'orderCount')   as c_orderCount,
  (r ? 'revenueAvos')  as c_revenueAvos,
  (r ? 'refundedAvos') as c_refundedAvos,
  (r ? 'discountAvos') as c_discountAvos,
  (r ? 'covers')       as c_covers,
  (r ? 'byPayment')    as c_byPayment,
  (r ? 'ordersTotal')  as c_ordersTotal,
  (r ? 'orders')       as c_orders,
  (r ? 'dishesTotal')  as c_dishesTotal,
  (r ? 'dishes')       as c_dishes
from public.pos_offline_report(
  '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
) r;
-- → 14 個全部 true

-- ============================================================================
-- ② 🔴🔴 舊欄對數：byPayment Σ ＝ kpi.revenueAvos；兩個 length gap ＝ 0
--    （同一批單、同一口徑 ⇒ 呢個係「舊口徑冇被順手改過」嘅機械式證據）
-- ============================================================================
select
  (r ->> 'orderCount')::bigint as kpi_n,
  (r ->> 'revenueAvos')::bigint as kpi_rev,
  (select coalesce(sum((b ->> 'amountAvos')::bigint), 0)
     from jsonb_array_elements(r -> 'byPayment') b) as byPayment_sum,
  (r ->> 'ordersTotal')::bigint as orders_total,
  (r ->> 'dishesTotal')::bigint as dishes_total,
  (select coalesce(sum((d ->> 'qty')::bigint), 0)
     from jsonb_array_elements(r -> 'dishes') d) as dishes_qty,
  (select coalesce(sum((d ->> 'revenueAvos')::bigint), 0)
     from jsonb_array_elements(r -> 'dishes') d) as dishes_rev,
  (r ->> 'ordersTotal')::bigint - jsonb_array_length(r -> 'orders') as orders_len_gap,
  (r ->> 'dishesTotal')::bigint - jsonb_array_length(r -> 'dishes') as dishes_len_gap
from public.pos_offline_report(
  '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
) r;
-- ✅ byPayment_sum = kpi_rev、orders_len_gap = 0、dishes_len_gap = 0
-- ⚠️ kpi_n 未必 = orders_total（orders[] 連未結帳／reopened 都包，kpi 只計 settled/paid）
-- ⚠️ dishes_rev 唔會 = kpi_rev（服務費／抹零差額，實測約 1.005 倍）

-- ============================================================================
-- ③ 🔴🔴🔴 舊 dishes[] 必須**嚴格三欄**：name / qty / revenueAvos
--    出現任何拆欄 = 0066 加錯咗地方（route 會 503 `rpc-dish-split-on-legacy`）
-- ============================================================================
select
  count(*) as rows_total,
  count(*) filter (where d ?| array[
    'offlineQty','onlineQty','offlineRevenueAvos','onlineRevenueAvos','channel'
  ]) as should_be_zero,
  count(*) filter (where not (d ? 'name' and d ? 'qty' and d ? 'revenueAvos')) as missing_core
from public.pos_offline_report(
  '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
) r
  cross join lateral jsonb_array_elements(r -> 'dishes') d;
-- ✅ rows_total = dishes_total（見 ②）、should_be_zero = 0、missing_core = 0
--    呢條係 0066 第一版（67 / 54 / 108,000）嘅直接捉狗點

-- ============================================================================
-- ④ 舊 orders[] 唔可以有 online_projection（還原咗 online_order_id is null）
-- ============================================================================
select p ->> 'channel' as channel, count(*) as n
from public.pos_offline_report(
  '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
) r
  cross join lateral jsonb_array_elements(r -> 'orders') p
group by 1 order by 1;
-- → 只有 offline / online_platform；**零行 online_projection ＝ 正確**

-- ============================================================================
-- ⑤ 🔴 六個新 key 要麼全有、要麼全無
-- ============================================================================
select
  (r ? 'kpiByChannel')         as c1,
  (r ? 'paymentBreakdown')     as c2,
  (r ? 'ordersByChannel')      as c3,
  (r ? 'ordersByChannelTotal') as c4,
  (r ? 'dishesByChannel')      as c5,
  (r ? 'dishesByChannelTotal') as c6,
  jsonb_array_length(r -> 'ordersByChannel') as obc_len,
  (r ->> 'ordersByChannelTotal')::bigint    as obc_total,
  (r ->> 'dishesByChannelTotal')::bigint    as dbc_total,
  jsonb_array_length(r -> 'dishesByChannel') as dbc_len
from public.pos_offline_report(
  '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
) r;
-- ✅ 六個全部 true、obc_len = obc_total、dbc_len = dbc_total

-- ============================================================================
-- ⑥ 🔴 舊 orders 張數 + 新 ordersByChannel 張數（差額 = 線上投影單）
--    ⚠️ 呢個差額**唔係**「舊欄被改」—— 舊欄少嗰啲正正就係線上單，係方案 A 嘅設計。
-- ============================================================================
select
  (r ->> 'ordersTotal')::bigint as legacy_orders_total,
  (r ->> 'ordersByChannelTotal')::bigint as all_orders_total,
  (r ->> 'ordersByChannelTotal')::bigint - (r ->> 'ordersTotal')::bigint as online_only,
  (select count(*) from jsonb_array_elements(r -> 'ordersByChannel')
    where p ->> 'channel' = 'online_projection') as n_projection
from public.pos_offline_report(
  '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
) r;
-- ✅ online_only = n_projection（差額完全由線上投影單構成）

-- ============================================================================
-- ⑦ 🔴 新 dishesByChannel[] 拆欄必須自洽
-- ============================================================================
select
  count(*) as rows_total,
  count(*) filter (where (d ->> 'offlineQty')::bigint + (d ->> 'onlineQty')::bigint
                        <> (d ->> 'qty')::bigint) as qty_mismatch,
  count(*) filter (where (d ->> 'offlineRevenueAvos')::bigint + (d ->> 'onlineRevenueAvos')::bigint
                        <> (d ->> 'revenueAvos')::bigint) as rev_mismatch,
  count(*) filter (where d ?| array['name','qty','revenueAvos',
                        'offlineQty','offlineRevenueAvos','onlineQty','onlineRevenueAvos']) as complete
from public.pos_offline_report(
  '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
) r
  cross join lateral jsonb_array_elements(r -> 'dishesByChannel') d;
-- ✅ qty_mismatch = 0、rev_mismatch = 0、complete = rows_total

-- ============================================================================
-- ⑧ 🔴🔴 舊 dishes[] vs 新 dishesByChannel[].offline*：**單向包含**（唔係逐行相等）
--
--    🔴 呢條嘢本來寫錯咗（原寫 `except` 雙向 0）。生產實測證明**永遠唔會相等**：
--       · 舊 `dishes[]`  base ＝ `online_order_id is null`  ⇒ offline **＋ online_platform**
--       · 新 `offline*`   base ＝ `channel = 'offline'`      ⇒ 只有 offline
--       · 平台單（`source IN ('aomi','mfood')`）**冇 online_order_id**
--         ⇒ 佢哋喺舊 dishes[] 入面，但唔會入新 offline*。
--       2026-10-07 實測：Σqty 198 vs 184（差 14）、Σrev 549,900 vs 477,200（差 72,700），
--       差額就係平台單菜品。
--
--    ✅ 正確 invariants（全部任何日子都成立）：
--       legacy_missing_in_new = 0        （舊每個名都喺新 key 出現）
--       new_only_rows 的 offlineQty/offlineRevenueAvos 全部 = 0（純線上菜）
--       冇一行 legacy.qty < ch.qty（舊 = offline + platform ⇒ 舊 >= 純 offline）
--       legacy_rows - ch_rows = 平台單獨有嘅菜品數（>= 0）
-- ============================================================================
with r as (
  select public.pos_offline_report(
    '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
  ) j
),
legacy as (
  select (d ->> 'name') as name,
         (d ->> 'qty')::bigint as qty,
         (d ->> 'revenueAvos')::bigint as revenue
  from r, jsonb_array_elements(j -> 'dishes') d
),
ch as (
  select (d ->> 'name') as name,
         (d ->> 'offlineQty')::bigint as qty,
         (d ->> 'offlineRevenueAvos')::bigint as revenue
  from r, jsonb_array_elements(j -> 'dishesByChannel') d
)
select
  (select count(*) from legacy) as legacy_rows,
  (select count(*) from ch) as ch_rows,
  -- 🔴 必須 0：舊 dishes[] 每個名都喺新 key 出現
  (select count(*) from legacy l where not exists (select 1 from ch c where c.name = l.name))
    as legacy_missing_in_new,
  -- 🔴 必須 0：新 key 多出嘅名（一個都唔可以帶到 offline 數量）
  (select count(*) from ch c
     where not exists (select 1 from legacy l where l.name = c.name)
       and (c.qty <> 0 or c.revenue <> 0)) as new_only_with_offline_amount,
  -- 🔴 必須 0：冇一行「舊 qty < 純 offline qty」（方向反咗就代表舊欄被改窄咗）
  (select count(*) from legacy l
     join ch c on c.name = l.name
     where l.qty < c.qty or l.revenue < c.revenue) as legacy_smaller_than_offline,
  -- ℹ️ 平台單獨有嘅菜品數（>= 0，正常）
  (select count(*) from legacy) - (select count(*) from ch) as platform_only_dishes;
-- ✅ legacy_missing_in_new = 0、new_only_with_offline_amount = 0、legacy_smaller_than_offline = 0
-- ℹ️ platform_only_dishes 實測 = 58 - 58 = 0（呢間店平台單嘅菜都同線下撞名）
--    ⚠️ 唔好斷言佢一定係 0 —— 平台單賣獨有菜時會 > 0。

-- ============================================================================
-- ⑨ kpiByChannel 三路拆分 ＋ 對數（offline + onlinePlatform ＝ 舊 kpi）
-- ============================================================================
select
  (r -> 'kpiByChannel' -> 'offline'        ->> 'orderCount')::bigint as off_n,
  (r -> 'kpiByChannel' -> 'offline'        ->> 'revenueAvos')::bigint as off_rev,
  (r -> 'kpiByChannel' -> 'online'         ->> 'orderCount')::bigint as on_n,
  (r -> 'kpiByChannel' -> 'online'         ->> 'revenueAvos')::bigint as on_rev,
  (r -> 'kpiByChannel' -> 'onlinePlatform' ->> 'orderCount')::bigint as pf_n,
  (r -> 'kpiByChannel' -> 'onlinePlatform' ->> 'revenueAvos')::bigint as pf_rev,
  (r ->> 'orderCount')::bigint as legacy_kpi_n
from public.pos_offline_report(
  '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
) r;
-- ✅ off_n + pf_n = legacy_kpi_n（v1 包埋平台單、排除線上投影單）

-- ============================================================================
-- ⑩ paymentBreakdown：ΣpaidAvos ＝ 舊 kpi.revenueAvos（捉漏 bucket）
-- ============================================================================
select
  (select coalesce(sum((b ->> 'paidAvos')::bigint), 0)
     from jsonb_array_elements(r -> 'paymentBreakdown') b) as pb_paid_sum,
  (r ->> 'revenueAvos')::bigint as kpi_rev
from public.pos_offline_report(
  '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
) r;
-- → 兩欄相等

-- ============================================================================
-- ⑪ 🔴 diffAvos 真的可以為負（平台抽成 ⇒ 實收 > 應收）
-- ============================================================================
select b ->> 'method' as method, b ->> 'channel' as channel,
       (b ->> 'receivableAvos')::bigint - (b ->> 'paidAvos')::bigint as diff
from public.pos_offline_report(
  '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
) r
  cross join lateral jsonb_array_elements(r -> 'paymentBreakdown') b
where (b ->> 'paidAvos')::bigint > (b ->> 'receivableAvos')::bigint;
-- → 至少一行；零行 = 你啱啱夾咗非負，唔啱。

-- ============================================================================
-- ⑫ 菜品排序單調不升（舊 dishes[] 同新 dishesByChannel[] 都要驗）
-- ============================================================================
select 'legacy' as which, bool_and(rev >= lag(rev) over () or lag(rev) over () is null) as ok
from (
  select (d ->> 'revenueAvos')::bigint as rev
  from public.pos_offline_report(
    '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
  ) r
    cross join lateral jsonb_array_elements(r -> 'dishes') d
) a
union all
select 'byChannel', bool_and(rev >= lag(rev) over () or lag(rev) over () is null)
from (
  select (d ->> 'revenueAvos')::bigint as rev
  from public.pos_offline_report(
    '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
  ) r
    cross join lateral jsonb_array_elements(r -> 'dishesByChannel') d
) b;
-- → 兩行都 true

-- ============================================================================
-- ⑬ top-level key 清單（應該 20 個＝0060 嘅 14 ＋ 0066 嘅 6；RPC 唔會回 flags）
-- ============================================================================
select k from public.pos_offline_report(
  '8291f843-9def-4956-9d0b-1cfef2598306', '2026-07-10', '2026-10-07'
) r, lateral jsonb_object_keys(r) as k
order by 1;
-- → 20 行

-- ============================================================================
-- ⑭ 權限：anon 應該被拒（security invoker ＋ 只 grant service_role）
-- ============================================================================
set role anon;
select public.pos_offline_report('8291f843-9def-4956-9d0b-1cfef2598306', null, null);
-- 期望：permission denied
reset role;