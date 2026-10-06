-- ═══════════════════════════════════════════════════════════════════════════
-- expenseRecorder · `receipt_items.quantity_unit` 新增欄位
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ 呢支 SQL **唔係** macauPos repo 嘅 migration —— 要貼去 **expenseRecorder**
--    嘅 Supabase 專案跑（project ref `fjvfvpedklhdenavbcjg`）。
--
-- 【為何要跑】
--   POS 報表頁「買貨明細」要顯示貨品單位（kg／包／罐…）。POS 側
--   `/api/inventory/receipts` 已經改成**有該欄就讀／寫，冇就優雅降級**
--   （見 `src/app/api/inventory/receipts/route.ts`）。但要有真實單位，
--   必須喺 expenseRecorder 補呢一欄。
--
-- 【為何係人手 ALTER 而唔係 repo migration】
--   `receipt_items` 屬 expenseRecorder 專案，其 schema 一向靠人手 ALTER 維護
--   （先例：`receipt_items.user_id` 都唔喺任何現存 SQL 檔，見 macauPos
--    `docs/151-inventory-ux-5items-payment-master.md` §5）。本檔只作**記錄用**，
--   唔會自動執行；跑完之後請保存返喺 expenseRecorder 專案文件內。
--
-- 【影響評估】
--   · additive only（加一欄、nullable、有 default '')）⇒ **唔會**影響現有資料、
--     唔會鎖表、唔會改任何現有查詢語意。
--   · 現有 row 一律得到空字串 `''`（＝「未知單位」），POS 端會顯示為「只有數量、無單位」。
--   · 唔可以填假單位（例如「個」）—— 寧願留空，由商家日後補錄。
--
-- 【idempotent】可重複跑，第二次起會是 no-op。
-- ═══════════════════════════════════════════════════════════════════════════

-- ── ① 加欄（nullable + default ''，additive only）──────────────────────────
alter table public.receipt_items
  add column if not exists quantity_unit text not null default '';

comment on column public.receipt_items.quantity_unit is
  '貨品單位（kg／包／罐／盒…）。2026-10-06 由 POS 側需求新增；空字串 = 未記錄單位（唔代表「個」）。';

-- ── ② 防止無意義空白 ────────────────────────────────────────────────────
-- 只 trim 前後空白；唔做格式限制（單位係自由文字，例如「kg」「包」「1箱」）。
update public.receipt_items
  set quantity_unit = btrim(quantity_unit)
  where quantity_unit <> btrim(quantity_unit);

-- ── ③ 通知 PostgREST 刷新 schema cache ───────────────────────────────────
-- ⚠️ Supabase 通常會自動偵測；若 POS 側仍然報「column does not exist」，
--    去 Dashboard → Settings → API → 「Reload schema cache」撳一下，
--    或等最多約 1 分鐘自動生效。
notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 驗收（跑完逐條檢查；全部唯讀）
-- ═══════════════════════════════════════════════════════════════════════════
-- ① 欄位已存在、型別正確、nullable、有 default
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'receipt_items'
--   order by ordinal_position;
--   → 應見到 quantity_unit | text | NO | ''::text
--
-- ② 現有資料冇被破壞（總行數不變、單位一律空字串）
--   select count(*) as total,
--          count(*) filter (where quantity_unit = '') as blank_unit
--   from public.receipt_items;
--   → total 同加欄前一樣；blank_unit = total（未有商家補錄之前）
--
-- ③ 抽樣睇貨品清單（跑完 POS 手動入一張有單位嘅收據後）
--   select name, quantity, quantity_unit, unit_price
--   from public.receipt_items
--   where quantity_unit <> ''
--   order by created_at desc limit 20;
--   → 應見到 kg／包／罐 等真實單位
-- ═══════════════════════════════════════════════════════════════════════════
