-- 0010 · Kiosk 售罄表 pos_soldout（DDL only）
--
-- ⚠️ 2026-08-22 重組：本 migration 原本仲包埋 Realtime publication + anon RLS + grant，
--    但咁做會令 fresh-DB 按檔名順序跑時，pos_orders / pos_print_jobs 仲未建就 `alter table`
--    失敗。現將 realtime / RLS / grant 全部交返 0011_pos_core_tables.sql 統一處理，
--    本檔只負責建立 pos_soldout 呢張表（其餘 POS 表由 0011 建）。
--
-- 重要更正（同 0010 原本註解嘅誤解）：`pos_*` 表全部屬 macau-pos 自己嘅 Supabase 項目，
-- 由本 repo 嘅 migrations 建立，**唔係** Ledger。realtime 訂閱 / 寫入路徑見 0011 同
-- src/lib/pos/supabase-client.ts。

-- 建立 pos_soldout：售罄即時標記（Kiosk 只讀，員工側 toggle 寫）
create table if not exists pos_soldout (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  menu_item_id text not null,
  sold_out boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (store_id, menu_item_id)
);
create index if not exists pos_soldout_store_idx on pos_soldout (store_id);
