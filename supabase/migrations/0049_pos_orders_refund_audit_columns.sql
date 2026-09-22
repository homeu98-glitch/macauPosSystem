-- ## ⚠️ 定位修正（2026-09-22 17:55 查證後）
--
-- **跑本 migration 只會消除 400 / ERROR log，唔會令「退貨守門豁免」真正生效。**
-- 因為查證過全 codebase：
--   · `src/lib/pos-order-row.ts` 嘅 `POS_ORDER_DB_COLUMNS`（30 欄）**完全冇** refund 相關欄；
--   · 同一檔 `pos-order-row.ts` **零個** refund 引用（mapper 冇映射）；
--   · `/api/pos/sync` 只有三處提到呢三欄：**type 宣告 / SELECT 探測 / 讀取守門**
--     —— **冇任何一處寫入**（`sync/route.ts:358 / 710 / 1083`）。
-- ⇒ 加咗欄之後佢哋會**永遠 NULL**：
--     `refundAuditColumnsAvailable` 會變 `true`（唔再 400 ✓），
--     但 `refundRecordCount(existing.refund_records)` 永遠 0 ⇒ 豁免行為同今日一樣。
--
-- ## 所以有三個選擇（本檔只提供 ①）
--
-- ① **只加欄（本檔）** —— 目的純粹係「唔好每次冷啟都撞 42703 + 400」。
-- ② **唔加欄，改為刪走探測** —— 更誠實（承認呢三欄冇用），但要改 code；
--    原註釋刻意保留探測係為咗「將來加欄就自動生效」，所以唔應該單方面刪。
-- ③ **真修功能（退款審計）** —— 要三處一齊改：
--    (a) 本 migration 加欄；
--    (b) `pos-order-row.ts` 補映射 + 加入 `POS_ORDER_DB_COLUMNS`
--        （🔴 記住「加 `pos_orders` 欄位要改四條讀取路徑」，見 docs/113）；
--    (c) `/api/pos/sync` 寫入路徑補 `refund_records / refunded_amount / voided_items`。
--
-- 🔴 記住：**唔可以**只做 (a) 就當「退款守門修好」—— 咁樣係一個綠燈但空嘅修復。

-- ============================================================================
-- 0049 · 補 `pos_orders` 三個「退款審計」欄位（消除每次冷啟嘅 42703 / 400）
-- ============================================================================
--
-- ## 為何要
--
-- `src/app/api/pos/sync/route.ts` 嘅「預取現有訂單」會帶三個審計欄：
--   `refund_records`（jsonb）、`refunded_amount`（numeric）、`voided_items`（jsonb）
--
-- 🔴 但**冇任何 migration 建過呢三個欄**（grep 全 `supabase/migrations/*.sql` 零命中）
-- ⇒ PostgREST 回 `42703 column pos_orders.refund_records does not exist` ＋ `400`。
--
-- 現時靠 route 內嘅「**試一次、記住結果**」per-instance 快取
-- （`refundAuditColumnsAvailable`，見 `sync-route-refund-columns.test.ts`）繞過去：
-- **每個新 Vercel instance 冷啟時仍會試一次** ⇒ log 每次仍然見到少量 400。
--
-- 實測（2026-09-22 14:17–17:29）：4 次（14:45、14:53、15:09、17:46…）＝ 每約 8–16 分鐘一次，
-- 屬性係「低頻、無害、但唔乾淨」。跑完本 migration 之後永久消失，
-- 而守門邏輯會自動變成 `refundAuditColumnsAvailable = true`（唔需要改 code）。
--
-- ## 安全性
--
-- · `add column if not exists` ＝ idempotent，重跑無害；
-- · 現有 row 新欄一律 NULL；`refundRecordCount()` 對 null 回 0，
--   `voidedItems` 讀取位有 `Array.isArray` 守門 ⇒ **行為不變**（唔會令任何單變成「有退款」）；
-- · 純加欄，唔改任何既有欄位、唔改 RLS、唔改 policy ⇒ 對 POS／報表零影響。
--
-- ## 跑完要
--
-- PostgREST schema cache 需要 reload（下面 `pg_notify` 或 Dashboard → API → Schema cache → Reload）。
-- 唔 reload 會繼續見到 `column ... in the schema cache`。

alter table public.pos_orders add column if not exists refund_records  jsonb;
alter table public.pos_orders add column if not exists refunded_amount numeric;
alter table public.pos_orders add column if not exists voided_items    jsonb;

-- ── 刷新 PostgREST schema cache（同 0012 檔尾同一招）──────────────────────
select pg_notify('pgrst', 'reload schema');

-- ============================================================================
-- 驗收
-- ============================================================================
--
-- 1. 三欄都在
--   select column_name, data_type from information_schema.columns
--    where table_name = 'pos_orders'
--      and column_name in ('refund_records','refunded_amount','voided_items');
--   → 3 行
--
-- 2. 唔會有人「突然變成有退款」
--   select count(*) from public.pos_orders where refund_records is not null;   → 0
--
-- 3. 之後 Supabase log 唔應該再出現
--   `column pos_orders.refund_records does not exist`
