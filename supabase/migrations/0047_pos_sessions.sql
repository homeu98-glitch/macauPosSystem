-- 0047_pos_sessions.sql
-- ============================================================================
-- 目的：令「邊個店家、邊部機、開住幾個 POS 工作階段、跑住邊個版本」**對伺服器可見**。
--
-- 【為何要加（2026-09-22）】
-- 現時工作階段**只存在於瀏覽器**（`AuthSession` 喺 localStorage／`posDeviceToken` 12h）。
-- server 完全唔知有幾多個分頁開住 —— 於是出現過：
--   · 商家開咗舊分頁冇關，跑住舊 JS 每小時燒 ~650 MB egress（2026-09-21 實測，佔 97%）；
--   · 同一部收銀機開住 2~3 個分頁，冇人為意；
--   · 想查「邊間店仲跑住舊版本」只可以靠 Vercel log 反推（`legacy=1`）。
-- ⇒ 建一張**極輕量**嘅工作階段表，令 admin 可以直接睇、可以直接關。
--
-- 【設計原則（同本專案既有紀律一致）】
--   1. **唔加任何新請求**：註冊用 `/api/ledger/login`（server 唯一權威知道 merchantId
--      嘅地方）；續期**掛喺既有請求**上（POST 寫入 60 秒節流、GET state 5 分鐘節流）。
--   2. **GET 唔建立 row**：GET 只續期**已存在**嘅 row。row 由 login / POST sync 建立
--      ⇒ GET 保持「唔會創造狀態」嘅語義（同 `loadPairedAgent(recordActivity)` 嘅教訓一致）。
--   3. **一張 row 一個工作階段**，`id = store_id || ':' || session_key`（client 用
--      `sessionStorage` 產生 ⇒ **每個分頁一個**；用 localStorage 會撞成同一個）。
--   4. **軟踢**：`revoked_*` 只係「下達」記錄；實際生效係 POS 端下次請求見到
--      `x-pos-session-closed: 1` 之後自己停輪詢 + 出橫幅（唔會自動 reload —— 結帳中途
--      reload 會出事）。
--
-- 【保留政策】
--   30 日後可以由 admin 頁「清除」（或之後加 cron 清）。**唔會**儲存任何業務資料：
--   只有身分、版本、時間、來源 IP、User-Agent。
--
-- ⚠️ 寫咗 migration ≠ 跑咗 migration（已踩過 0018/0019/0020/0040/0044/0045）。
--    本機冇 DB 連線 → 要人手去 Supabase Dashboard（macauPos 專案）→ SQL Editor 貼。
--    全部 idempotent，可以重複貼。
-- ============================================================================

create table if not exists public.pos_sessions (
  -- `store_id || ':' || session_key`。用合成字串而唔用 uuid：
  -- ① 天然滿足「同店同 key 只有一行」→ upsert 用 on_conflict 就得，唔使先查再寫；
  -- ② admin 頁一眼睇得出屬邊間店，方便 debug。
  id            text primary key,

  store_id      text        not null,
  -- client 用 sessionStorage 產生嘅工作階段識別碼（每個分頁一個）。
  session_key   text        not null,

  -- 簽發憑證時嘅 8 位員工帳號 / 角色（審計用，唔做授權判斷）。
  account       text,
  role          text,

  -- **客戶端內聯**嘅建置識別碼（`NEXT_PUBLIC_BUILD_ID`）＝ 呢個分頁實際跑緊邊份 JS。
  -- 🔴 唔可以由 server 推導：server 只知「線上最新」，唔知「呢部機跑緊邊份」。
  build_id      text,

  opened_at     timestamptz not null default now(),
  -- 任何帶 `x-pos-session` 嘅請求（節流後）會更新呢個欄位 ⇒ 「最後上報時間」。
  last_seen_at  timestamptz not null default now(),

  -- 來源 IP / User-Agent：只為分辨「同一部機開多個分頁」同「邊部機」，唔做追蹤。
  ip            text,
  user_agent    text,

  -- 管理員下達強制關閉嘅記錄（軟踢：POS 端下次請求先見到）。
  revoked_at    timestamptz,
  revoked_by    text,
  revoke_reason text,

  -- 客戶端自報關閉（best-effort，例如撳「登出」）；正常關分頁唔會有。
  closed_at     timestamptz
);

-- 主要查詢：admin 頁按店分組 + 「最近上報」排序（只用 last_seen_at 就夠）。
create index if not exists pos_sessions_store_seen_idx
  on public.pos_sessions (store_id, last_seen_at desc);

-- 「全店／全部工作階段」列表 + 30 日清理。
create index if not exists pos_sessions_seen_idx
  on public.pos_sessions (last_seen_at desc);

-- 未生效嘅強制關閉（admin 頁「已下達待生效」KPI）用。
create index if not exists pos_sessions_revoked_idx
  on public.pos_sessions (revoked_at)
  where revoked_at is not null;

comment on table public.pos_sessions is
  'POS 網頁工作階段（每分頁一行）。由 /api/ledger/login 註冊、既有請求續期；admin 可強制關閉（軟踢）。';
comment on column public.pos_sessions.build_id is
  '客戶端內聯建置識別碼；同 readServerBuildId() 比較即可知該分頁係唔係跑住舊版本。';
