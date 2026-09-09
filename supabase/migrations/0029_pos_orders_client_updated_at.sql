-- 0029: pos_orders.client_updated_at —— 方案 B「server 時間為 LWW 貨幣」嘅前置欄位
--
-- 背景（2026-09-09 桌台回退根因分析）：
--   舊設計成條同步鏈路用 **client 裝置時鐘** 做 `pos_orders.updated_at`，
--   所有 LWW 比較（client merge、server 守門）都係兩個裝置時鐘互毆 ——
--   裝置時鐘偏差會令「已結帳」被「未結帳」snapshot 覆蓋。
--
--   方案 B 之後：
--     - `updated_at`  = **server 收件時間**（Vercel/DB 時鐘，單一鐘域；
--                       /api/pos/sync 寫入時一律 now()）；
--     - `client_updated_at` = client 裝置時鐘時間戳（事件 payload 嘅 order.updatedAt /
--                       事件 createdAt），專供 LWW 守門做**同鐘域**比較。
--   `created_at` 維持 client 時間（首次建立）—— 訂單排序（先落單先做）
--   同報表「下單日」口徑都靠佢，唔可以俾補傳時間蓋走。
--
-- Backfill：現存 row 嘅 updated_at 本來就係 client 蓋章，直接抄過去做
-- client_updated_at，令舊 row 嘅 LWW 比較語義不變。

alter table pos_orders add column if not exists client_updated_at timestamptz;

update pos_orders
set client_updated_at = updated_at
where client_updated_at is null;

comment on column pos_orders.client_updated_at is
  'Client device-clock timestamp written by /api/pos/sync (Plan B 0029). LWW guard compares this column (same clock domain as incoming events); pos_orders.updated_at is always server-stamped receipt time.';
