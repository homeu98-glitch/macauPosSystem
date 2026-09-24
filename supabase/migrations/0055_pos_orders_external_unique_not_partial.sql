-- 0055_pos_orders_external_unique_not_partial.sql
--
-- 目的：修正 0054 建嘅 `pos_orders_external_unique` 索引，令佢可以畀
--       PostgREST 嘅 `ON CONFLICT` 用。
--
-- ── 問題（實際踩到）──────────────────────────────────────────────────
--   0054 建嘅索引帶咗 `WHERE external_order_id IS NOT NULL` —— 即係一個
--   **部分索引（partial index）**。
--
--   🔴 PostgreSQL 嘅 `ON CONFLICT (欄位…)` **推斷唔到部分索引**：
--      要推斷到，語句本身要帶埋同樣嘅 `WHERE` 條件。
--      而 PostgREST 嘅 `on_conflict` 只傳欄位名（`store_id,source,external_order_id`），
--      帶唔到 predicate ⇒ 直接報
--        "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--      （route 會以 HTTP 500 回報）
--
-- ── 為什麼可以直接去掉 WHERE（安全性）───────────────────────────────
--   PostgreSQL 嘅唯一索引**預設將 NULL 視為互不相同**：
--   兩列只要有任何一個索引欄位係 NULL，就唔會被判定為重複。
--   ⇒ 現有店內單（`external_order_id` 全部係 NULL）**本來就唔會互相衝突**，
--     個 `WHERE` 由頭到尾都係多餘嘅，反而破壞咗 ON CONFLICT。
--
--   唯一性真正需要生效嘅情況係「有外部單號」嗰陣 ——
--   而嗰陣 `external_order_id` 非 NULL，正常參與唯一性檢查 ✓
--
-- ── 影響 ────────────────────────────────────────────────────────────
--   · 純索引替換，唔改任何欄位、唔改資料
--   · 現有列（全 NULL）仍然唔會衝突
--   · route 嘅 `onConflict: "store_id,source,external_order_id"` 之後就對得上

drop index if exists pos_orders_external_unique;

create unique index if not exists pos_orders_external_unique
  on pos_orders (store_id, source, external_order_id);

comment on index pos_orders_external_unique is
  '外部單冪等鍵（store_id + source + external_order_id）。⚠️ 唔可以改成部分索引（帶 WHERE）—— PostgREST 嘅 ON CONFLICT 推斷唔到，會報 "no unique or exclusion constraint matching the ON CONFLICT specification"。NULL 在唯一索引預設互不相同，所以店內單（external_order_id 全 NULL）唔會衝突。見 migration 0055。';
