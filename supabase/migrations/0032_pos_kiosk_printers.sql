-- ─────────────────────────────────────────────────────────────
-- 0032 · 自助點餐機（Kiosk）專屬打印機
-- 見 docs/87-kiosk-final-plan.md §6.2（原規劃放本機 localStorage，本輪改為 server 側）
-- ─────────────────────────────────────────────────────────────
--
-- 背景：
--   自助點餐機要**另外一台打印機**出顧客小票畀客人拿著走（唔係收銀台嗰部）。
--   而 `resolveJobPrinter()` 舊版只讀 `loadDeviceConfig()`（收銀端本機裝置設定），
--   一部專用 kiosk 平板從來冇配置過打印機 → 清單為空 → `buildTemplateReceiptJobs()`
--   直接 `return []` → **靜默唔出紙**（launch 後最難 debug 嗰種：冇 error、冇紙）。
--
-- 點解存 `pos_kiosk_settings`（而唔係 `pos_device_configs`）：
--   同 0015 / 0031 一樣 —— `pos_device_configs` 嘅讀取係
--   `.order("updated_at", desc).limit(1)` **冇 store filter** = 「全店最新一條（任何 terminal）」，
--   用嚟存 per-store 設定一定錯亂（見 docs/52 / docs/87 §4.3）。
--
-- 點解係 **per-store** 而唔係 per-device：
--   同一個開關值一樣，商家預期「改一次，全店所有自助機即刻跟」。
--   存本機 localStorage 就會變返 `kioskKitchenMode` 嗰個死 code 陷阱
--   （換機 / 清 cache 即失效，多部 kiosk 要逐部設）。
--   平板會將 server 值寫入本機快取（`macau-pos/stores/{storeId}/kiosk-printers`），
--   斷網時照樣用快取印得到。
--
-- 內容形狀：`DevicePrinterConfig[]`（同 `pos_device_configs.config.printers` 同一款元素）。
--   讀寫一律經 `normalizeKioskPrinters()` 過濾，唔會寫入垃圾入 DB。
--
-- `DEFAULT '[]'::jsonb` = 向後兼容：現存店鋪未設定過 → 空清單
--   → `resolveJobPrinter` 行為完全不變（零 risk）。

ALTER TABLE pos_kiosk_settings
  ADD COLUMN IF NOT EXISTS printers jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 一定要係 JSON array（唔係 object / scalar）。加之前先 drop，令腳本可重複跑。
ALTER TABLE pos_kiosk_settings
  DROP CONSTRAINT IF EXISTS pos_kiosk_settings_printers_arr_chk;

ALTER TABLE pos_kiosk_settings
  ADD CONSTRAINT pos_kiosk_settings_printers_arr_chk
  CHECK (jsonb_typeof(printers) = 'array');

COMMENT ON COLUMN pos_kiosk_settings.printers IS
  '自助點餐機專屬打印機清單（DevicePrinterConfig[]，per-store）。resolveJobPrinter 會將佢哋同 loadDeviceConfig().printers 合併。空 = 未設定，行為同以往一樣。見 docs/87 §6.2。';
