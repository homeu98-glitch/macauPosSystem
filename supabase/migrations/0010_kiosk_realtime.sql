-- 0010 · Kiosk 客人自點 Realtime 渠道 + 售罄表 + 讀取權限
-- 配套客戶端：src/lib/pos/use-pos-realtime.ts（收銀側訂閱）、src/lib/kiosk-order.ts（落單推 sync）
--
-- 設計要求：Kiosk 落單後收銀要「秒級」見單、出廚房單，禁用 polling。
-- 實現：pos_orders / pos_print_jobs / pos_soldout 加入 supabase_realtime publication，
--       收銀用 anon key 訂閱（postgres_changes）。落單寫入一律經 /api/pos/sync（server service_role，繞過 RLS）。

-- 1) 加入 Realtime publication
alter publication supabase_realtime add table if not exists pos_orders;
alter publication supabase_realtime add table if not exists pos_print_jobs;
alter publication supabase_realtime add table if not exists pos_soldout;

-- 2) pos_soldout：售罄即時標記（Kiosk 只讀，員工側 toggle 寫）
create table if not exists pos_soldout (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  menu_item_id text not null,
  sold_out boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (store_id, menu_item_id)
);
create index if not exists pos_soldout_store_idx on pos_soldout (store_id);

-- 3) RLS：收銀 Realtime 訂閱需要 anon 有 SELECT
--    落單內容屬營運資料（枱號 / 項目 / 金額），無客人 PII，故允許 anon 讀取。
--    ⚠️ 多租戶隔離：現行 using (true) 會暴露所有店；上線前應改為
--       using (store_id = current_setting('request.headers')::json->>'x-store-id') 之類嘅店級過濾。
alter table pos_orders enable row level security;
alter table pos_print_jobs enable row level security;
alter table pos_soldout enable row level security;

drop policy if exists "pos_orders anon read" on pos_orders;
create policy "pos_orders anon read" on pos_orders for select to anon using (true);

drop policy if exists "pos_print_jobs anon read" on pos_print_jobs;
create policy "pos_print_jobs anon read" on pos_print_jobs for select to anon using (true);

drop policy if exists "pos_soldout anon read" on pos_soldout;
create policy "pos_soldout anon read" on pos_soldout for select to anon using (true);

-- 寫入只可由 service_role（/api/pos/sync）處理；anon 唔使寫入權限
grant select on pos_orders to anon;
grant select on pos_print_jobs to anon;
grant select on pos_soldout to anon;
