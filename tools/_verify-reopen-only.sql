-- 返結修復驗證（只此一段，最優先執行）
--
-- 用途：確認 2026-09-18 13:29 部署嘅修復有冇生效。
--
-- 執行前必做：喺 iPad 上做一次完整「返結 → 加菜 → 重結」。
-- 然後喺 Supabase > POS 專案 > SQL Editor 執行下面呢一段。
--
-- 只複製下面嘅 select 語句（連 where 同 order by），唔好連註解一齊揀。
-- 如果見到 "syntax error at or near @"，代表複製咗 git diff 內容。

select
  local_order_no                        as 訂單號,
  status                                as 狀態,
  total                                 as 雲端總額,
  reopen_count                          as 返結次數,
  reopened_at at time zone 'Asia/Macau' as 返結時間,
  reopen_reason                         as 返結原因,
  updated_at at time zone 'Asia/Macau'  as 雲端更新時間,
  case
    when reopen_count > 0
      then '通過'
    when status = 'reopened'
      then '部分通過'
    else
      '未通過'
  end                                   as 判別
from public.pos_orders
where created_at >= now() - interval '6 hours'
order by created_at desc;
