-- 0054_pos_orders_external_source.sql
--
-- 目的：讓 `pos_orders` 可以承載「外賣平台單」（澳覓 / MFOOD），
--       由瀏覽器插件（Transaction Grabber）推送入嚟。
--
-- ── 🔴 零影響原則（本次硬約束：唔可以影響現有功能）─────────────────────
--   · 全部係「加法」：ADD COLUMN / 放寬 CHECK / 加 partial index
--   · 現有列（source ∈ {pos,kiosk,scan}）一律不受影響 —— 舊集合 ⊂ 新集合
--   · 新欄位一律 nullable、**冇 DEFAULT** → 現有寫入路徑（/api/pos/sync 等）
--     一個字都唔使改，INSERT 唔會因為新欄位而失敗
--   · partial unique index 只覆蓋 `external_order_id IS NOT NULL`
--     → 現有列（全部 NULL）根本唔入索引，零成本、零衝突
--   · 加 index 用 `if not exists`；DROP CONSTRAINT 有 exists 守衛 → 可重複執行
--
-- ── 為什麼 unique index 要帶 store_id ────────────────────────────────
--   本專案反覆強調「必須按 store_id 隔離」（見 docs/52）；外部單冪等鍵
--   亦唔例外。同一平台單號理論上只屬一間店，但用 store_id 入鍵係零成本
--   嘅保險，亦同其他 store-scoped index 一致。
--
-- ── 為什麼要放寬 source 而唔係另開一張表 ─────────────────────────────
--   平台單要同店內單一齊顯示喺「線上訂單」（併入現有列表），
--   另開表就要改所有讀取路徑 —— 咁就唔係「零影響」了。

-- ① 外部單號（去重／冪等鍵用；現有列保持 NULL）
alter table pos_orders add column if not exists external_order_id text;

-- ② 原始 payload（除錯／事後重算；唔會用嚟做任何業務邏輯）
alter table pos_orders add column if not exists raw_json jsonb;

-- ③ 放寬 source 允許值：3 個 → 5 個
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'pos_orders_source_check'
  ) then
    alter table pos_orders drop constraint pos_orders_source_check;
  end if;

  alter table pos_orders
    add constraint pos_orders_source_check
    check (source in ('pos', 'kiosk', 'scan', 'aomi', 'mfood'));
end $$;

-- ④ 外部單冪等：同店 + 同來源 + 同外部單號 → 只可以有一列
--    插件重複投遞同一張單時，route 用 ON CONFLICT 唔做任何事。
create unique index if not exists pos_orders_external_unique
  on pos_orders (store_id, source, external_order_id)
  where external_order_id is not null;

comment on column pos_orders.external_order_id is
  '外部平台單號（澳覓 orderId / mfood id）。店內單為 NULL。配合 source 做冪等去重，見 migration 0054。';
comment on column pos_orders.raw_json is
  '外部來源嘅原始 payload，僅供除錯與事後重算；業務邏輯一律唔准讀呢欄。見 migration 0054。';
