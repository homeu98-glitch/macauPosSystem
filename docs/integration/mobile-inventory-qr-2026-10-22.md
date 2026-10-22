# 手機版庫存表 QR（庫存頁掣 → 掃碼 → 自動登入 expenseRecorder）

> **日期**：2026-10-22 · **狀態**：✅ **已實作並已部署上雲**（POS `9d615e4`／expenseRecorder `670ad68`，兩個 Vercel build 均 success、新 endpoint 生產實測非 404）
> **剩用戶兩步設定先生效**：① 跑 SQL migration（§5）；② 複製 secret 去 POS Vercel（§5）
> **觸發實案**：J 要求 —— 「喺庫存頁面右上角加一個掣叫『手機版庫存表』，撿落去彈窗出
> 二維碼，掃完會去 expense-recorder-sigma.vercel.app，而且直接登入，直接可以使用。」

---

## 0. 一句話講晒

庫存頁右上角加「手機版庫存表」掣 → 彈窗顯示**一次性短碼 QR**（5 分鐘有效）→
手機一掃 → expenseRecorder 拎返真‧JWT → 走**現成 SSO 流程**自動登入 → 著陸首頁，
即刻用手機版庫存表。POS 前端零新頁、expenseRecorder 零新登入機制（复用 `/sso`）。

---

## 1. 點解 QR 入面唔直接放 JWT（設計取捨）

| 方案 | 可行性 |
|---|---|
| QR 直接載 JWT URL（~700 bytes） | ❌ 本 repo QR 編碼器（`lib/qrcode.ts`）最大 version 6 = **136 bytes**，編唔落 |
| QR 載 login_id + PIN | ❌ PIN 落 QR ＝ 長期可复用憑證，店內任何人影相都得；違反 SSO 設計原意 |
| **QR 載 10 位短碼，服務端換 JWT** | ✅ 73 bytes（v4 編碼器實測編到），短碼 ≈50 bit 暴力枚举唔現實 |

```
庫存頁「手機版庫存表」掣
  └─ POST /api/inventory/mobile-qr（posRouteAuthGuard 鑑權）
       ├─ 檢查 expenseRecorder 已有該店 shop_users 列（防止走入「隨機 PIN 新 row」陷阱）
       ├─ 簽 HS256 JWT（MACAU_LEDGER_SSO_SECRET，TTL 5 分鐘）
       └─ 寫 mobile_qr_sessions { code, sso_token, expires_at }
  ⇢ 回 { url: https://expense-recorder-sigma.vercel.app/api/auth/sso-qr?code=<10位> }
       └─ 彈窗用現有 QrSvg 渲染（33x33，v4）

手機掃碼
  └─ GET /api/auth/sso-qr?code=XXX（expenseRecorder，anon client）
       ├─ 查 mobile_qr_sessions → 過期／用過／缺表 → 錯誤頁（人話提示）
       ├─ delete-on-read（一次性）
       └─ 302 → /sso#ssoToken=<JWT>（fragment 唔落 server log）
            └─ 現有 SsoClient → POST /api/auth/sso-login
                 ├─ verifyMacauLedgerSsoToken()（iss/aud/exp/role=owner/店資訊）
                 ├─ jti 防重放（sso_token_logins）
                 ├─ shop_users 開通／配對（見 §3 login_id fallback）
                 └─ 落 expense_session cookie + localStorage → 著陸 "/"
```

## 2. 改動清單

### 2.1 macauPosSystem（本 repo）

| 檔案 | 動作 |
|---|---|
| `src/lib/expense-mobile-qr.ts` | 🆕 claims 組裝 + HS256 簽發 + Crockford 短碼 + store port + 缺表降級 |
| `src/lib/expense-mobile-qr.test.ts` | 🆕 26 條單測（claims 規格／簽名 round-trip／TTL clamp／短碼／缺表） |
| `src/app/api/inventory/mobile-qr/route.ts` | 🆕 POST endpoint（`posRouteAuthGuard` + 開通前檢查 + 簽發） |
| `src/components/inventory/mobile-qr-modal.tsx` | 🆕 彈窗（QR + 倒數 + 過期態 + 複製連結 + 重新產生 + 錯誤分類提示） |
| `src/components/inventory/inventory-view.tsx` | ✏️ header 右上加掣 + state + 掛載彈窗 |
| `.env.example` | ✏️ 新增 E 段（`MACAU_LEDGER_SSO_SECRET` 等 6 個變數） |

### 2.2 expenseRecorder（本機 `C:\dev\macauPos\expenseRecorder`）

| 檔案 | 動作 |
|---|---|
| `app/api/auth/sso-qr/route.ts` | 🆕 短碼換 JWT → 302 `/sso#ssoToken=`；失敗回自包含錯誤頁 |
| `app/api/auth/sso-login/route.ts` | ✏️ 兩處：① `external_shop_id` miss 時加 **login_id fallback**（見 §3）；② update 撞 `23505`（多員工店）降級唔寫 `external_shop_id` |
| `supabase_mobile_qr_sessions_v1.sql` | 🆕 migration：`mobile_qr_sessions` 表 + 順手確保 `sso_token_logins` 存在 |

## 3. 🔴 sso-login 點解要加 login_id fallback（核心修補）

原有 SSO 只按 `external_shop_id` 搵店。但 **2026-10-21 前喺 expenseRecorder 自冊嘅店
`external_shop_id` 全部係 NULL**（線上 11 間 live 店皆然，見
`expense-account-auto-provision-2026-10-21.md` §1.3／§1.4）。冇 fallback 嘅後果：

```
external_shop_id 搵唔到 → 行 INSERT 路徑 → login_id 撞 UNIQUE（23505）
  → 500「建立/更新店舖失敗」→ 手機版庫存表 QR 對現有店全部爛曬
```

修法：miss 時用 `owner.phone`（＝ POS 8 位帳號，兩邊帳號互通）行 `login_id` 配對，
配對到即走原有 update 分支 —— **保留原有 `login_pin`**（PIN 互通唔斷）、
補 `external_shop_id`。多員工店（第二個員工先至開手機版）撞 unique 時降級唔寫
`external_shop_id`，維持改動前行為。

## 4. 安全模型

| 環節 | 機制 |
|---|---|
| 端點鑑權 | `posRouteAuthGuard(request, storeId)`：POS 終端憑證（綁店）或 admin token；**未設 `POS_REQUIRE_DEVICE_AUTH` = fail-closed 強制**（`0` 先至關，緊急回滾用） |
| account 真值 | 由 **device token claims** 取（server 簽發），唔信 client body |
| 開通前檢查 | `shop_users` 必須有 `login_id=account` 或 `external_shop_id=storeId` 嘅列；缺少 → 409「請登出再登入」（因為 POS session 唔持久化 PIN，補唔到開通；缺少嗰陣 SSO INSERT 路徑會**隨機生成 PIN**，令帳號＋PIN 互通靜默失效） |
| JWT | HS256、5 分鐘 TTL（clamp 60..900，`POS_MOBILE_QR_TTL_SECONDS`）、一次性 jti |
| 短碼 | Crockford base32 10 位；**delete-on-read**；過期即拒 |
| Token 洩漏面 | 只出現喺 302 Location 嘅 **fragment**（唔落 server access log／referrer） |

## 5. 部署步驟（🔴 次序好重要，J 要做嘅只有 3 件）

1. **跑 SQL**（expenseRecorder Supabase Dashboard → SQL Editor）：
   `expenseRecorder/supabase_mobile_qr_sessions_v1.sql`
   （實測 production 而家 `mobile_qr_sessions` 未存在 → PGRST205。）
2. **設共享 secret**：expenseRecorder Vercel 已有 `MACAU_LEDGER_SSO_SECRET`；
   複製**同一值**去 POS Vercel Project → Environment Variables。
   （未設 → 彈窗顯示「尚未啟用（伺服器未設定 MACAU_LEDGER_SSO_SECRET）」，功能优雅降級。）
3. **Push**：兩個 repo 各自 push 上 main ⇒ Vercel 自動部署。

> 舊 session 注意：部署前已登入嘅商戶（localStorage session）按「重新整理」唔會重打
> `/api/ledger/login` ⇒ auto-provision 唔 fire。若彈窗顯示「庫存帳戶尚未開通」，
> **登出再登入一次**即可（同 2026-10-22 開通方案嘅已知限制）。

## 6. 測試同驗證結果（2026-10-22）

| 層 | 動作 | 結果 |
|---|---|---|
| 單測 | `src/lib/expense-mobile-qr.test.ts` | ✅ **26/26 pass** |
| 全測 | `node --test`（POS 全庫） | ✅ **2619 pass / 0 fail** |
| 型別 | `tsc --noEmit`（POS） | ✅ 0 error |
| lint | `eslint`（POS 5 個改動檔 + expenseRecorder 2 個改動檔） | ✅ 0 error |
| 跨 repo 互操作 | 用本 repo lib 簽 JWT → 用 expenseRecorder 官方 `verifyMacauLedgerSsoToken()` 驗；負面：錯 secret／過期／role≠owner 全部正確拒絕 | ✅ 全過 |
| QR 容量 | 真實 URL 73 bytes → 本 repo 編碼器實測 **33x33（v4）** 編得到；超長正確回 null | ✅ |

## 7. 已知限制／後續

| 項目 | 狀態 |
|---|---|
| 同一粒 QR 只可掃一次（一次性設計）；多人要人手「重新產生」 | 刻意（jti 防重玩本來就一次性） |
| expenseRecorder anon key 可讀 `shop_users.login_pin`（存量問題，2026-10-22 實測確認） | 🔴 **存量安全問題，非今次引入**：建議另開任務（RLS + server-side session + rotate PIN） |
| `sso_token_logins` 表若從未跑過 schema v2 ⇒ 每次 SSO 500 | 本 migration 已順手 `CREATE IF NOT EXISTS` 補齊 |
| 手機版著陸頁固定 `/`（expenseRecorder 首頁） | 如要直達某頁，改 claim `redirect.path` |
