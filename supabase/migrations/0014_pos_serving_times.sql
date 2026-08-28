-- Phase B（模塊 4 出餐時間）儀器化：pos_orders 加兩個時間戳。
-- sent_to_kitchen_at = 首次送廚房；served_at = 出餐（交到客人手上）。
-- 出餐時間（分）＝ served_at − sent_to_kitchen_at，報表端計 avg/median/P95。
alter table pos_orders add column if not exists sent_to_kitchen_at timestamptz;
alter table pos_orders add column if not exists served_at timestamptz;

create index if not exists pos_orders_served_idx on pos_orders (served_at);
