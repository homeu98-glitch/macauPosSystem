-- 0015 · 線下自助點餐（Kiosk + 店內掃碼自點）
-- 對應 docs/87 §7。冇破壞性改動，全部 ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS，可重複執行。

-- ─────────────────────────────────────────────────────────────
-- 1. 訂單來源（docs/87 §5.2 · 規格 7）
--    pos_orders 加 source：「pos」= 收銀台／員工落單；「kiosk」= 自助點餐機；「scan」= 客人掃碼自點。
--    舊列全部 default 'pos'，唔使 backfill。
-- ─────────────────────────────────────────────────────────────
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pos';

-- 合法值約束：先 drop 再 add，等重複執行都安全
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_orders_source_check'
  ) THEN
    ALTER TABLE pos_orders
      ADD CONSTRAINT pos_orders_source_check
      CHECK (source IN ('pos', 'kiosk', 'scan'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pos_orders_source ON pos_orders (store_id, source);

-- ─────────────────────────────────────────────────────────────
-- 2. print job 模板快照 / 靜態內容 / 打印機綁定（docs/87 §7）
--
--    背景：PrintJob 喺落單端建嗰陣會附帶 template 快照（商家 ESC/POS 模板）+ content（靜態區塊文字）
--    + printerId（目標打印機）。但 pos_print_jobs 表同 /api/pos/sync 一直只傳 11 個欄位，
--    呢三樣嘢全部甩咗 → job 同步去第二部機（例如 Kiosk 建嘅單同步去收銀台）會退化做硬編 fallback
--    渲染（冇店名／時間／單據類型／頁尾，亦唔理商家設嘅字型大小）→ 兩端印出嚟唔一致。
--
--    items 本身係 JSONB，加呢三欄唔影響舊資料。
-- ─────────────────────────────────────────────────────────────
ALTER TABLE pos_print_jobs ADD COLUMN IF NOT EXISTS template   jsonb;
ALTER TABLE pos_print_jobs ADD COLUMN IF NOT EXISTS content    jsonb;
ALTER TABLE pos_print_jobs ADD COLUMN IF NOT EXISTS printer_id text;

-- ─────────────────────────────────────────────────────────────
-- 3. 自助點餐設定（按店 · docs/87 §4.3 · 規格 5、6）
--
--    「自動接自助單」開關嘅唯一真源。
--
--    ⚠️ 千祈唔好改用 pos_device_configs：嗰張表嘅讀取方式係
--       .order("updated_at", { ascending: false }).limit(1) 冇 store filter
--       = 「全店最新一條（任何 terminal）」，用嚟存 per-store 設定會錯亂
--       （同 onlineOrderSettings.autoAccept 嗰個 bug 同一個坑，見 docs/52）。
--
--    self_order_auto_accept = true  → 免確認，客人落單直接出廚房單（預設，規格 5）
--    self_order_auto_accept = false → 排入「待確認」，等收銀台撳確認先用代客下單流程出單
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pos_kiosk_settings (
  store_id               text PRIMARY KEY,
  self_order_auto_accept boolean     NOT NULL DEFAULT true,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- 4. RLS：pos_kiosk_settings 跟其他 pos_* 表一致（anon 可讀寫，見 0011 L141-170）
--    呢張表冇 PII（得 store_id + 一個 boolean），開放 anon 讀寫同現有做法一致。
-- ─────────────────────────────────────────────────────────────
ALTER TABLE pos_kiosk_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pos_kiosk_settings' AND policyname = 'anon_all_pos_kiosk_settings'
  ) THEN
    CREATE POLICY anon_all_pos_kiosk_settings
      ON pos_kiosk_settings
      FOR ALL
      TO anon, authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 5. Realtime：pos_kiosk_settings 唔使入 publication（Kiosk 落單時 GET 一次就夠，禁 polling）。
--    pos_orders / pos_print_jobs 喺 0011 已經入咗 supabase_realtime，新欄位會自動隨 row 傳。
-- ─────────────────────────────────────────────────────────────
