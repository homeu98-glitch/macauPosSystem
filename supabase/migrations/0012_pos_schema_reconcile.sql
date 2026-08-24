-- 0012 · 補齊 existing POS 表嘅欄位（schema drift 對齊）
--
-- 背景：0011 用 `CREATE TABLE IF NOT EXISTS` 建表，但用戶 existing DB 嘅 pos_orders 等表
-- 係早年手動 SQL 建立，已經存在 → CREATE 變 no-op，冇補到 code 後來加嘅欄位
-- （例如 `fulfillment_status`），令 /api/pos/sync upsert 彈
-- 「Could not find the 'fulfillment_status' column ... in the schema cache」。
--
-- 本 migration 用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 把 code 實際用到嘅每個欄位
-- 補落 existing 表。idempotent：欄位已存在就 skip，唔存在先加；現有資料列新欄位會係 NULL
-- （code 讀取位都有 `?? default` 兜底，唔會爆）。
--
-- 加完欄位後如需手動刷新 PostgREST schema cache，見檔尾 NOTIFY 指令。

-- ── pos_orders（realtime 訂閱 + 落單寫入）──
alter table pos_orders add column if not exists local_order_no text;
alter table pos_orders add column if not exists store_id text;
alter table pos_orders add column if not exists table_id text;
alter table pos_orders add column if not exists table_name text;
alter table pos_orders add column if not exists status text;
alter table pos_orders add column if not exists fulfillment_status text;
alter table pos_orders add column if not exists items jsonb;
alter table pos_orders add column if not exists order_note text;
alter table pos_orders add column if not exists subtotal numeric;
alter table pos_orders add column if not exists tax_amount numeric;
alter table pos_orders add column if not exists service_charge_amount numeric;
alter table pos_orders add column if not exists discount_amount numeric;
alter table pos_orders add column if not exists total numeric;
alter table pos_orders add column if not exists prepaid_amount numeric;
alter table pos_orders add column if not exists online_order_id text;
alter table pos_orders add column if not exists payment_method text;
alter table pos_orders add column if not exists created_at timestamptz;
alter table pos_orders add column if not exists updated_at timestamptz;

-- ── pos_print_jobs（realtime 訂閱 + 廚房單）──
alter table pos_print_jobs add column if not exists store_id text;
alter table pos_print_jobs add column if not exists order_id text;
alter table pos_print_jobs add column if not exists order_no text;
alter table pos_print_jobs add column if not exists table_name text;
alter table pos_print_jobs add column if not exists ticket_type text;
alter table pos_print_jobs add column if not exists printer_group text;
alter table pos_print_jobs add column if not exists printer_name text;
alter table pos_print_jobs add column if not exists items jsonb;
alter table pos_print_jobs add column if not exists status text;
alter table pos_print_jobs add column if not exists created_at timestamptz;

-- ── pos_bootstrap_config（server service_role 讀寫）──
alter table pos_bootstrap_config add column if not exists source_version integer;
alter table pos_bootstrap_config add column if not exists store_name text;
alter table pos_bootstrap_config add column if not exists currency text;
alter table pos_bootstrap_config add column if not exists categories jsonb;
alter table pos_bootstrap_config add column if not exists menu_items jsonb;
alter table pos_bootstrap_config add column if not exists tables jsonb;
alter table pos_bootstrap_config add column if not exists rules jsonb;
alter table pos_bootstrap_config add column if not exists printer_groups jsonb;
alter table pos_bootstrap_config add column if not exists updated_at timestamptz;

-- ── pos_device_configs（state / device-config）──
alter table pos_device_configs add column if not exists store_id text;
alter table pos_device_configs add column if not exists terminal_name text;
alter table pos_device_configs add column if not exists printers jsonb;
alter table pos_device_configs add column if not exists local_settings jsonb;
alter table pos_device_configs add column if not exists updated_at timestamptz;

-- ── pos_queue_events（sync / state）──
alter table pos_queue_events add column if not exists type text;
alter table pos_queue_events add column if not exists entity_id text;
alter table pos_queue_events add column if not exists payload jsonb;
alter table pos_queue_events add column if not exists status text;
alter table pos_queue_events add column if not exists created_at timestamptz;

-- ── pos_soldout（0010 已建，呢度補雙保險）──
alter table pos_soldout add column if not exists store_id text;
alter table pos_soldout add column if not exists menu_item_id text;
alter table pos_soldout add column if not exists sold_out boolean;
alter table pos_soldout add column if not exists updated_at timestamptz;

-- ───────────────────────────────────────────────────────────
-- 刷新 PostgREST schema cache（加完欄位後有時要手動 reload，
-- 否則 Supabase 仍用舊 cache 而彈 "column not in schema cache"）。
-- 亦可喺 Supabase Dashboard → API → Schema cache 撳 Reload。
-- ───────────────────────────────────────────────────────────
select pg_notify('pgrst', 'reload schema');
