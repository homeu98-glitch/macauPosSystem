-- 0060_pos_orders_platform_settlement.sql
--
-- 目的：讓外賣平台單帶住**平台真實結算金額**（實收），令報表可以計「平台抽成率」。
--
-- ── 為什麼需要（2026-09-26 使用者需求）────────────────────────────────
--   目前 POS 記錄嘅係「營業額」＝**客付**金額（例 62.00），
--   但商家真正落袋嘅係**平台扣費後**過數嘅錢（例 31.91）。
--   兩個數唔同，差額就係平台抽成 —— 商家最想知嘅就係呢個比例。
--
--   平台財務頁（mfood：/finance/tackout-check）嘅 transaction detail 有：
--     · tradeNo                平台訂單號 ＝ pos_orders.external_order_id
--     · storeBusinessAmtn      營業額
--     · storeReceiveAmtn       實收（扣平台服務費後）
--     · subsidyStoreReceiveAmtn 補貼後實收（＝實際到帳，通常最低）
--     · platformServiceFee     平台服務費
--
-- ── 三個欄位 ────────────────────────────────────────────────────────
--   platform_net_amount     平台實收（storeReceiveAmtn）
--   platform_subsidy_net    補貼後實收（subsidyStoreReceiveAmtn）＝實際到帳
--   platform_settled_at     收到結算資料嘅時間（判斷「已對帳」用）
--
--   ⚠️ 分開存兩個金額而唔係只存一個：
--      有補貼嘅單，`storeReceiveAmtn` 同 `subsidyStoreReceiveAmtn` 唔同。
--      只存一個就冇得事後核對平台報表。兩個都存，UI 揀一個做「實際到帳」。
--
--   ⚠️ **唔可以加 NOT NULL / DEFAULT 0**：未對帳嘅單要係 NULL。
--      報表顯示「待對帳」而唔係「0.00」—— 假零會令店員以為平台冇畀錢而去追數。
--
-- ── 🔴 零影響原則（同 0056 / 0057 一致）─────────────────────────────
--   · ADD COLUMN nullable、**冇 DEFAULT** → 現有寫入路徑（/api/pos/sync）唔使改，
--     INSERT 亦唔會因為新欄位而失敗（唔傳就係 NULL）
--   · 店內單、線上單永遠 NULL → UI 元件自己唔 render，版面逐個 pixel 一樣
--   · 純加法，可重複執行
--
-- ── 寫入路徑（唯一）────────────────────────────────────────────────
--   Chrome 插件抓完平台財務頁 → POST /api/integration/grabber/settlement
--     → 按 external_order_id 配對 → UPDATE 呢三個欄位
--   ⚠️ **只有呢條路徑會寫**。`/api/pos/sync`（client 全量重推）**唔應該**帶呢三個欄位，
--      否則 POS 本機嘅舊快照會蓋走雲端已經對好帳嘅數。
--      → sync route 要**明確忽略**呢三個 key（見該 route 嘅註釋）。
--
-- 🔴 俾商家跑嘅 SQL **唔好用 begin;…commit;**（2026-09-24 教訓：商家會將 commit
--    理解成 git commit ⇒ transaction rollback ⇒ 靜默冇改）。本檔全部語句即時生效。

-- ── pos_orders：平台結算金額 ──
alter table public.pos_orders
  add column if not exists platform_net_amount  numeric(12,2),
  add column if not exists platform_subsidy_net numeric(12,2),
  add column if not exists platform_settled_at  timestamptz;

comment on column public.pos_orders.platform_net_amount is
  '外賣平台實收金額（mfood storeReceiveAmtn ＝ 扣平台服務費後）。由 /api/integration/grabber/settlement 寫入，POS sync 永唔覆蓋。未對帳 / 店內單為 NULL（UI 顯示「待對帳」，唔可以填 0）。見 migration 0060。';

comment on column public.pos_orders.platform_subsidy_net is
  '外賣平台「補貼後實收」（mfood subsidyStoreReceiveAmtn）＝ 真正過數到商戶嘅金額。冇補貼時等於 platform_net_amount。未對帳 / 店內單為 NULL。見 migration 0060。';

comment on column public.pos_orders.platform_settled_at is
  '收到平台結算資料嘅時間。有值 ＝ 已對帳（可計差額率）；NULL ＝ 待對帳。做報表分「已對帳 / 未對帳」用。見 migration 0060。';

-- ── 配對用索引：settlement route 要按 (store_id, external_order_id) 找回訂單 ──
-- 0055 已有 uniq(store_id, source, external_order_id) 嘅唯一索引（partial：只限外部單），
-- 呢個索引係嗰個嘅**鏡像**（同樣 partial，避免為店內單嘅 NULL 建索引）。
-- 如果 0055 個索引名 / 定義唔同，呢句會另外建一個；唔影響正確性，只係多一個索引。
create index if not exists pos_orders_platform_settled_idx
  on public.pos_orders (store_id, platform_settled_at desc)
  where platform_settled_at is not null;

-- ============================================================================
-- 驗證（貼完之後逐條跑，全部唯讀；唔好用 begin;…commit;）
-- ============================================================================
-- ① 三個欄位存在 + 型別（全部應該 is_nullable = YES，冇 default）
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'pos_orders'
--     and column_name in ('platform_net_amount','platform_subsidy_net','platform_settled_at');
--   → numeric / numeric / timestamp with time zone；三行都 YES；column_default 全 NULL
--
-- ② 現有資料零影響（三個欄位應該全部係 NULL —— 未跑過 settlement）
--   select count(*) as total,
--          count(platform_net_amount) as has_net,
--          count(platform_settled_at)  as has_settled
--   from pos_orders;
--   → has_net / has_settled 都應該係 0（跑 migration 一刻）
--
-- ③ 索引存在
--   select indexname from pg_indexes
--   where schemaname='public' and tablename='pos_orders'
--     and indexname = 'pos_orders_platform_settled_idx';
--
-- 【降級回滾】唔想用？三個欄位留喺 DB 無害（舊 bundle 唔讀）。
--   要徹底移除：
--     alter table public.pos_orders
--       drop column if exists platform_net_amount,
--       drop column if exists platform_subsidy_net,
--       drop column if exists platform_settled_at;
--     drop index if exists public.pos_orders_platform_settled_idx;
