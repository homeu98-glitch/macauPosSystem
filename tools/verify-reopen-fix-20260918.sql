-- 返結修復驗證（2026-09-18）
--
-- 用法：Supabase Dashboard > POS 專案（iyrywzormzisyppkokbi）> SQL Editor
-- 全部係唯讀 SELECT，唔會改任何資料。
--
-- 只複製下面的 SQL 語句本身，唔好連註解裝飾一齊揀。
-- 如果執行時見到 "syntax error at or near @"，代表複製咗 git diff 內容。


-- ===========================================================================
-- 第 1 步：先喺 iPad 上做一次完整流程（返結 → 加菜 → 重結）
--         然後執行下面查詢
-- ===========================================================================
select
  local_order_no                            as 訂單號,
  status                                    as 狀態,
  total                                     as 雲端總額,
  reopen_count                              as 返結次數,
  reopened_at at time zone 'Asia/Macau'     as 返結時間,
  reopen_reason                             as 返結原因,
  jsonb_array_length(items)                 as 菜項數,
  updated_at at time zone 'Asia/Macau'      as 雲端更新時間,
  case
    when reopen_count > 0
      then '通過'
    when status = 'reopened'
      then '部分通過：狀態已上雲，審計欄未寫'
    else
      '未通過'
  end                                       as 判別
from public.pos_orders
where created_at >= now() - interval '12 hours'
order by created_at desc;


-- ===========================================================================
-- 第 2 步：矛盾單偵測
--   items 逐項加總 vs total 對唔上 = 「新金額 + 舊數量」矛盾單
--   呢種單係修復前產生嘅歷史資料，唔會被新程式碼自動修正
-- ===========================================================================
select
  o.local_order_no                                                  as 訂單號,
  o.total                                                           as 雲端總額,
  sum((item ->> 'quantity')::numeric * (item ->> 'price')::numeric)  as items加總,
  o.total - sum((item ->> 'quantity')::numeric * (item ->> 'price')::numeric) as 差額,
  o.reopen_count                                                    as 返結次數,
  case
    when o.total = sum((item ->> 'quantity')::numeric * (item ->> 'price')::numeric)
      then '一致'
    else '不一致，歷史矛盾單'
  end                                                               as 判定
from public.pos_orders o
cross join lateral jsonb_array_elements(o.items) as item
where o.created_at >= now() - interval '7 days'
group by o.id, o.local_order_no, o.total, o.reopen_count
having o.total <> sum((item ->> 'quantity')::numeric * (item ->> 'price')::numeric)
order by o.created_at desc;


-- ===========================================================================
-- 第 3 步：逐項拆開睇某一張單（改訂單號）
-- ===========================================================================
select
  o.local_order_no                as 訂單號,
  o.total                         as 雲端總額,
  o.reopen_count                  as 返結次數,
  item ->> 'name'                 as 菜名,
  (item ->> 'quantity')::numeric  as 數量,
  (item ->> 'price')::numeric     as 單價,
  (item ->> 'quantity')::numeric * (item ->> 'price')::numeric as 小計
from public.pos_orders o
cross join lateral jsonb_array_elements(o.items) as item
where o.local_order_no = '訂單02'
order by 菜名;


-- ===========================================================================
-- 第 4 步：全店返結統計
-- ===========================================================================
select
  count(*)                                  as 近7日總單數,
  count(*) filter (where reopen_count > 0)  as 曾返結單數,
  coalesce(sum(total), 0)                   as 總額
from public.pos_orders
where created_at >= now() - interval '7 days';


-- ===========================================================================
-- 第 5 步：修復前 vs 修復後寫入對照
--   部署時刻 = 2026-09-18 13:29 澳門時間 = 2026-09-18 05:29 UTC
-- ===========================================================================
select
  local_order_no                       as 訂單號,
  reopen_count                         as 返結次數,
  total                                as 總額,
  updated_at at time zone 'Asia/Macau' as 雲端更新時間,
  case
    when updated_at < timestamptz '2026-09-18 05:29:00+00'
      then '修復前寫入'
    else '修復後寫入'
  end                                  as 判別
from public.pos_orders
where created_at >= now() - interval '24 hours'
order by updated_at desc;
