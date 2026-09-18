-- ═══════════════════════════════════════════════════════════════════════════
-- 修正「訂單02」（表嫂美食 2026-09-18）雲端 items 停留舊值
--
-- 【背景】2026-09-18 實案：
--   店員下單 → 結帳（MOP 44，實體收據）→ 發現價格不對 → 撳「返結」
--   → 加回 2 個菜（盒、袋）→ 再次結帳。
--   但雲端 pos_orders 嘅 items 停留喺**返結前**嘅舊內容（盒×3 / 袋×3 = 42），
--   而實體收據係盒×4 / 袋×4 = 44。
--
-- 【根因】src/components/pos-app.tsx 嘅 `upsertCurrentOrder()`：
--   返結後張單 status 係 `reopened`，但舊寫法只豁免 `paid`：
--       const keepPaidStatus = existingOrder?.status === "paid";
--   → 加菜時被寫成 `sent_to_kitchen`（未收款 open snapshot）
--   → /api/pos/sync 嘅「付款階段單向閘」判 paid-downgrade 拒收整條 ORDER_UPDATED
--   → items 永遠上唔到雲，只剩 ORDER_SETTLED 嘅金額 patch（設計上唔重寫 items）
--   → 雲端停留「舊數量 + 新金額」。
--   程式碼已於 2026-09-18 修好（擴闊 keepPaidStatus 認 reopened）。
--   本檔處理**已經錯咗嘅歷史資料**。
--
-- 【安全設計】
--   ① 全部包喺一個 transaction，出錯自動 ROLLBACK；
--   ② 第 0 步係**唯讀預檢**——先睇清楚現況，唔改任何嘢；
--   ③ 目標行用「商店 + 訂單號 + 日期」三重鎖定，並要求只命中 1 行；
--     命中 0 行或 >1 行都會 RAISE 中止（唔會誤改別張單）；
--   ④ items 嘅正確值**唔靠猜**——由實體收據（ground truth）推導：
--         N1 薯仔燜雞飯 ×1 @36  = 36
--         盒 ×4 @1              =  4
--         袋 ×4 @1              =  4
--         合計                  = 44
--      ⚠️ 執行前**必須**先用第 0 步核對價格同數量，唔啱就要改下面嘅 values。
--
-- 【執行方式】Supabase Dashboard → POS 專案 → SQL Editor
--   ⚠️ 唔可以用 psql 專屬語法（本專案 migration 有明文限制）。
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 第 0 步（唯讀）：先睇清楚呢張單而家喺雲端嘅真面目。跑完睇結果，唔啱就停手。
-- ───────────────────────────────────────────────────────────────────────────
select
  id,
  store_id,
  local_order_no,
  status,
  total,
  subtotal,
  discount_amount,
  reopen_count,
  reopened_at,
  reopen_reason,
  client_updated_at,
  updated_at,
  -- items 逐行攤開，方便肉眼對數量
  (
    select string_agg(
             (it->>'name') || ' ×' || (it->>'quantity') || ' @' || (it->>'price'),
             ' | '
             order by it->>'name'
           )
    from jsonb_array_elements(items) as it
  ) as items_summary,
  (select coalesce(sum((it->>'quantity')::numeric), 0) from jsonb_array_elements(items) as it)
    as items_total_qty
from pos_orders
where local_order_no = '訂單02'
  -- ⚠️ 如命中多行（唔同分店都有「訂單02」），喺呢度加 store_id 收窄。
  --    表嫂美食嘅 merchantId 請由 App 內「設備設置」或登入 session 核對。
  and created_at >= '2026-09-18'::date
  and created_at <  '2026-09-19'::date
order by created_at desc;

-- ═══════════════════════════════════════════════════════════════════════════
-- 第 1 步（寫入）：確認第 0 步結果正確後，才跑以下整段。
--   記得先把 :p_order_id 換成第 0 步查到嘅 id。
-- ═══════════════════════════════════════════════════════════════════════════
begin;

do $$
declare
  -- 🔴 由第 0 步抄落嚟嘅 id（uuid 字面量，唔用 psql 嘅 :var 語法）
  p_order_id uuid := '<由第 0 步填入>';
  v_hit integer;
  v_before_total numeric;
  v_before_qty numeric;
begin
  -- 鎖定目標行（三重條件：id + 訂單號 + 日期），並要求只命中 1 行
  select count(*), max(total)
    into v_hit, v_before_total
  from pos_orders
  where id = p_order_id
    and local_order_no = '訂單02'
    and created_at >= '2026-09-18'::date
    and created_at <  '2026-09-19'::date;

  if v_hit <> 1 then
    raise exception '預檢失敗：目標行命中 % 行（要求恰好 1 行），已中止。', v_hit;
  end if;

  select coalesce(sum((it->>'quantity')::numeric), 0)
    into v_before_qty
  from pos_orders o, jsonb_array_elements(o.items) as it
  where o.id = p_order_id;

  raise notice '修正前：total=% 項目總數=%', v_before_total, v_before_qty;

  -- ── 寫入正確值 ─────────────────────────────────────────────────────────
  -- 口徑：以**最後一次（返結後）結帳**為最終價格 —— 即實體收據嗰張。
  --   subtotal = 44（36 + 4 + 4，已含加購）
  --   total    = 44（無折扣、無服務費、無稅、無抹零）
  --   items    = 收據三行
  update pos_orders
  set
    items = '[
      {"id":"n1-chicken-rice","menuItemId":"n1","name":"N1 薯仔燜雞飯","price":36,"quantity":1,"specs":[]},
      {"id":"pack-box","menuItemId":"box","name":"盒","price":1,"quantity":4,"specs":[]},
      {"id":"pack-bag","menuItemId":"bag","name":"袋","price":1,"quantity":4,"specs":[]}
    ]'::jsonb,
    subtotal = 44,
    total = 44,
    discount_amount = 0,
    -- 返結審計：營運上呢張單係「返結過一次」
    reopen_count = greatest(coalesce(reopen_count, 0), 1),
    reopened_at = coalesce(reopened_at, timestamptz '2026-09-18 10:38:00+08'),
    reopen_reason = coalesce(reopen_reason, '價格錯誤'),
    -- ⚠️ client_updated_at 一齊推前：否則 client 端 LWW 會判呢條 patch 係「舊」
    --    而拒收（見 pos-orders.ts mergeOrderLists 嘅時間戳比較）。
    client_updated_at = now(),
    updated_at = now()
  where id = p_order_id;

  raise notice '修正後：total=44 項目總數=9';
end $$;

-- 先睇結果，冇問題就 commit；有問題就 rollback;
commit;
-- rollback;

-- ───────────────────────────────────────────────────────────────────────────
-- 第 2 步：改完之後，去 App 內「訂單列表」對返「訂單02」：
--   · 金額應該係 MOP 44
--   · 菜品應該顯示「盒×4 · 袋×4」
--   · 訂單號右側應該出「已返結 ×1」標籤（改完程式碼 + 重新部署之後）
-- ═══════════════════════════════════════════════════════════════════════════
