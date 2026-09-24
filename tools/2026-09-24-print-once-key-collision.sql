-- ============================================================================
-- 2026-09-24 · 列印「內容唯一鍵」撞鍵事故 —— 診斷 ＋ 即時止血
--
-- 專案：POS = `iyrywzormzisyppkokbi`（⚠️ 唔係 Ledger `zymdemjflsckicwcinxl`）
-- 執行：Supabase Dashboard → SQL Editor 貼上，**逐段**跑
--
-- ── 背景（2026-09-24 商家實案）────────────────────────────────────────────
--
-- 症狀：
--   ① 收據結帳時印唔出，打印中心狀態一直停「已發送」，唔會轉「打印成功」；
--   ② 廚房單大量重複打印；
--   ③ 打印記錄出現「空白單號」嘅 job。
--
-- 根因（代碼側同日已修，見 `src/lib/pos/print-dedupe.ts` `printOnceDbKey()`）：
--
--   `pos_print_jobs_once_key_uniq` = `unique (store_id, once_key)`，
--   而 2026-09-24 之前寫入 DB 嘅係 **client 原始 `PrintJob.onceKey`**，冇訂單身分：
--     · 自動收據 onceKey = `receipt:<reopenCount>`（`buildReceiptPrintJobs()`）
--       ⇒ 全店每一張單都係 `receipt:0`；
--     · ⇒ 全店只可能有一行 `receipt:0`，第二張自動收據 insert 即 23505；
--     · ⇒ `/api/pos/sync` 當「已出過紙」→ `ack(true)` → client 剷走事件
--       ⇒ 本地永遠「已發送」、雲端零行、**冇紙、冇紅標、唔會自我修正**。
--
-- 修法：DB 側 `once_key` 改為 `orderId|onceScope|printerId`（server 統一砌）。
--       新鍵同舊鍵**唔會互相衝突**，所以舊行唔會再攔住新出紙。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- §1 診斷：而家有邊啲鍵、邊啲係「冇訂單身分」嘅舊鍵
-- ---------------------------------------------------------------------------
select
  once_key,
  count(*)                                        as rows,
  count(distinct order_id)                        as distinct_orders,
  min(created_at at time zone 'Asia/Macau')       as first_at,
  max(created_at at time zone 'Asia/Macau')       as last_at,
  array_agg(distinct status)                      as statuses
from public.pos_print_jobs
where once_key is not null
group by once_key
order by count(*) desc, once_key
limit 50;

-- 判讀：
--   · `receipt:0` 有 1 行、而 distinct_orders = 1 ⇒ **正正係攔住所有自動收據嘅嗰一行**。
--   · 含 `|` 嘅鍵（例如 `order-abc|receipt:0|printer-22a790b1`）= 新格式（修好之後寫入）。
--   · `kitchen:normal:0:<sig>`（冇 `|`）= 舊格式。


-- ---------------------------------------------------------------------------
-- §2 診斷：今日「已結帳單」vs「自動收據 job」數量對唔對得上
-- ---------------------------------------------------------------------------
-- 正常應該大致 1:1（每張結帳單一張自動收據）。差得遠 ⇒ 自動收據一直被靜默吞掉。
select
  (select count(*) from public.pos_orders
    where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
      and status = 'settled'
      and created_at >= now() - interval '24 hours')            as settled_24h,
  (select count(*) from public.pos_print_jobs
    where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
      and printer_group = 'receipt'
      and created_at >= now() - interval '24 hours')            as receipt_jobs_24h,
  (select count(*) from public.pos_print_jobs
    where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
      and printer_group = 'receipt'
      and once_key is not null
      and created_at >= now() - interval '24 hours')            as receipt_jobs_with_key_24h;
-- 判讀：`receipt_jobs_with_key_24h = 0` ⇒ 自動路徑**從來冇成功插入過**（全部被撞落）。


-- ---------------------------------------------------------------------------
-- §3 診斷：廚房重複（同一張單 × 同一部機 × 同一類單多過一行）
-- ---------------------------------------------------------------------------
select
  order_id,
  order_no,
  printer_id,
  ticket_type,
  count(*)                                  as rows,
  count(*) filter (where once_key is null)  as unkeyed_rows,
  array_agg(id order by created_at)         as job_ids,
  array_agg(once_key order by created_at)   as keys,
  min(created_at at time zone 'Asia/Macau') as first_at
from public.pos_print_jobs
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and created_at >= now() - interval '7 days'
group by 1, 2, 3, 4
having count(*) > 1
order by count(*) desc;
-- 判讀：`rows > 1` 且 `unkeyed_rows >= 1` ⇒ 就係「一條帶鍵 + 一條 NULL」嘅重複出紙
--      （NULL 永不衝突 ⇒ 唯一索引攔唔到），同日代碼側已修（三條入隊路徑補 onceKey）。


-- ---------------------------------------------------------------------------
-- §4 診斷：空白單號 / 狀態欄位異常嘅 job
-- ---------------------------------------------------------------------------
select id, order_id, order_no, table_name, ticket_type, printer_group,
       printer_name, status, once_key, attempts, claimed_by, claimed_at, finished_at,
       created_at at time zone 'Asia/Macau' as created_macau,
       last_error
from public.pos_print_jobs
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and (order_no is null or order_id is null or status = 'printing' or status is null)
order by created_at desc
limit 50;
-- 判讀：
--   · `status = 'printing'` ⇒ 中繼機已認領未回報（**正常過渡態**）。舊 POS bundle 會將
--     佢顯示成「失敗（狀態欄位異常）」；代碼側已加 `printing` 入狀態詞彙表。
--   · `order_no is null` ⇒ 該 job 建立時就冇單號（多數係「標籤／退款／舊路徑」），
--     要連 `order_id` 一齊睇：兩個都 null 就係打印中心「空白單號」嗰種行。


-- ---------------------------------------------------------------------------
-- §5 即時止血（**只影響舊鍵，唔會刪任何單／任何出紙記錄**）
-- ---------------------------------------------------------------------------
-- 為何要做：舊行 `receipt:0` 會繼續攔住「同樣係 `receipt:0` 格式」嘅歷史殘留重推。
-- 代碼修好之後新寫入嘅鍵係 `orderId|receipt:0|printerId`，同舊鍵唔衝突 ⇒
-- **其實唔清都已經唔會再攔**；清走只係為咗令 §1 嘅診斷乾淨、以及避免舊 bundle 重推時再撞。
--
-- ⚠️ 做法：把**舊格式**鍵（不含 `|`）一次性設為 NULL：
--    · 變成 NULL 之後**唔再受唯一索引約束**（partial index `where once_key is not null`）；
--    · 冧單／出紙內容完全唔變，純粹放開去重（重複出紙風險由「代碼側本機帳本」繼續守住）；
--    · NULL 一定安全過「幾張唔同嘅單共用同一條鍵而靜默唔出紙」。
--
-- 先睇會影響幾多行：
-- select count(*) from public.pos_print_jobs
--  where once_key is not null and position('|' in once_key) = 0;
--
-- 🔴 下面嘅 UPDATE 預設**註咗解**（唔會因為貼晒成個檔就執行）。
--    代碼部署之後其實唔需要跑 —— 只有喺你想「即刻放開舊鍵」時才人手開註解跑。
--
-- begin;
--
-- update public.pos_print_jobs
--    set once_key = null
--  where once_key is not null
--    and position('|' in once_key) = 0;
--
-- commit;
--
-- 覆核（應該返 0 行）：
-- select once_key, count(*) from public.pos_print_jobs
--  where once_key is not null group by 1 having count(*) > 1;


-- ---------------------------------------------------------------------------
-- §6 驗收（代碼部署之後，落一張真單結帳）
-- ---------------------------------------------------------------------------
-- 6.1 新寫入嘅鍵一定要帶訂單身分（見到 `|` 就正確）：
-- select id, order_id, order_no, once_key, status,
--        created_at at time zone 'Asia/Macau' as created_macau
--   from public.pos_print_jobs
--  where printer_group = 'receipt'
--  order by created_at desc limit 5;
--
-- 6.2 同一日兩張單嘅自動收據**唔會**再撞（`once_key` 各自含自己嘅 order_id）：
-- select count(*) as receipt_rows, count(distinct once_key) as distinct_keys
--   from public.pos_print_jobs
--  where printer_group = 'receipt' and created_at >= now() - interval '2 hours';
--   → 兩個數字應該相等。
--
-- 6.3 Vercel log 唔應該再見到（新單）：
--   `內容唯一鍵重複 → 略過重複出紙（… once_key=receipt:0）`
--   同 Supabase log 唔應該再見到 `23505 … pos_print_jobs_once_key_uniq`（除咗真重複）。

-- ---------------------------------------------------------------------------
-- §7 回退（若果要還原去重鍵，唔會影響任何單據）
-- ---------------------------------------------------------------------------
-- 舊鍵設返 NULL 係**不可逆**（值冇備份）。如要重砌，只可以靠 `order_id` + `ticket_type`
-- 近似還原 —— 但**唔需要**：去重仲有兩層（client localStorage 帳本 ＋ 代碼側 composed 鍵）。
