# 148 · Ledger「商戶端活躍」（client presence）上報 —— POS 端實作

> **需求來源**：Ledger 2026-09-24 交接文檔（已歸檔 [`integration/pos-v3.6-partner-handover-client-presence.md`](integration/pos-v3.6-partner-handover-client-presence.md)），權威契約 **§4.6**。
> **狀態**：✅ 已實作 M1 + M2，型別檢查／eslint／單元測試（20 條）全綠。
> **未部署**：等 Ledger 方確認 migration 已 push + 契約 §4.6 到手後才上線。

---

## 一句話

店員喺 POS 用 Ledger 電話 + PIN **登入成功**（或分頁重開**恢復 session**）之後，用**店員 JWT** 打 Ledger Supabase 一支 RPC `record_merchant_client_login(merchant_id, 'pos', app_version)`，Ledger Admin `/admin` 卡片「**商戶端活躍與接入**」嘅 **POS 欄** 才會有時間。

**唔係**即時在線監控 —— 係「**近 30 日最後活躍**」，粒度只到「**店 × 端別**」（`web`／`sunmi`／`pos`），冇店員名、冇裝置 ID。
Ledger **唔** poll POS、**唔** 讀 POS 自有 Supabase ⇒ 資料**只**來自客戶端主動回報。

---

## 掛點（兩個，都係零新增請求）

| # | 位置 | 時機 | 為何掛喺度 |
|---|------|------|-----------|
| **M1** | `src/app/api/ledger/login/route.ts`（`await reportPosClientPresence(...)`，喺 `registerPosSession()` 之後、`return` 之前） | 店員登入成功 | 借用**已經存在**嘅登入請求：server 喺呢一刻已經有「**Ledger 專案 + 店員 session**」嘅 supabase client（`setSession()`）＋ 已知 `merchant_id` ⇒ 直接 `.rpc()`，client 唔需要再打一次、亦冇 CORS／JWT 外流問題。同 `registerPosSession()` 同一手法。 |
| **M2** | `src/lib/ledger/session.ts`（`ensureLedgerSession()` 內，module 級 latch 之後） | 分頁重開／PWA 恢復 session | 覆蓋「登入之後一直唔重登」嘅收銀機。**每個分頁載入最多一次** —— `ensureLedgerSession()` 被十幾處呼叫（訂單／會員／報表／券／Realtime），冇閂就會每次查詢都多打一支 RPC。 |

**M3（刻意未做）**：`onAuthStateChange` `TOKEN_REFRESHED`（約 1 小時一次／分頁）。只有 Ledger 投訴「活躍顯示過期」才加 —— 佢會為每個開住嘅分頁每小時多一支請求。

---

## 三條關鍵決策

1. **M1 一定要 `await`（唔係真 fire-and-forget）**：Vercel serverless 回應之後會凍結，唔 await 嘅 promise 隨時永遠唔完成（＝靜默冇上報）。模組內部用 `Promise.race` 將**上限封喺 3 秒**，所以 Ledger 打嗝最壞只係拖慢登入少少，**唔會拖死**（店員登入係返工唯一入口，唔可以因為 telemetry 而死）。
2. **`p_app_version` 用 `x-pos-build`**：登入頁本身已經帶 `x-pos-build`（＝**呢個分頁實際跑緊邊份 JS**），讀唔到就退回 `readServerBuildId()`。兩者都係建置識別碼。清洗規則仲會**拒收 8 位以上連續數字**（疑似澳門電話／PIN），寧願唔報版本都唔可以漏個號碼出去。
3. **失敗一律靜默**：任何錯誤（未跑 migration `PGRST202` / `42883`、網絡、超時、權限）都只 `console.warn`，回 `false`，呼叫端**唔可以做任何事**（唔彈提示、唔重試、唔阻 UI）。「Ledger 未部署 RPC」每個 process 只嘈一次，唔洗版。

---

## 檔案

| 檔案 | 動作 |
|------|------|
| `src/lib/ledger/client-presence-params.ts` | 新增 · **零 import**（`npm test` ＝ `node --test` 唔認 `@/`）· 參數清洗／UUID 檢查 |
| `src/lib/ledger/client-presence.ts` | 新增 · 執行端（超時封頂、永不 throw、警告去重） |
| `src/lib/ledger/client-presence.test.ts` | 新增 · 20 條（清洗、參數、成功／錯誤／thenable／超時／唔洗版） |
| `src/app/api/ledger/login/route.ts` | 改 · M1 掛點 |
| `src/lib/ledger/session.ts` | 改 · M2 掛點（module 級 latch + `resetPresenceLatchForTest()`） |

**冇新增 env**、**冇用** `SUPABASE_SERVICE_ROLE_KEY`（契約亦明文唔需要）、**冇加** polling／heartbeat route。

---

## 前置／未完成（上線前必查）

1. 🔴 **契約 §4.6 我哋手上未有** —— `docs/integration/ledger-client-api.md` 仍係 **v3.4（2026-09-11）**，連 v3.5 嘅 §5.12 都未有。RPC 嘅精確簽名、RLS 條件、節流語義現時只可以照交接文檔推。**已向 Ledger 索取最新契約**。
2. 🔴 **Ledger 側須已跑 migration `20260924120000_merchant_client_presence.sql`**。未跑 ⇒ RPC 回 `PGRST202` ⇒ 我哋靜默停用（log 一次），行為照舊。**唔係 POS 端可以自行修復**。
3. ⚠️ **環境要一致**：`NEXT_PUBLIC_SUPABASE_URL` 指 UAT 定正式？Ledger Admin 睇邊套，就要登入嗰套（UAT 登入唔會出現喺正式 Admin）。
4. ⚠️ 契約禁止項（已遵守）：**顧客 JWT 唔可以**打呢支 RPC（我哋只喺店員登入／店員 session 恢復兩處呼叫）；**唔可以**用 POS 自有 Supabase client 打（唔同專案）；**唔可以**為此加 polling route。

### 驗收步驟

1. 用示範店員（正式例：`60000002` / `2222`，店名通常「老饕牛肉麵 [示範]」）登入 POS。
2. DevTools Network 見 `rpc/record_merchant_client_login` **200**；或 log 冇 `[ledger/presence]` warn。
3. 開**同環境** Ledger Admin `/admin`（Dashboard 約 60s cache）→ 卡片「商戶端活躍與接入」該店 **POS** 欄顯示剛才時間（澳門時區）。
4. 對照：同一帳號登入 Ledger 商戶 Web `/merchant/login` 會更新「**網頁**」欄，兩端互不取代。

---

## 附：同本次改動無關嘅既有紅燈（順手記錄）

`npm test` 全套 1,498 條有 **1 條失敗**：

```
not ok 3 - legacyThrottled 節流骨架一定要回未結帳單，唔可以回空 orders
  src/lib/pos/pos-app-queue-base.test.ts:155  error: '節流骨架冇查未結帳單'
```

**唔關本次改動**（本改動只碰 `/api/ledger/login`、`lib/ledger/*`）。根因：`src/app/api/pos/state/route.ts` 現時用
`const openRes = await runOrderQueryWithColumnFallback(...)`，而守衛仍寫死舊 pattern `const openRes = await supabase`。
**守衛嘅意圖（該分支一定要回未結帳單、唔可以回 `orders: []`）仍然成立** ⇒ 屬舊 pattern 造成嘅假紅燈，唔係真回歸。
建議把守衛放寬為 `/const openRes = await (supabase|runOrderQueryWithColumnFallback)/`。**未改，等確認。**
