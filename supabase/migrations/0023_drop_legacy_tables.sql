-- 0023: 清理历史遗留表（无代码引用、无 migration 创建）
-- 来源：docs/database-review-2026-09-06.md §2 / §3
--   - online_orders / online_order_items / online_order_settings / online_order_status_logs
--     早期 POS 自存的线上订单，已被 Ledger `orders` + `pos_online_order_settings` 取代。
--   - pos_members / pos_member_coupons
--     早期 POS 本地 mock 会员，已被 Ledger RPC（merchant_lookup_customer_wallet 等）取代；
--     `/api/members` 已返回 410 GONE，会员 PII 明确禁止写入 POS DB。
--
-- 这些表不在任何现存代码路径中（全 repo grep 确认），且互相之间若有 FK 也一并 CASCADE 清除。
-- 用 IF EXISTS 保证重跑幂等；生产执行前建议先用该审查报告的 §6 查询核对 row count 并备份。

drop table if exists online_order_items cascade;
drop table if exists online_orders cascade;
drop table if exists online_order_status_logs cascade;
drop table if exists online_order_settings cascade;

drop table if exists pos_member_coupons cascade;
drop table if exists pos_members cascade;
