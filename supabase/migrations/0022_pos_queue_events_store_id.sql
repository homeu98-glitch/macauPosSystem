-- 0022 · pos_queue_events.store_id（同步隊列跨店隔離）
-- 對應 docs/pos-cross-store-isolation-fix-plan.md。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 背景（2026-09-06 跨店串號事故 root cause）
-- ─────────────────────────────────────────────────────────────────────────────
-- `pos_queue_events` 一直冇 `store_id` 欄（information_schema 可證：
-- 只有 id / type / entity_id / payload / status / created_at）。
-- `pos_orders.store_id` 嘅唯一來源係 flush 請求級 storeId（= 當前登入 merchant），
-- queue 事件本身零店鋪資訊 → 邊間店嘅單完全由「flush 嗰刻邊個帳號登入」決定。
--
-- 污染鏈：
--   1. /api/pos/state（非 ordersOnly）queue 查詢唔過濾店 → 返全店最新 300 條事件；
--   2. pos-app loadRuntimeState() 將全店事件 merge 入當前店本地 queue；
--   3. sync flush（含 legacy-heal 全量重推）用當前登入 merchantId 做 storeId；
--   4. /api/pos/sync ORDER_CREATED/ORDER_UPDATED upsert(onConflict:id) 全行覆寫
--      `store_id = 請求級 storeId` → 外店訂單被永久「蓋章」搬去當前店。
--
-- 修復（防禦縱深，本 migration 係第 1 層）：
--   L1  本 migration：queue 表加 store_id，事件由 client 喺產生嗰刻 stamp（withStoreScope）；
--   L2  /api/pos/state：queue 查詢改 `eq("store_id", storeId)`，冇 storeId 返空；
--   L3  loadRuntimeState merge：skip 外店事件；
--   L4  doFlush / syncNow / shift-page 直接 flush 路徑：只推 storeId === 當前店嘅事件；
--   L5  /api/pos/sync：event.storeId 與請求 storeId 唔一致 → 拒收（400）。
--
-- 歷史行 store_id 為 NULL（queue 從未記錄歸屬，冇得回填）：
--   - 讀取端：`eq("store_id", ...)` 天然排除 NULL 行 → 唔會再派發畀任何店（fail-safe）；
--   - 寫入端：新事件一律帶 storeId；NULL legacy 事件喺 client flush 閘口被跳過，唔會再被重推。
--
-- 冇 drop 任何嘢，`if not exists` 守門，可重複執行。
-- ============================================================================

-- ============================================================================
-- 1) 加欄位
--    text、可 NULL（歷史行冇歸屬資訊，寧願 NULL 都唔好亂歸屬 —— 亂歸屬正正係今次 bug）。
-- ============================================================================
alter table pos_queue_events add column if not exists store_id text;

comment on column pos_queue_events.store_id is
  '事件所屬店舖（= client 產生事件嗰刻嘅 resolveStoreId()：登入 merchant 或 kiosk 綁定店）。'
  '跨店隔離真源：/api/pos/state 按 store 過濾、/api/pos/sync 驗證 event.storeId === 請求 storeId。'
  '歷史行為 NULL（加欄前從未記錄），讀取端 eq 過濾天然排除，唔會派發畀任何店。';


-- ============================================================================
-- 2) 索引
--    /api/pos/state 每次開收銀台都按 store_id 撈最新 300 條 queue 事件（熱路徑）。
-- ============================================================================
create index if not exists pos_queue_events_store_created_idx
  on pos_queue_events (store_id, created_at desc);


-- ============================================================================
-- 3) 驗收
-- ============================================================================
--
-- 3.1 欄位存在
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema='public' and table_name='pos_queue_events';
--   → 應見 store_id / text / YES
--
-- 3.2 新事件帶店（部署新 client 落一張單後）
--   select store_id, type, count(*)
--   from pos_queue_events
--   where created_at > now() - interval '10 minutes'
--   group by store_id, type;
--   → 新事件嘅 store_id 應等於落單店；歷史行仍係 NULL（預期）
--
-- 3.3 隔離生效（切換帳號登入另一間店後，等 30s flush tick）
--   select count(*) from pos_orders
--   where store_id = '<B店merchantId>'
--     and id in (select entity_id from pos_queue_events where store_id = '<A店merchantId>');
--   → 應該係 0（A 店事件唔會再以 B 店身份寫入 pos_orders）
-- ============================================================================
