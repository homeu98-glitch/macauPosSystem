-- 訂單02 雲端真相診斷（表嫂美食 2026-09-18）
--
-- 用法：Supabase Dashboard > POS 專案 > SQL Editor，逐段複製貼上執行。
-- 全部係唯讀 SELECT，唔會改任何資料。
--
-- 檔案已移除所有 @ 符號，避免複製時同 git diff 混淆。
-- 如果你之前見到 "syntax error at or near @ LINE 1: @ -0,0 +1,123 @@"
-- 嗰段係 git diff 格式（唔係 SQL），代表複製來源錯咗，唔係 SQL 本身有問題。


-- ===========================================================================
-- 查詢 1：今日全部線下單，一眼睇齊關鍵欄位
-- ===========================================================================
select
  local_order_no                                  as 訂單號,
  status                                          as 狀態,
  total                                           as 雲端總額,
  reopen_count                                    as 返結次數,
  reopened_at                                     as 返結時間,
  reopen_reason                                   as 返結原因,
  jsonb_array_length(items)                       as 菜項數,
  created_at at time zone 'Asia/Macau'            as 建立_澳門時間,
  updated_at at time zone 'Asia/Macau'            as 更新_澳門時間,
  client_updated_at at time zone 'Asia/Macau'     as 客戶端更新_澳門時間
from public.pos_orders
where created_at >= now() - interval '36 hours'
order by created_at asc;


-- ===========================================================================
-- 查詢 2：最關鍵，時間線判別
--   部署時刻 = 2026-09-18 11:46:59 澳門時間 = 2026-09-18 03:46:59 UTC
--   updated_at 早過呢個時刻 = 部署前寫入 = 舊程式碼 = 返結上唔到雲
-- ===========================================================================
select
  local_order_no                       as 訂單號,
  status                               as 狀態,
  total                                as 總額,
  reopen_count                         as 返結次數,
  updated_at at time zone 'Asia/Macau' as 雲端更新_澳門時間,
  case
    when updated_at < timestamptz '2026-09-18 03:46:59+00'
      then '部署前寫入，舊程式碼'
    else '部署後寫入，新程式碼'
  end                                  as 判別
from public.pos_orders
where created_at >= now() - interval '36 hours'
order by created_at asc;


-- ===========================================================================
-- 查詢 3：訂單02 逐項拆開，確認盒是 3 個定 4 個
-- ===========================================================================
select
  o.local_order_no                     as 訂單號,
  o.total                              as 雲端總額,
  o.reopen_count                       as 返結次數,
  item ->> 'name'                      as 菜名,
  (item ->> 'quantity')::numeric       as 數量,
  (item ->> 'price')::numeric          as 單價,
  (item ->> 'quantity')::numeric * (item ->> 'price')::numeric as 小計
from public.pos_orders o
cross join lateral jsonb_array_elements(o.items) as item
where o.local_order_no in ('訂單02', '訂單2')
order by o.created_at asc, 菜名;


-- ===========================================================================
-- 查詢 4：矛盾單偵測，items 加總對唔對得上 total
--   對唔上 = 金額有 patch 但 items 冇寫入 = 新金額配舊數量
-- ===========================================================================
select
  o.local_order_no                                               as 訂單號,
  o.total                                                        as 雲端總額,
  sum((item ->> 'quantity')::numeric * (item ->> 'price')::numeric) as items加總,
  o.total - sum((item ->> 'quantity')::numeric * (item ->> 'price')::numeric) as 差額,
  case
    when o.total = sum((item ->> 'quantity')::numeric * (item ->> 'price')::numeric)
      then '一致'
    else '不一致，矛盾單'
  end                                                            as 判定
from public.pos_orders o
cross join lateral jsonb_array_elements(o.items) as item
where o.local_order_no in ('訂單02', '訂單2')
group by o.id, o.local_order_no, o.total;


-- ===========================================================================
-- 查詢 5：全店返結統計，標籤應該出幾多張
-- ===========================================================================
select
  count(*)                                 as 總單數,
  count(*) filter (where reopen_count > 0) as 曾返結單數,
  coalesce(sum(total), 0)                  as 總額
from public.pos_orders
where created_at >= now() - interval '36 hours';


-- ===========================================================================
-- 查詢 6：對照組，其他店有冇任何返結記錄
--   全部係 0 = 寫入路徑從未成功過
--   有店 > 0 = 路徑正常，只係本店嗰幾張單早過部署
-- ===========================================================================
select
  store_id                                       as 店舖,
  count(*)                                       as 單數,
  count(*) filter (where reopen_count > 0)       as 曾返結數,
  max(reopened_at) at time zone 'Asia/Macau'     as 最近返結
from public.pos_orders
where created_at >= now() - interval '30 days'
group by store_id
order by 曾返結數 desc, 單數 desc;
