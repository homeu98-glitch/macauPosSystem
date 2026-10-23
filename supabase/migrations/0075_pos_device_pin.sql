-- =============================================================================
-- 0075 · 裝置憑證改為「加密店主 PIN」（docs/161）
--
-- 背景（2026-10-23 實測）：
--   0073 嘅 `refresh_token_enc` 存嘅係**店主登入時嗰個 session 嘅 refresh token**。
--   店主一按「登出」，`signOut({scope:"local"})` 就撤銷咗嗰個 session
--   ⇒ 裝置憑證即刻變廢票 ⇒ 店員登入報「呢部機嘅登入憑證已過期」。
--   另外 `autoRefreshToken: true` 會喺背景輪換 token，但唔經
--   `resolveLedgerSession()` ⇒ DB 嗰份唔同步 ⇒ Supabase 判定 token 重用
--   ⇒ 成條 family 撤銷。兩個成因同一個病根：
--      **裝置憑證同店主嘅瀏覽器 session 共用同一條 token。**
--
-- 新設計：
--   裝置唔再存 token，改存**店主 4 位 PIN 嘅 AES-256-GCM 密文**。
--   店員登入時 server 解密 PIN → `signInWithPassword()` 即場換一個
--   **全新獨立 session** ⇒ 冇共用 family，登出／輪換／過期全部唔影響。
--
-- 安全性：
--   · 密文格式 `v1.<iv>.<tag>.<ct>`，金鑰由 `resolvePosTokenSecret()` 派生
--     （同 pv1 / sv1 同一條 secret）。DB 洩漏但 env 冇洩漏 ⇒ 解唔到。
--   · PIN **永遠唔會**經任何 HTTP response 出街；只喺 server 內部用完即棄。
--   · 表係 service_role only（0073 已設），anon 讀唔到。
--
-- 全部 `if not exists`，可重複執行。
-- ⚠️ migration 已寫 ≠ 已跑 —— 要人手去 POS Supabase → SQL Editor 貼。
-- =============================================================================

alter table public.pos_bound_devices
  add column if not exists owner_account text,
  add column if not exists owner_pin_enc text;

comment on column public.pos_bound_devices.owner_account is
  '店主 8 位 Ledger 帳號（normalize 後純數字）。用嚟喺裝置模式反查 store_name，亦做稽核。';
comment on column public.pos_bound_devices.owner_pin_enc is
  'AES-256-GCM 加密嘅店主 4 位 PIN（v1.<iv>.<tag>.<ct>）。只喺 server 解密後即場換 Ledger session，永不回傳。';

-- 裝置模式（唔打 8 位帳號）要用 device_id 反查 store_id，冇 store_id 做前綴。
create index if not exists pos_bound_devices_device_idx
  on public.pos_bound_devices (device_id);


-- ---------------------------------------------------------------------------
-- 驗收（可重複跑）
-- ---------------------------------------------------------------------------
-- ① 兩個新欄存在：
--    select column_name, data_type from information_schema.columns
--     where table_schema='public' and table_name='pos_bound_devices'
--     order by ordinal_position;
-- ② 店主登入一次之後應該有 PIN 密文（唔應該係 null，亦唔應該係明文）：
--    select device_id, owner_account,
--           left(owner_pin_enc, 12) as enc_prefix, token_updated_at
--      from public.pos_bound_devices where revoked_at is null;
-- ③ 舊 row（升級前授權）嘅 owner_pin_enc 會係 null ⇒ 店主要重新登入一次。
--    想一次過清走舊憑證（令佢哋即刻走「未初始化」流程）：
--    -- update public.pos_bound_devices set revoked_at = now()
--    --  where owner_pin_enc is null and revoked_at is null;
