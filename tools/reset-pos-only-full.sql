-- =============================================================================
-- macauPos POS-only FULL RESET
-- =============================================================================
-- 用途: 清空 POS 离线部分 (pos_orders / pos_queue_events / 周边事件表) 全部行,
--       准备俾新代码 (0022 migration + withStoreScope + filterEventsForCurrentStore)
--       由空白开始干净跑。
--
-- ⚠️ 极度危险 — 务必做齐以下步骤:
--   1. ⚠️ 确认目标 DB (POS 独立 schema, 唔系 Ledger 共享 DB)
--   2. ⚠️ 备份: pg_dump 至少导出目标 schema / 重要 table 嘅数据
--   3. ⚠️ 通知所有 POS 操作员停用 Kiosk / Admin 一阵
--   4. ⚠️ 4 只眼: 第二个人核对 commit 嘅 SQL 同受影响 row count
--   5. ⚠️ RESET 之后, 部署新 client 代码, 等新代码先开 flush
--
-- ❌ 唔会动 Ledger 表格: merchants / staff_accounts / topup_transactions /
--    order_records / deduct_transactions / member_* / 等 (Ledger schema 由
--    RPC 同 RLS 保护, 本脚本唔触及)
--
-- ❌ 唔会动 schema (schema / table / column / index / RLS / trigger 全部保留)
--    如果想连 schema 都重置, 用 supabase/migrations/00XX_drop_pos_tables_for_full_reset.sql
--    (本脚本唔包含 — DROP TABLE 系更危险嘅操作, 需另外审阅)
--
-- 📌 依赖: 0022_pos_queue_events_store_id.sql 必须已跑过 (store_id 字段已存在)
-- =============================================================================

-- 0. 安全闸 — 先 preview count, 确认数量同你预期一致
-- 0.1 POS 表 row counts (reset 前快照)
select 'pos_orders' as table_name, count(*) as row_count
  from pos_orders
union all
select 'pos_queue_events', count(*)
  from pos_queue_events
union all
select 'pos_order_items', count(*)
  from pos_order_items
union all
select 'pos_order_payments', count(*)
  from pos_order_payments
union all
select 'pos_shift_sessions', count(*)
  from pos_shift_sessions
union all
select 'pos_shift_events', count(*)
  from pos_shift_events
union all
select 'pos_refunds', count(*)
  from pos_refunds
union all
select 'print_jobs', count(*)
  from print_jobs
union all
select 'pos_table_sessions', count(*)
  from pos_table_sessions
union all
select 'pos_kitchen_tickets', count(*)
  from pos_kitchen_tickets;

-- 0.2 Ledger 表 row counts (验证 — 应该唔会变)
select 'merchants (Ledger, should be unchanged after reset)' as marker,
       count(*) as row_count
  from merchants
union all
select 'staff_accounts (Ledger, should be unchanged)', count(*)
  from staff_accounts;

-- =============================================================================
-- 1. 真 RESET (transactional — 全成功或全 rollback)
-- =============================================================================

begin;

  -- 1.1 顺序: 由 leaf table (FK target) 到 root, 避免 FK constraint violation
  --    每个 DELETE 都打印 affected rows, 万一出错都追到

  -- 子表 / 事件表先清 (通常无 FK, 但顺序安全)
  delete from pos_kitchen_tickets;
  delete from pos_refunds;
  delete from pos_table_sessions;
  delete from pos_shift_events;
  delete from print_jobs;

  -- 1.2 父表 shift sessions (如果存在子表 FK)
  delete from pos_shift_sessions;

  -- 1.3 pos_orders 系列 (下面呢个 join delete 处理子表)
  --    (a) pos_order_payments / pos_order_items 通常 FK 到 pos_orders.id
  delete from pos_order_payments;
  delete from pos_order_items;

  --    (b) 主表 pos_orders (包括 onlineOrderId != null 嘅同步单)
  --        如果 pos_orders 有 FK -> staff / members 等, 唔受影响 (Ledger 那边的表唔会清)
  delete from pos_orders;

  -- 1.4 最后清 queue (0022 migration 加咗 store_id, 全 DELETE 不影响 schema)
  delete from pos_queue_events;

  -- 1.5 验证 — 应该全部 0
  select 'pos_orders' as table_name, count(*) as remaining
    from pos_orders
  union all
  select 'pos_queue_events', count(*) from pos_queue_events
  union all
  select 'pos_order_items', count(*) from pos_order_items
  union all
  select 'pos_order_payments', count(*) from pos_order_payments
  union all
  select 'pos_shift_sessions', count(*) from pos_shift_sessions
  union all
  select 'pos_shift_events', count(*) from pos_shift_events
  union all
  select 'pos_refunds', count(*) from pos_refunds
  union all
  select 'print_jobs', count(*) from print_jobs
  union all
  select 'pos_table_sessions', count(*) from pos_table_sessions
  union all
  select 'pos_kitchen_tickets', count(*) from pos_kitchen_tickets;

-- 1.6 ⚠️ 在 Supabase SQL editor 上面, 检查上面 1.5 输出嘅 remaining 全部 = 0
--     如果有问题, 用 ROLLBACK; 取消下面 COMMIT
rollback;
-- commit;

-- =============================================================================
-- 2. Reset 完之后要做嘅嘢
-- =============================================================================
-- ✅ Step A: 跑 0022_pos_queue_events_store_id.sql (如果未跑) — 加 store_id
-- ✅ Step B: 部署新 client 代码 (有 withStoreScope + filterEventsForCurrentStore)
-- ✅ Step C: 喺浏览器 / Kiosk 强制 hard refresh, localStorage 清返空 queue
-- ✅ Step D: 第一次落单 / 结账, 触发 queue write, 验证:
--            - pos_queue_events.store_id 有值
--            - pos_orders.store_id 系新 store merchantId
--            - 另一台机 (另一 store) 唔会见到呢张单
-- ✅ Step E: 检查 Supabase Realtime — pos_orders subscription 正常 fire
--
-- =============================================================================
-- 3. (可选) 如果你想连客户端 localStorage 一并清, 喺 Kiosk / Admin 浏览器:
-- =============================================================================
--   localStorage.removeItem('pos-queue-v1');        -- 旧版 queue key
--   localStorage.removeItem('pos-queue-v2');        -- 新版 queue key (如果有)
--   localStorage.removeItem('pos-flush-state');     -- flush state cache
--   localStorage.removeItem('macau-pos-kiosk-device');
--   location.reload();
-- 或 DevTools → Application → Clear storage

-- =============================================================================
-- 4. (可选) Schema 级全 DROP + 重建 — 极度危险, 唔推荐
-- =============================================================================
-- 如果你想由 0001 migration 开始重跑 (例如想清所有 RLS / trigger 重做):
--
-- begin;
--   drop table if exists pos_kitchen_tickets cascade;
--   drop table if exists pos_refunds cascade;
--   drop table if exists pos_table_sessions cascade;
--   drop table if exists pos_shift_events cascade;
--   drop table if exists pos_shift_sessions cascade;
--   drop table if exists print_jobs cascade;
--   drop table if exists pos_order_payments cascade;
--   drop table if exists pos_order_items cascade;
--   drop table if exists pos_orders cascade;
--   drop table if exists pos_queue_events cascade;
--   -- 删埋我哋嘅 triggers / functions (如果有)
--   -- drop function if exists pos_queue_dispatch() cascade;
--   -- drop function if exists pos_orders_after_insert() cascade;
-- commit;
--
-- -- 然后由 supabase db reset / 重新跑 supabase db push 都得
-- -- ⚠️ DROP CASCADE 会自动删所有依赖 (RLS policy / view / trigger)
-- -- ⚠️ 跑完之后要重新跑 0001..0022 所有 migration
--
-- =============================================================================
-- 5. 关于 pos_orders.online_order_id != null 嘅同步单 (留意)
-- =============================================================================
-- 本脚本会一并清 pos_orders 里面所有 row, 包括有 onlineOrderId (从 Ledger
-- 同步落 POS 本地嗰啲) 嘅 row。
--
-- 如果你想保留呢部分数据 (例如想睇返 Ledger 历史同步咗咩落 POS):
--   跳过 1.3 嘅 "delete from pos_orders" 改成:
--
--   delete from pos_orders
--    where online_order_id is null   -- 只清本地创建单
--       or created_by <> 'ledger-sync'  -- 只清非同步来源
--   ;
--
-- ⚠️ 但呢条 SQL 会留低污染行 (因为污染正好来自 onlineOrderId 嘅 sync 路径
--    或者 storeId 被覆写), 隔离效果唔彻底。**建议默认全部清** — 干净状态先
--    验证 cross-store 隔离, 之后用真单测试再写。
--
-- =============================================================================
-- 6. 如果 reset 途中出错
-- =============================================================================
-- 上面的整个 block 包喺 begin; ... rollback; 里, 真失败你只需要:
--   rollback;
-- 任何一步 DELETE 报 FK violation / permission denied, 表都唔会改.
-- 重 check 之前嘅 Section 0 输出, 看看 FK graph 有冇遗漏.
