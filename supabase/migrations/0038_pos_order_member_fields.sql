-- 0038 · 訂單會員扣款欄位（掃碼 / 自助點餐機會員餘額付款）
--
-- 背景（docs/130 §7.1）：
--   Kiosk / 掃碼落單嘅訂單經 `/api/pos/sync` 上雲時，route 係**逐欄顯式複製**
--   （`baseRecord`）。喺呢個 migration 之前，member 相關欄位**一欄都冇** →
--   客人用會員餘額扣咗款，收銀台嗰邊張單仍然顯示「未付款」，
--   店員有可能再收一次錢（真金白銀嘅客訴）。
--
--   ⚠️ 唔係「RLS / 白名單擋住」，而係根本冇抄呢幾欄 —— 所以修法係「加欄 + 加落 baseRecord」，
--      唔係「改權限」。
--
-- 三欄：
--   1) member_customer_id     —— Ledger 顧客 uuid（**唔係** POS 自己嘅 id；跨系統，所以無 FK）
--   2) member_deduction_avos  —— 經會員餘額扣減嘅金額（avos 整數；1 MOP = 100 avos）
--   3) member_deduct_txn_id   —— Ledger `merchant_apply_pos_txn` 回嘅 txn_id（對帳憑證）
--
-- 🔴 個資紅線（Ledger 契約 §7.2 / §5.11）：
--   只准存 `customer_id`（uuid）。**禁止**存顧客電話、顯示名、餘額、券 ——
--   嗰啲只准「當次 UI 渲染」。所以呢個 migration **刻意唔加** member_phone /
--   member_display_name / member_balance_avos 任何一欄，將來亦唔應該加。
--
-- ⚠️ additive + 全部 if not exists + default：舊行唔會壞，舊 client（唔識呢三欄）照跑。
--    未跑之前 route 會 42703 fallback（同 0034 discount_note 一樣嘅降級寫法），功能靜默停用。

-- ── pos_orders：會員扣款 ──
alter table public.pos_orders
  add column if not exists member_customer_id uuid,
  add column if not exists member_deduction_avos bigint not null default 0,
  add column if not exists member_deduct_txn_id text;

comment on column public.pos_orders.member_customer_id is
  '會員扣款所屬之 Ledger 顧客 uuid（跨系統，無 FK）。個資紅線 §7.2：只准存 uuid，禁止存電話 / 姓名。非會員單為 NULL。';

comment on column public.pos_orders.member_deduction_avos is
  '經會員儲值餘額扣減嘅金額（avos 整數，1 MOP = 100 avos）。0 = 冇用會員餘額。呢個係「已收款」嘅金額，收銀台據此唔應該再收錢。';

comment on column public.pos_orders.member_deduct_txn_id is
  'Ledger merchant_apply_pos_txn 回傳嘅 txn_id，供 POS ↔ Ledger 對帳同重試冪等。非會員單為 NULL。';

-- 追溯用索引：只索引真係用過會員餘額嘅行
create index if not exists pos_orders_member_deduct_idx
  on public.pos_orders (store_id, created_at desc)
  where member_deduction_avos > 0;

-- ── 驗證（手動跑） ──
-- 1) 欄位存在 + 型別
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'pos_orders'
--     and column_name in ('member_customer_id','member_deduction_avos','member_deduct_txn_id');
--   → member_customer_id    / uuid   / YES / NULL
--   → member_deduction_avos / bigint / NO  / 0
--   → member_deduct_txn_id  / text   / YES / NULL
--
-- 2) 個資紅線自查 —— **必須回 0 行**（證明冇人偷偷加咗電話 / 姓名欄）
--   select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'pos_orders'
--     and (column_name ilike '%member%phone%'
--       or column_name ilike '%member%name%'
--       or column_name ilike '%member%balance%');
--
-- 3) 會員扣款單 vs Ledger 對帳（抽一日核對金額同 txn_id）
--   select local_order_no, total, member_deduction_avos / 100.0 as member_mop,
--          member_customer_id, member_deduct_txn_id, status, created_at
--   from pos_orders
--   where member_deduction_avos > 0
--   order by created_at desc
--   limit 50;
--
-- 4) 錢有冇收漏（收銀台最想睇）：已扣會員餘額但狀態唔係已付款嘅單 —— **應該回 0 行**
--   select id, local_order_no, status, total, member_deduction_avos
--   from pos_orders
--   where member_deduction_avos > 0
--     and status not in ('paid','settled');
