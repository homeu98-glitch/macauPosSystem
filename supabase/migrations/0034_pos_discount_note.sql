-- 0034 · 折扣備註（設定清單 + 訂單審計欄位）
--
-- 背景：結帳套用「全單折扣」或改「單品折扣」時，商家必須揀一個原因（員工優惠 / 會員折扣…），
-- 同 0018 嘅免單備註（comp_note）一樣要落雲端直欄，令換機 / 清 cache 之後由 server state
-- reload 都仲見到「點解要打折」，報表 / 交班明細亦可以逐筆追溯。
--
-- 兩樣嘢：
--   1) pos_note_presets 加一欄 discount_note_presets（per-store 真源，同 note_presets /
--      cancel_note_presets / comp_note_presets 同一個 JSONB 陣列模式）
--   2) pos_orders 加一欄 discount_note（全單折扣原因；單品折扣原因存喺 items JSONB 嘅
--      OrderItem.discountNote，唔另開欄 —— 佢係逐件菜嘅屬性，同 specs / note 同層）
--
-- 呢個 migration 係 additive：全部 add column if not exists + default，舊行唔會壞，
-- 舊 client（唔識呢兩欄）照跑。未跑之前 route 會 42703 fallback，功能靜默停用（唔會爆）。

-- ── 1) 設定 → 備註 → 折扣備註（per-store） ──
alter table public.pos_note_presets
  add column if not exists discount_note_presets jsonb not null default '[]'::jsonb;

comment on column public.pos_note_presets.discount_note_presets is
  '折扣備註預設清單（string[] JSONB）。結帳頁套用全單折扣 / 改單品折扣時必選嘅原因，由 設置 → 備註 → 折扣備註 維護。';

-- ── 2) 訂單：全單折扣備註 ──
alter table public.pos_orders
  add column if not exists discount_note text;

comment on column public.pos_orders.discount_note is
  '全單折扣備註（結帳頁揀「全單折扣」後必選嘅原因）。有 discount_amount > 0 就有值；功能上線前嘅舊單為 NULL。單品折扣原因存喺 items 內嘅 OrderItem.discountNote。';

-- 追溯用索引：只索引有值嘅行（同 0018 comp_note 一致）
create index if not exists pos_orders_discount_note_idx
  on public.pos_orders (store_id, created_at desc)
  where discount_note is not null;

-- ── 驗證（手動跑） ──
-- 1) 欄位存在 + 型別
--   select table_name, column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public'
--     and ( (table_name = 'pos_note_presets' and column_name = 'discount_note_presets')
--        or (table_name = 'pos_orders'       and column_name = 'discount_note') );
--   → pos_note_presets / discount_note_presets / jsonb / NO / '[]'::jsonb
--   → pos_orders       / discount_note       / text  / YES / NULL
--
-- 2) 一店一行唔變（同一 store_id 插兩次應該 duplicate key）
--   insert into pos_note_presets (store_id, note_presets) values ('x', '[]');
--   insert into pos_note_presets (store_id, note_presets) values ('x', '[]'); -- 預期 error
--
-- 3) 有折扣備註嘅單（抽一日核對「折扣金額 ↔ 原因」對得上）
--   select local_order_no, table_name, total, discount_amount,
--          discount_note, comp_note, payment_method, created_at
--   from pos_orders
--   where discount_note is not null
--   order by created_at desc
--   limit 50;
--
-- 4) 按原因埋數（管理層最想睇 —— 邊個原因批咗幾錢折扣）
--   select discount_note,
--          count(*)             as orders,
--          sum(discount_amount) as discount_total,
--          sum(total)           as net_total
--   from pos_orders
--   where discount_note is not null
--     and created_at >= now() - interval '30 days'
--   group by discount_note
--   order by discount_total desc;
