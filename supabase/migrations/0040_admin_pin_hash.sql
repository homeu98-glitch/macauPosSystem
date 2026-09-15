-- =============================================================================
-- 0040 · admin_account_users.pin_code 由「明文」改為 HMAC-SHA256 hash
--
-- 背景（2026-09-15 全面審查 P1-6）：
--   `src/lib/admin-account-server.ts` 以前用 `.eq("pin_code", pin)` —— PIN **以明文儲存、
--   以明文比對**。DB 或備份一外洩 ⇒ 全部 4 位 PIN 即時可用（4 位只有 10,000 組合）。
--
-- 設計（與 `src/lib/ledger/pin.server.ts:8-11` 既有做法一致）：
--   pin_hash = HMAC-SHA256(key = PEPPER, msg = "<account>:<pin>") → 小寫 hex（64 字元）
--   · 用 `account` 當 salt ⇒ 兩個員工用同一 PIN，hash 都唔同。
--   · 🔴 **PEPPER 一定要放 Vercel env（`AUTH_PIN_PEPPER`），唔可以只存 DB**。
--     4 位 PIN 只有 ~13 bits 熵 —— **只有「secret 唔喺 DB」才有真正保護**。
--
-- =============================================================================
-- 🔴 2026-09-15 修正：**本檔唔再用 `:'pepper'`**
--
-- 舊版寫 `hmac(..., :'pepper', ...)`，會報 `42601 syntax error at or near ":"`。
-- 原因：`:'name'` 係 **psql CLI 專屬嘅變數插值語法**（要 `psql -v pepper=...`），
-- **Supabase SQL Editor 唔係 psql**，唔支援 ⇒ 語法錯誤。
-- 本版改用 PL/pgSQL 變數 + **守衛**：唔記得改 pepper 就大聲 raise，唔會靜默寫入錯 hash。
--
-- =============================================================================
-- 上線次序（**唔可以一次做完**）
--
--   【步驟 A】跑 §1（加欄）—— 舊 code 照用 `pin_code`，**零影響**。
--   【步驟 B】部署新 code（已改為優先驗 `pin_hash`、回退明文、命中明文時**機會式升級**）。
--   【步驟 C】確認登入正常 + 所有帳號都已有 hash 之後，才跑 §5（清空明文）。
--
--   ⭐ §2（批量回填）**係可選**：新 code 會喺每個帳號第一次成功登入時自動寫入其 `pin_hash`。
--      跑 §2 嘅唯一好處係「唔使等所有人登入一次」就可以安全執行 §5。
--
--   ⚠️ 次序錯會點：
--     · 只跑 §5 而冇跑 §1 → 冇 `pin_hash` 欄，明文又清空 ⇒ **完全登入唔到**。
--     · 已跑 §5 但 `AUTH_PIN_PEPPER` 未設 → 同樣登入唔到（新 code 會 log 明確錯誤）。
--     · §2 打錯 pepper → 所有 hash 都對唔上；因為新 code 有明文回退，**登入仍然正常**，
--       只係 hash 無效（可以用 §6c 重新回填）。⇒ 有回退，所以唔會鎖死。
-- =============================================================================


-- ---------------------------------------------------------------------------
-- §1【必跑】加 hash 欄（idempotent，可重複執行）
--
-- `pgcrypto` 只為 §2（批量回填）同 §7（helper）而設；`hmac()` 喺未 enable 之前
-- `create function` 會因為 `check_function_bodies` 而失敗 ⇒ 所以喺 §1 就開定。
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;

alter table public.admin_account_users
  add column if not exists pin_hash text;

comment on column public.admin_account_users.pin_hash is
  'HMAC-SHA256(pepper, account||'':''||pin) 的 hex；pepper 只存 Vercel env AUTH_PIN_PEPPER。2026-09-15 取代明文 pin_code。';


-- ---------------------------------------------------------------------------
-- §2【可選】由明文批量回填 hash
--
-- 🔴 執行前：把下面 `v_pepper` 嘅 `<<<PEPPER>>>` 換成 Vercel env `AUTH_PIN_PEPPER` 的**完全相同**值。
--    冇換 → 會 raise exception 並中止（唔會寫入任何錯值）。
--
-- ⚠️ 注意：Supabase SQL Editor 會保留查詢歷史。若在意 pepper 曾出現喺歷史紀錄，
--    跳過 §2，改用新 code 嘅「機會式升級」自動回填（見 §3），就會完全唔需要喺 SQL 出現 pepper。
--
-- ⚠️ `hmac()` 來自 pgcrypto；`encode(..., 'hex')` = 小寫 hex，同 Node `.digest('hex')` 一致。
-- ---------------------------------------------------------------------------
-- do $$
-- declare
--   v_pepper text := '<<<PEPPER>>>';
--   v_count  integer;
-- begin
--   if v_pepper = '<<<PEPPER>>>' or v_pepper = '' then
--     raise exception
--       '請先將 <<<PEPPER>>> 換成 Vercel env AUTH_PIN_PEPPER 的值（或跳過 §2，改靠 §3 機會式升級）';
--   end if;
--
--   update public.admin_account_users
--      set pin_hash = encode(hmac(account || ':' || pin_code, v_pepper, 'sha256'), 'hex')
--    where pin_hash is null
--      and pin_code is not null
--      and pin_code <> '';
--
--   get diagnostics v_count = row_count;
--   raise notice '0040 §2：已回填 % 個帳號嘅 pin_hash', v_count;
-- end $$;


-- ---------------------------------------------------------------------------
-- §3【唔跑 §2 都得】機會式升級（由新 code 自動做）
--
-- 新 `authenticateAccountFromServer()` 流程：
--   ① 按 `account` 取 row（**唔再** `.eq("pin_code", pin)`）；
--   ② 驗證次序：`pin_hash`（HMAC，新）→ 回退 `pin_code`（明文，過渡期）；
--   ③ 若命中明文且有 pepper ⇒ **即刻把 `pin_hash` 寫入該帳號**；
--   ④ 寫入失敗（例如 `pin_hash` 欄唔存在）只 log 一次，**唔影響登入**。
--
-- ⇒ 只要每個帳號登入一次，就會自動上 hash。呢個係 §2 嘅替代方案，而且**唔需要 pepper 落 SQL**。
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- §4 驗收（逐段跑）
-- ---------------------------------------------------------------------------
-- 4.1 欄位存在？
--   select column_name, data_type from information_schema.columns
--    where table_name = 'admin_account_users' and column_name in ('pin_code','pin_hash');
--   期望：兩欄都見到，pin_hash = text
--
-- 4.2 回填進度
--   select account,
--          (pin_code is not null and pin_code <> '') as 仍有明文,
--          (pin_hash is not null)                   as 已有hash,
--          coalesce(length(pin_hash), 0)            as hash長度,   -- 期望 64
--          active
--     from public.admin_account_users
--    order by account;
--
-- 4.3 🔴 公式對照測試（**部署前必做**，證明 Node 同 Postgres 算出同一個 hash）
--   喺本機（有 AUTH_PIN_PEPPER 嘅環境）跑：
--     node -e "const{createHmac}=require('crypto');
--       console.log(createHmac('sha256',process.env.AUTH_PIN_PEPPER)
--         .update('60000000'+':'+'0000').digest('hex'))"
--   （帳號 / PIN 換成你自己一個真實帳號。若冇本機 env，用 Vercel 上同一個值。）
--   然後 SQL：
--     select account, pin_hash from public.admin_account_users where account = '60000000';
--   兩個字串**必須完全相同**。唔同 ⇒ pepper 唔一致或公式唔一致，**唔好部署新 code**（會登入失敗）。
--
-- 4.4 登入實測（部署新 code 之後）
--   ⬜ 用一個**已回填**嘅帳號登入 → 成功
--   ⬜ 用**未回填**嘅帳號登入 → 成功，且之後該行 `pin_hash` 會自動出現（＝§3 生效）
--   ⬜ 用錯 PIN → 「帳號或密碼不正確。」
--   ⬜ 用不存在嘅帳號 → **同一個訊息**（唔可以洩露帳號是否存在）
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- §5【步驟 C · 破壞性】清空明文 PIN
-- ⚠️ 只喺「新 code 已部署 + 登入實測正常」之後才跑。
-- ⚠️ 條件寫成「只清已經有 pin_hash 嘅 row」⇒ 冇 hash 嘅新帳號會保留明文，
--    唔會變成「登入唔到又查唔到原因」。
-- ---------------------------------------------------------------------------
-- update public.admin_account_users
--    set pin_code = null
--  where pin_hash is not null
--    and pin_code is not null;
--
-- 之後可以再落一步（令明文無法再寫入；建議留一個版本做回退保險，唔好即刻 drop column）：
--   alter table public.admin_account_users alter column pin_code drop not null;


-- ---------------------------------------------------------------------------
-- §6 回退
-- ---------------------------------------------------------------------------
-- 6a 回退 code：唔需要動 DB（`pin_code` 仍在，除非跑過 §5）；把舊版本重新部署即可。
-- 6b 已跑 §5 而想回頭：明文已無從還原 ⇒ 實際做法係「重設 PIN」，
--    唔係「還原」。所以 §5 之前務必確認新 code 已驗證。
-- 6c pepper 打錯／rotate 後重新回填（**要自行傳 pepper**）：
--   do $$
--   declare v_pepper text := '<<<PEPPER>>>';
--   begin
--     if v_pepper = '<<<PEPPER>>>' then raise exception '請先換 pepper'; end if;
--     update public.admin_account_users
--        set pin_hash = encode(hmac(account || ':' || pin_code, v_pepper, 'sha256'), 'hex')
--      where pin_code is not null and pin_code <> '';
--   end $$;


-- ---------------------------------------------------------------------------
-- §7 未來新增／改 PIN（src 內冇任何寫入路徑，新增帳號要靠 SQL）
-- helper 要自行傳 pepper（同 §2 一樣，只喺 seed 時用）：
-- ---------------------------------------------------------------------------
create or replace function public.pos_hash_pin(p_account text, p_pin text, p_pepper text)
returns text
language sql
immutable
as $$
  select encode(hmac(p_account || ':' || p_pin, p_pepper, 'sha256'), 'hex');
$$;

comment on function public.pos_hash_pin(text, text, text) is
  '計 admin_account_users.pin_hash（HMAC-SHA256）。用法：pin_hash = public.pos_hash_pin(''60000000'',''0000'', <pepper>)。2026-09-15。';

-- 🛡️ 同 0016 §4 對 `next_daily_sequence` 嘅口徑一致：**唔畀 anon / authenticated 直接 call**。
-- （`create function` 預設會 grant EXECUTE to PUBLIC，唔收就會經 PostgREST RPC 暴露。）
-- 註：冇 pepper 就算 call 到都算唔出有效 hash，但「最小權限」係本專案既定口徑，唔好開例外。
revoke all on function public.pos_hash_pin(text, text, text) from public, anon, authenticated;
grant execute on function public.pos_hash_pin(text, text, text) to service_role;
