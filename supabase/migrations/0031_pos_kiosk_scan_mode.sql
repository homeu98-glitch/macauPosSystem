-- ─────────────────────────────────────────────────────────────
-- 0031 · 掃碼點餐模式（堂食 / 快餐）
-- 見 docs/115-scan-dine-in-vs-quick-plan.md
-- ─────────────────────────────────────────────────────────────
--
-- 背景：掃碼下單要分兩種**店級互斥**模式：
--   - 'dine_in'（預設）：每張枱一個專屬 QR（/menu?tableId=），落單綁枱號，
--                        同一枱再加單 = 更新同一張單。
--   - 'quick'         ：全店只有一個 QR（/quick?store=），無枱，
--                        每張單獨立新增、單號沿用 kiosk 嘅 pickup 序號（如「自取01」）。
--
-- 點解存 `pos_kiosk_settings`（而唔係 pos_device_configs）：
--   嗰張表嘅讀取係 `.order("updated_at", desc).limit(1)` **冇 store filter**
--   = 「全店最新一條（任何 terminal）」。用嚟存 per-store 設定一定會錯亂 ——
--   同 `onlineOrderSettings.autoAccept` 嗰個 bug 同一個坑（見 docs/52 / docs/87 §4.3）。
--   呢張表係 store_id PRIMARY KEY，有 store filter，已有 RLS 與 API。
--
-- `DEFAULT 'dine_in'` = 向後兼容：現存店鋪全部繼續用逐枱碼，行為不變。

ALTER TABLE pos_kiosk_settings
  ADD COLUMN IF NOT EXISTS scan_mode text NOT NULL DEFAULT 'dine_in';

-- CHECK 約束：唔容許未知值（寧可寫入失敗，都唔好出現一個冇人處理得嚟嘅模式）。
-- `IF NOT EXISTS` 語法唔支援 check constraint，所以先 drop 再 add（idempotent）。
ALTER TABLE pos_kiosk_settings
  DROP CONSTRAINT IF EXISTS pos_kiosk_settings_scan_mode_chk;

ALTER TABLE pos_kiosk_settings
  ADD CONSTRAINT pos_kiosk_settings_scan_mode_chk
  CHECK (scan_mode IN ('dine_in', 'quick'));

COMMENT ON COLUMN pos_kiosk_settings.scan_mode IS
  '掃碼點餐模式：dine_in = 每枱一碼（預設）；quick = 全店一碼、無枱、每單獨立。店級互斥，見 docs/115。';
