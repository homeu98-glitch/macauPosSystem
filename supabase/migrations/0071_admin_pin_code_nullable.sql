-- =============================================================================
-- 0071 · admin_account_users.pin_code 解除 NOT NULL
--
-- 對應：docs/159 §14.2「實測陷阱」
-- 日期：2026-10-21
--
-- 背景：
--   0040 嘅目標係「PIN 只存 hash，明文欄位退場」，但該檔 §5（清空明文 + drop not null）
--   屬**手動可選步驟**，一直未跑。結果：
--     · `pin_code` 仍然 NOT NULL；
--     · 新 code 建號時寫 `pin_code = null` → violates not-null constraint
--       （2026-10-21 首次用 /admin/accounts 建號即中）。
--
-- 本 migration 做最小、唯讀安全嘅一步：
--   解除 NOT NULL（唔刪欄、唔改資料）。
--     · 舊資料有明文 → 照留（登入仍然可回退比對）
--     · 新資料 → NULL（= 冇明文 PIN），程式會用 `pin_hash`
--   之後想再清明文，可以獨立跑：
--     update public.admin_account_users set pin_code = null where pin_code = '';
--   （⚠️ 清之前要確認所有帳號都有 pin_hash，否則嗰啲帳號會登入唔到。）
--
-- 安全性：`drop not null` 唔會令任何現有 PIN 變弱；PIN 驗證由 `pin_hash`
--   （HMAC + pepper 喺 server env）把關，明文只係過渡期 fallback。
--
-- 冪等：重複執行無害（已經 NULL-able 時 `drop not null` 係 no-op）。
-- =============================================================================

alter table public.admin_account_users
  alter column pin_code drop not null;

comment on column public.admin_account_users.pin_code is
  '明文 PIN，**過渡期 legacy**。2026-10-21 起允許 NULL（新帳號一律 NULL，只存 pin_hash）。登入時優先驗 pin_hash；pin_code 只作舊資料 fallback。';

-- ---------------------------------------------------------------------------
-- 驗證：
--   select column_name, is_nullable
--     from information_schema.columns
--    where table_name = 'admin_account_users' and column_name = 'pin_code';
--   → is_nullable = YES
-- ---------------------------------------------------------------------------
