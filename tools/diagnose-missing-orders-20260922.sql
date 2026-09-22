-- ============================================================================
-- 診斷「有廚房紙但系統見唔到單」（2026-09-22 個案：#19 / #23）
-- 用法：Supabase Dashboard → SQL Editor → 改 <STORE_ID> → 逐段 Run
-- 全部 read-only。時間一律換算澳門 (+8)。
-- ============================================================================
--
-- 個案事實（由相片／截圖）：
--   · 廚房紙 #19：餐台 A01、落單 17:33、快閃餐 + 蒸魚飯 + 盒
--   · 廚房紙 #23：餐台 外賣自取1、落單 18:21、快閃餐 + 蒸魚飯 + 盒 ×4
--   · 桌台總覽 18:38：A01「已下單 應收 MOP 46」、外賣自取1「空閒」
--   · 報表 18:38（共 26 張）：見到「訂單23 外賣自取1 Mpay 18:23 MOP 107」
-- 三個要分清嘅問題：
--   ① 雲端 `pos_orders` 到底有冇呢兩張單？
--   ② 若有，狀態係咩（未結帳＝唔會出現喺報表 → 唔算「唔見」）
--   ③ 若冇，係「從未上雲」定「被隔離」？（隔離係**本機**行為，DB 查唔到）

-- ── ① 今日全部訂單（按落單時間；一眼睇齊 19 / 23 喺唔喺）──────────────
select
  local_order_no                                   as 單號,
  status                                           as 狀態,
  table_name                                       as 餐台,
  total                                            as 應收,
  payment_method                                   as 收款,
  (created_at at time zone 'Asia/Macau')            as 落單澳門,
  (updated_at at time zone 'Asia/Macau')            as 更新澳門,
  source                                           as 來源,
  online_order_id                                  as 線上單id,
  jsonb_array_length(coalesce(items, '[]'::jsonb))  as 菜品數
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and created_at >= timestamptz '2026-09-22 00:00:00+08'
order by created_at;

-- ── ② 專搵 19 / 23（唔靠 exact match，因為號碼可能有 prefix）──────────────
select local_order_no, status, table_name, total,
       (created_at at time zone 'Asia/Macau') as 落單澳門
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and (local_order_no like '%19%' or local_order_no like '%23%')
order by created_at;

-- ── ③ 對照「打印記錄」：有紙 = 一定有 job（就算訂單冇上雲）────────────────
-- 若呢度見到 #19 / #23 嘅 order_no，但 ① 冇 → 就係「本地建單成功、上雲失敗」
select order_no, ticket_type, printer_group, printer_name, status,
       (created_at at time zone 'Asia/Macau') as 建job澳門,
       last_error
from public.pos_print_jobs
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and created_at >= timestamptz '2026-09-22 00:00:00+08'
order by created_at;

-- ── ④ 上雲事件記錄：本地有冇嘗試推呢兩張單？結果係咩？───────────────────
select type, entity_id, status,
       (created_at at time zone 'Asia/Macau') as 澳門
from public.pos_queue_events
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and created_at >= timestamptz '2026-09-22 00:00:00+08'
order by created_at;

-- ── ⑤ 側面佐證：該店今日嘅單號分佈（睇有冇跳號／兩套序號）─────────────────
-- 「#19」同「訂單23」可能係**兩套序號體系**（收銀台 vs 店員手機／線上鏡像），
-- 兩者 prefix 唔同係正常，唔代表漏單。
select
  case
    when local_order_no like '#%'      then '#N（收銀台／快餐）'
    when local_order_no like '訂單%'   then '訂單N（店員手機／鏡像）'
    else '其他'
  end as 號碼體系,
  count(*) as 數量,
  min(local_order_no) as 最細,
  max(local_order_no) as 最大
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and created_at >= timestamptz '2026-09-22 00:00:00+08'
group by 1;

-- ============================================================================
-- ⑥ 【聚焦】直接睇 訂單19 / 訂單23 嘅完整資料（用戶 18:41 貼咗 ⑤ 段結果之後加）
-- ============================================================================
-- ⑤ 段實測結果（2026-09-22 18:41）：
--   · 訂單N（店員手機／鏡像）：**25 張，最細 訂單01，最大 訂單25**（數量＝25 ⇒ **連續、零跳號**）
--   · 其他：2 張（002 ~ 004）
--   · `#N`（收銀台）：**0 張** ⇒ 廚房紙上嘅「#19 / #23」其實就係 `訂單19 / 訂單23`
--     （打印模板／OCR 嘅「#」唔係 local_order_no 嘅一部分）
-- ⇒ 即係**今日嘅單冇漏**（01–25 齊），要查嘅係「狀態」同「items」。
select
  local_order_no                                   as 單號,
  status                                           as 狀態,
  fulfillment_status                               as 出餐狀態,
  table_name                                       as 餐台,
  total                                            as 總額,
  discount_amount                                  as 折扣,
  payment_method                                   as 收款,
  comp_note                                        as 免單原因,
  reopen_count                                     as 返結次數,
  (created_at at time zone 'Asia/Macau')            as 落單澳門,
  (updated_at at time zone 'Asia/Macau')            as 最後更新澳門,
  (sent_to_kitchen_at at time zone 'Asia/Macau')    as 落廚房澳門,
  (served_at at time zone 'Asia/Macau')             as 出餐澳門,
  source                                           as 來源,
  online_order_id                                  as 線上單id,
  jsonb_array_length(coalesce(items, '[]'::jsonb))  as 菜品數,
  items                                            as 菜品原文
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and local_order_no in ('訂單19', '訂單23')
order by local_order_no;

-- ⑥b【若 ⑥ 回 0 行】＝ 雲端真係冇嗰兩張 → 再查係「從未上雲」定「上咗但號碼唔同」
select local_order_no, status, table_name, total,
       (created_at at time zone 'Asia/Macau') as 落單澳門
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and created_at between timestamptz '2026-09-22 17:25:00+08' and timestamptz '2026-09-22 18:30:00+08'
order by created_at;
-- 對照廚房紙：17:33（A01）同 18:21（外賣自取1）—— 上面應該各有一行。

-- ⑥c【一齊睇】今日「有紙但雲端冇單」嘅差集（最有力嘅一條）──────────────────
select j.order_no as 有紙嘅單號,
       j.printer_name as 印去邊,
       (j.created_at at time zone 'Asia/Macau') as 出紙澳門,
       o.local_order_no as 對應訂單,
       o.status as 訂單狀態
from public.pos_print_jobs j
left join public.pos_orders o
  on o.store_id = j.store_id and (o.local_order_no = j.order_no or o.local_order_no = replace(j.order_no, '#', ''))
where j.store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and j.created_at >= timestamptz '2026-09-22 00:00:00+08'
order by j.created_at;
-- 呢條會一次過顯示：邊張紙對得返邊張單（`對應訂單` 有值 ✓），
-- 邊張紙**冇對應訂單**（`對應訂單` 係 NULL ✗ ⇒ 就係「有紙冇單」）。

-- ⑥d【「其他」嗰 2 張係咩？】⑤ 段顯示「其他：2 張，最細 002，最大 004」
--     —— 即係今日有一個**第三套號碼體系**（唔係 `訂單N`、唔係 `#N`）。
--     若你預期今日有 001 / 003 而佢哋唔喺 `pos_orders`，就係另一條線索。
select local_order_no, status, table_name, total, source, online_order_id,
       (created_at at time zone 'Asia/Macau') as 落單澳門,
       jsonb_array_length(coalesce(items, '[]'::jsonb)) as 菜品數
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and created_at >= timestamptz '2026-09-22 00:00:00+08'
  and local_order_no not like '訂單%'
order by local_order_no;
-- 判讀：`source` 會講出邊個程式建單（`scan`＝掃碼、`kiosk`＝自助機、null＝收銀台…）。
--   例如「自取」單（001/002/003）通常係快餐/掃碼單，號碼係本機每日序號。

-- ============================================================================
-- ⑦ 【2026-09-22 18:44 加】打印記錄顯示「狀態欄位異常，已自動標記為失敗」
-- ============================================================================
-- 症狀：打印中心有一行冇訂單號、打印機 `kitchen`、時間同 訂單25 一樣（18:40）、
--       失敗原因＝「狀態欄位異常，已自動標記為失敗（請通知技術人員）」。
--
-- 🔎 呢句文案係**前端 fallback**：`normalizePrintJobStatus()`（`src/lib/print-jobs.ts`）
--    見到 job.status **唔係** pending/sent/printed/failed 任何一個（＝ null / undefined / 空字串 /
--    其他值）就會強制標 failed，並寫上呢句。
--
-- 已知兩個 mapper 嘅差異：
--   · `mapPosPrintJobRow()`（Realtime 路徑，`pos-order-mapper.ts:162`）有兜底 `?? "pending"` ✓
--   · `/api/pos/state` 嘅 printJobs mapper 係 `status: job.status`（**冇兜底**）⇒
--     雲端 row `status IS NULL` 就會傳 undefined 落 client ⇒ 顯示上面嗰句。
--   · `0011` 建表時 `status text` **冇 NOT NULL、冇 default** ⇒ 可以係 NULL。

-- ⑦a 全店有幾多 job 嘅 status 係 NULL（或空）
select count(*) filter (where status is null)      as status_null,
       count(*) filter (where status = '')         as status_empty,
       count(*) filter (where order_no is null)    as order_no_null,
       count(*)                                    as total
from public.pos_print_jobs
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306';

-- ⑦b 逐行睇（今日）
select id, order_no, order_id, kind, ticket_type, status, printer_name, printer_group,
       (created_at at time zone 'Asia/Macau') as 建job澳門,
       attempts, claimed_by, finished_at, once_key, last_error
from public.pos_print_jobs
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and (status is null or status = '' or order_no is null)
order by created_at desc
limit 50;

-- ⑦c 18:35–18:45 之間嘅全部 job（對照 訂單25 / A03）
select id, order_no, kind, ticket_type, printer_name, status,
       (created_at at time zone 'Asia/Macau') as 建job澳門,
       (updated_at at time zone 'Asia/Macau') as 更新澳門,
       finished_at, attempts, last_error
from public.pos_print_jobs
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and created_at between timestamptz '2026-09-22 18:35:00+08' and timestamptz '2026-09-22 18:45:00+08'
order by created_at;
-- 判讀：見到邊一行 `status is null` 就係元兇；亦睇 `finished_at` 有冇值
--       （有 finished_at ＝ 中繼 APK 真係出過紙，只係 status 欄冇寫好）。

-- ============================================================================
-- 判讀指引
-- ============================================================================
-- ① 有 #19 / #23 且 status 係 settled/paid → 冇唔見；報表只列「已付款」，
--    未結帳嘅單本來就唔會出現（桌台總覽「空閒」＝ 已結帳，屬正常）。
-- ② 有但 status 係 draft / sent_to_kitchen 而桌台總覽又睇唔到 →
--    🔴 好可能係**本機孤兒單隔離**（見下面），要去 POS `/orders` → 「同步健康」→ 隔離區還原。
-- ③ 完全冇（但 ③ 有 job）→ 本地建單成功但上雲失敗：
--    睇 ④ 嘅 pos_queue_events 有冇 ORDER_CREATED 同 status；若條目係 skipped/failed →
--    睇 server 回嘅 reason（stale / downgrade / unauthorized / store-closed / shift-closed）。
-- ④ 若 ③ 都冇 → 嗰張單從未離開嗰部機（本地 localStorage 有、雲端完全冇）。
--
-- ⚠️ 本機孤兒單隔離（`computeOrphanLocalOrders`，2026-09-09 方案 A）：
--   判準＝「雲端 payload.orders 冇呢張單 + outbox 冇 pending ORDER_* 事件 + 單齡 ≥10 分鐘」
--   ⇒ 移入隔離區（唔刪除，可由 `/orders` 頁「同步健康」還原）。
--   🔴 只會喺**全量拉取**時跑（增量之下我加咗閘，見 state-incremental-contract.test.ts）。
