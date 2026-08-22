-- 0012 · 同日線下序號函數 next_daily_sequence
-- 配套：src/app/api/pos/sequence/route.ts（落單號碼跟店內線下序號，feature #3）
--
-- 用途：kiosk / 掃碼落單 同 店內收銀 共用同一日序號，kind 對齊店內：
--   pos（堂食） / pickup（自取） / counter（取餐） / delivery（外賣）
-- 每 (store_id, kind, biz_date) 一日由 1 開始遞增，跨日歸零。
-- biz_date 用 Macau 時區（Asia/Macau）決定，避免 UTC 午夜 cut-off 錯位。
--
-- ⚠️ 重要：呢個 RPC 係 repo 之前漏咗嘅 migration（code 早 call 但無 SQL 建立），
--    所以依家補返。全部 idempotent：表 if not exists；函數 create or replace。
--    喺已有 DB 跑 → 表 no-op、函數重建（簽名不變則安全）；fresh DB 跑 → 完整建立。

-- ───────────────────────────────────────────────────────────
-- 1) 序號計數表（idempotent）
-- ───────────────────────────────────────────────────────────
create table if not exists pos_daily_sequences (
  store_id    text    not null,
  kind        text    not null,
  biz_date    date    not null,
  last_number integer not null default 0,
  primary key (store_id, kind, biz_date)
);

create index if not exists pos_daily_sequences_store_idx
  on pos_daily_sequences (store_id, kind, biz_date);

-- ───────────────────────────────────────────────────────────
-- 2) 取下一個序號（create or replace，可安全重跑）
--    路徑：supabase.rpc("next_daily_sequence", { p_store_id, p_kind })
--    返回 integer：該 (store, kind, 今日) 嘅下一個序號（首次 = 1，之後遞增）。
--    用 ON CONFLICT DO UPDATE 保證同一 row 原子遞增（唔使先 select 再 update）。
-- ───────────────────────────────────────────────────────────
create or replace function next_daily_sequence(
  p_store_id text,
  p_kind     text
)
returns integer
language plpgsql
as $$
declare
  v_biz_date date := (now() at time zone 'Asia/Macau')::date;
  v_next     integer;
begin
  insert into pos_daily_sequences (store_id, kind, biz_date, last_number)
  values (p_store_id, p_kind, v_biz_date, 1)
  on conflict (store_id, kind, biz_date)
  do update set last_number = pos_daily_sequences.last_number + 1
  returning last_number into v_next;

  return v_next;
end;
$$;

-- 收銀 / kiosk 經 anon key 訂閱，序號 RPC 可能由 anon 直接 call（視部署）；
-- service_role 寫入路徑一定用到。明確 grant，避免 default 權限被 revoke 時失靈。
grant execute on function next_daily_sequence(text, text) to anon, authenticated, service_role;
