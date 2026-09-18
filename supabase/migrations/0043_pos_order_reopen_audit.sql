-- 0043 · 訂單返結審計欄位（返結 / 反結賬）
--
-- 背景（2026-09-18 表嫂美食實案）：
--   收銀對張單撳「返結」→ 改內容 → 重新結帳。呢個流程本身冇問題，但**審計痕跡一欄都冇上雲**：
--   `reopenCount` / `reopenedAt` / `reopenReason` 只存喺 client 端 localStorage，
--   `/api/pos/sync` 嘅 `baseRecord`（逐欄顯式複製）根本冇抄呢三欄，DB 亦冇對應直欄。
--
--   後果：
--     ① 「已返結」標籤做唔到 —— 報表同交班**讀雲端**（`pos_orders` 為唯一可信源），
--        雲端冇 `reopen_count` ⇒ 標籤永遠唔會出現喺報表 / 交班明細；
--     ② 對帳斷鏈 —— 換機 / 清 cache 之後，由 server state reload 完全睇唔出
--        「呢張單被人返結改過」，而金額卻係返結後嘅（改動冇痕跡，數字有變）。
--
--   ⚠️ 修法同 0038 一模一樣：**加欄 + 加落 `baseRecord`**，
--      唔係「改 RLS / 改權限」—— 根本冇抄呢幾欄，唔係被擋。
--
-- 三欄：
--   1) reopen_count   —— 累計返結次數（**單調遞增**，重結唔清零）
--   2) reopened_at    —— 最近一次返結時間
--   3) reopen_reason  —— 最近一次返結原因（來自 設置 → 返結原因，或自填）
--
-- 🔴 為何 `reopen_count` 要**單調遞增、重結後唔清零**：
--   「返結過」係**歷史事實**，唔係當前狀態。收銀 / 對帳要知「呢張單被人改過」，
--   所以審計痕跡唔應該隨重結抹走 —— 呢個正正係「已返結 ×N」標籤永久保留嘅依據
--   （見 `src/lib/pos/reopen-badge.ts`）。
--
-- ⚠️ additive + 全部 if not exists + default：舊行唔會壞，舊 client（唔識呢三欄）照跑。
--    未跑之前 route 會 42703 fallback（同 0034 / 0038 一樣嘅降級寫法），
--    即係「標籤暫時唔顯示」，但**落單 / 結帳主流程完全唔受影響**。

-- ── pos_orders：返結審計 ──
alter table public.pos_orders
  add column if not exists reopen_count integer not null default 0,
  add column if not exists reopened_at timestamptz,
  add column if not exists reopen_reason text;

comment on column public.pos_orders.reopen_count is
  '累計返結（反結賬）次數。單調遞增，重新結帳後**唔清零** —— 「返結過」係歷史事實。> 0 時前端出「已返結 ×N」標籤。0 = 從未返結。';

comment on column public.pos_orders.reopened_at is
  '最近一次返結時間（ISO timestamp）。重結後保留（唔清），供對帳追溯「幾時改過」。非返結單為 NULL。';

comment on column public.pos_orders.reopen_reason is
  '最近一次返結原因（來自 設置 → 返結原因 清單，或收銀自填）。重結後保留。非返結單為 NULL。';

-- 追溯用索引：只索引有返結過嘅行（同 0018 comp_note / 0034 discount_note 一致）
create index if not exists pos_orders_reopen_count_idx
  on public.pos_orders (store_id, created_at desc)
  where reopen_count > 0;

-- ── 驗證（手動跑） ──
-- 1) 欄位存在 + 型別
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'pos_orders'
--     and column_name in ('reopen_count', 'reopened_at', 'reopen_reason');
--   → reopen_count  / integer                  / NO  / 0
--   → reopened_at   / timestamp with time zone / YES / NULL
--   → reopen_reason / text                     / YES / NULL
--
-- 2) 🔴 最關鍵嘅一步：跑完 migration **同**部署新程式碼之後，
--    去 App 對一張已經返結過嘅單（例如「訂單02」）做一次操作，
--    再查雲端有冇真係寫到：
--   select local_order_no, status, total, reopen_count, reopened_at, reopen_reason
--   from pos_orders
--   where reopen_count > 0
--   order by created_at desc
--   limit 20;
--   → 應該見到返結過嘅單帶住次數同原因。
--
-- 3) 按原因埋數（管理層：邊個原因改咗幾多單）
--   select reopen_reason,
--          count(*)        as orders,
--          sum(reopen_count) as total_reopens,
--          sum(total)      as net_total
--   from pos_orders
--   where reopen_count > 0
--     and created_at >= now() - interval '30 days'
--   group by reopen_reason
--   order by total_reopens desc;
