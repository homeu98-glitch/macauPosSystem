# 系統全面評估報告 — macauPos / macauPosSystem

> **審查日期**：2026-09-15
> **審查範圍**：`src/**`（447 個 TS/TSX）、`src/app/api/**`（57 條 route）、`supabase/migrations/**`（37 個 SQL）、`print-relay/`、`public/sw.js`
> **審查基線**：`main` @ `460a12d`（與 `origin/main` 同步、工作區乾淨）
> **方法**：靜態程式碼審查 + 實機指令驗證（`tsc --noEmit`、`node --test`、全端點鑑權掃描）

---

## 0. 執行摘要（結論先行）

| 面向 | 評級 | 一句話結論 |
|---|---|---|
| **功能完整度** | 🟢 良好 | 覆蓋堂食／快餐／線上單／打印／交班／報表／零售／Salon，已達試運營水準 |
| **程式碼品質** | 🟢 良好 | `tsc` 零錯誤、761 個單元測試 100% 通過、TODO 僅 3 處（全 repo 零 FIXME） |
| **穩定性** | 🟡 中 | 有完整同步／對賬／自癒設計，但存在 **3 個「靜默永久失效」路徑**與 **重複出紙**結構性風險 |
| **安全性** | 🔴 高風險 | **57 條 API 中 44 條無鑑權**；其中至少 **10 條**可被匿名者讀走 PII、清空訂單、冒充打印中繼 |
| **流暢度** | 🟡 中 | 主流程步數精簡（落單 2 步、無多餘彈窗），但巨型元件、28px 觸控目標、全頁 reload 拖慢體驗 |
| **雲端一致性** | 🟡 中 | 核心交易資料（訂單／打印／班次）已上雲；**設定類與零售／沽清／BOM 仍為本機權威**，多機不一致 |

### 🔴 最緊急的三件事（建議 7 日內完成）

1. **補上 API 鑑權**——`/api/salon/*`、`/api/backoffice/*`、`/api/inventory/*`、`/api/pos/orders`、`/api/pos/shift`、`/api/pos/print-agent/pair` 目前**任何人唔登入都叫得動**，而且它們用 service_role 連 DB（繞過 RLS）。這是**大規模個資外洩 + 營收資料可被刪除**的等級。
2. **修「同步 queue 永久閘住 backfill」**——`pos-app.tsx:1090`／`1702` 只要本機殘留**一筆** `failed` 或 `skipped` 事件，其他終端／掃碼客落的新單就**永遠唔會補回本機**（realtime 斷線期間漏的單補唔返）。這正是商家最怕的「掉線後永久收唔到單」。
3. **確認生產 DB 有跑 0016 / 0021 migration**——`0021` 檔頭自認「**未跑**」，而 0016 的 anon 讀取政策**冇 store_id 過濾**，揸住公開 anon key 即可讀全平台近 14 日訂單。

---

## 1. 現況盤點

### 1.1 系統規模

| 指標 | 數值 | 備註 |
|---|---:|---|
| TS/TSX 檔案 | 447 | 總行數 **112,434** |
| API Route | 57 | `src/app/api/**/route.ts` |
| SQL Migration | 37 | `supabase/migrations/*.sql` |
| 單元測試 | 45 檔 / **761 case** | `node --test`，**761 pass / 0 fail** |
| 文檔 | 153 個（`docs/`） | 含 128 篇 md、21 個 HTML 確認稿 |

**實測驗證結果**（本次親自執行）：

```
tsc --noEmit        → exit 0（零型別錯誤）
node --test         → # tests 761 / # pass 761 / # fail 0（與 npm run test 一致）
git status          → 工作區乾淨，main 與 origin/main 同步
```

> ✅ 這是一份**健康度相當好**的程式碼庫。問題唔在「寫得亂」，而在**架構選型的取捨未收口**（離線優先 vs 雲端權威）與**授權邊界只做了一半**。

### 1.2 最大檔案（技術債熱點）

| 行數 | 檔案 | 風險 |
|---:|---|---|
| **7,649** | `src/components/pos-app.tsx` | 55 個 `useState`、25 個 `useEffect` 集中一個元件——任何 state 變更重跑整棵樹 |
| 4,081 | `src/components/device-settings.tsx` | 設定頁全功能單檔 |
| 3,173 | `src/components/restaurant-daily-report.tsx` | 報表 |
| 2,339 | `src/components/shift-page.tsx` | 交班 |
| 1,997 | `src/components/print-center.tsx` | 打印中心 |
| 1,265 | `src/app/api/pos/sync/route.ts` | 同步契約單點（最關鍵、最難改） |

### 1.3 三個 Supabase 專案的職責

| 專案 | 環境變數 | 角色 | 是否服務端繞 RLS |
|---|---|---|---|
| **Ledger**（權威） | `NEXT_PUBLIC_SUPABASE_URL/_ANON_KEY` | 線上訂單、會員、店家/員工 | 否（anon） |
| **POS Supabase** | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | `pos_*`、`salon_*`、`admin_*` | **是** |
| **expenseRecorder** | `EXPENSE_SUPABASE_URL` + `_SERVICE_ROLE_KEY` | `inv_products`、`receipts` | **是** |

> 🔴 **關鍵連鎖**：`getSupabaseServerClient()`（`src/lib/supabase-server.ts:38-50`）會優先取 `SUPABASE_SERVICE_ROLE_KEY` → **繞過 RLS**。所以第 3 節的「API 無鑑權」不是「受 RLS 保護但沒驗身分」，而是**直接裸奔到資料庫**。

### 1.4 雲端覆蓋度盤點

#### 🟢 已完整上雲

| 類別 | 雲端真源 |
|---|---|
| 店內訂單 | `pos_orders`（`/api/pos/sync` 事件 + `/api/pos/state` 回填） |
| 打印任務 | `pos_print_jobs`（中繼 APK 拉取） |
| 餐牌／分類／桌台 | `pos_bootstrap_config` |
| 班次／交班 | `pos_shifts`（含 summary） |
| 打印模板（5 槽） | `pos_print_templates`（per-store + LWW） |
| 備註預設 | `pos_note_presets`（per-store 真源） |
| 店內營業開關 | `pos_store_status` |
| 商戶模組授權 | `pos_merchant_modules` |
| Kiosk 設定 | `pos_kiosk_settings` |
| 線上訂單／會員 | Ledger（**刻意唔落 POS 本機**） |
| Salon 大部分集合 | `salon_bookings/orders/customers/…` |

#### 🟡 部分上雲（語意錯位，最易埋雷）

| 項目 | 現狀 | 問題 |
|---|---|---|
| `localSettings.floors`（桌台佈局） | 本機優先，雲端只在新機採用 | A 機改枱，B 機睇唔到 |
| `paymentMethods`／`specTemplates`／`discounts` | 塞進 `pos_device_configs.local_settings`（**per-device**） | 讀取卻用「店最新一行」→ **最後保存的機蓋全店** |
| **`printZones`（打印分區 → KDS 分區來源）** | 同上 | KDS 工位會錯亂，代碼註解自認 P1 未做 |
| 打印機綁定 | `pos_device_configs.printers`（per-device） | 新機可能拉到別台機的設定 |
| 店員帳號 / PIN | 真源在雲端，但 `pin_code` **明文**、localStorage 有殘留快取 | 密碼學風險 + 快取與 DB 不一致 |
| 零售掃描器／秤重／審批門檻 | 只在「保存」時整份 POST；`DEVICE_CONFIG_UPDATED` 事件 payload **唔含這批欄位** | **離線時保存 = 永遠上唔到雲** |

#### 🔴 完全未上雲（本機為唯一真源）

| 缺口 | 後果 | 證據 |
|---|---|---|
| **沽清 `sold-out`** | 雲表 `pos_soldout` **有表冇任何寫入**；掃碼／Kiosk 照樣可點售罄菜 → 「點完才知冇貨」 | `lib/pos/soldout.ts:15-19` |
| **零售商品 + 庫存** | 換機全部消失；多機庫存唔一致（超賣） | `lib/storage.ts:284-298` |
| **`sync-queue` outbox 冇 IndexedDB 鏡像** | iOS 清 cache / 換機 → **未同步訂單事件永久丟失**（Salon 有 IDB、餐飲冇） | `lib/storage.ts:804-810` vs `salon/idb.ts:1-10` |
| **Kiosk／掃碼「待補推」隊列** | 客人已見落單成功頁，但換機／清 cache → **訂單蒸發** | `lib/pos/kiosk-outbox.ts:22-29` |
| 零售價籤模板 `retailLabel` | 雲表冇 `retail_label` 欄 | `api/pos/print-templates/route.ts:52` |
| 食譜 BOM / 人流計數 | 換機即失、成本報表失真 | `restaurant-bom.ts:43-62`、`restaurant-footfall.ts:14-46` |
| 營運模式（堂食／快餐）＋快餐參數 | A 機切快餐、B 機仍堂食 | `lib/storage.ts:1410-1438` |
| `printContentToggles`（自動打印開關） | 刻意 per-terminal → 多機行為不一致（漏單／重複出紙） | `print-toggles.ts:20` |
| 各類 tombstone / 診斷帳本（`deleted-orders`、`cleared-print-jobs`、`sync-acks`、`sync-blocked`） | 換機後已刪單可能被雲端 backfill 復活；同步阻塞無從追查 | `lib/storage.ts:868-1012` |

---

## 2. 安全性審查

### 2.1 全景數據（全端點掃描結果）

```
src/app/api/**/route.ts 共 57 條
  ├─ 有鑑權表徵（token / session / 簽名 / 限流）  13 條
  └─ 無任何鑑權表徵                            44 條
       ├─ 合理（登入端點、已廢棄回 410、公開中繼資料）  ~16 條
       └─ 🔴 實際風險                              ~28 條
```

**其他關鍵事實**：
- 🔴 **全 repo 冇 `middleware.ts`**（`Glob **/middleware.ts` → 0 命中）→ 授權只能逐 route 自己寫，**漏一條就係一個洞**。
- ✅ 做得好：`/api/admin/**` **有** `readAdminSessionFromRequest` 把關（`api/admin/merchants/route.ts:110-113`）——與 backoffice 形成鮮明落差。
- ✅ 做得好：`POS_REQUIRE_DEVICE_AUTH` 預設 **fail-closed（true）**（`lib/pos/pos-device-token.ts:136-140`）。

### 2.2 P0 — 嚴重（可匿名利用）

| # | 端點 | 問題 | 實際風險 | 證據 |
|---|---|---|---|---|
| **P0-1** | `GET /api/salon/state` | 完全無鑑權；**不帶 `storeId` 時回傳全平台所有店** | 一次 GET 拖走**所有分店**客人姓名、電話、生日、過敏史、會員餘額 | `api/salon/state/route.ts:138-200`（`mapCustomer` :69-89） |
| **P0-2** | `POST /api/salon/sync` | 完全無鑑權、無簽名、無限流；`storeId` 缺省 fallback `demo-salon-001` | 任何人可任意 `storeId` 偽造／覆寫客人、預約、訂單、店舖設定 | `api/salon/sync/route.ts:300-315` |
| **P0-3** | `GET/DELETE /api/pos/orders` | 完全無鑑權。GET 無 `storeId` 回**全部店**；DELETE 按 `storeId` 硬刪 | GET = 跨店讀單；**DELETE = 一鍵清空該店所有線下訂單**，營收紀錄無法復原 | `api/pos/orders/route.ts:5-17`（GET）、`:49-75`（DELETE） |
| **P0-4** | `GET/PATCH /api/backoffice/**` | 完全無鑑權（`GET()` 連 `request` 都冇收，無從鑑權） | 未登入者可列舉**全部員工帳號**（帳號／姓名／角色／權限組）並**停用任意門店** | `api/backoffice/overview/route.ts:5-12`；`api/backoffice/stores/[storeId]/route.ts:9-32` |
| **P0-5** | `POST /api/pos/print-agent/pair` | 只驗「`storeId` 是否真商戶」，**不驗請求者是否有權代表該店** | 攻擊者自備 `agentId`+`token` 即可註冊成該店中繼機 → **領走所有打印任務**（讀走菜品／枱號／金額）＋令真機出唔到紙 | `api/pos/print-agent/pair/route.ts:92-162`；`GET` 更回傳 `supabaseUrl`+`anonKey`（`:70-90`） |
| **P0-6** | `GET/POST /api/inventory/**`（8 條） | 用 service-role client，`store`／`account` **由 client 傳入**，多數無鑑權 | 跨店新增／修改／刪除庫存品、改盤點數、讀寫收據。身分只靠「知道 8 位登入號」 | `api/inventory/products/route.ts:10-39`；`lib/expense-inventory.ts:25-35`（`resolveExpenseUserId` 只查 `login_id`） |

### 2.3 P1 — 高

| # | 項目 | 風險 | 證據 |
|---|---|---|---|
| P1-1 | `GET/POST /api/pos/device-config` 無鑑權 | 可覆寫他店打印機綁定與 `printZones`（KDS 分區權威）→ 廚房單去錯機 | `api/pos/device-config/route.ts:6-77` |
| P1-2 | `GET/POST /api/pos/print-templates` 無鑑權 | 可改他店收據／廚房單模板內容，影響**實體出紙** | `api/pos/print-templates/route.ts:56,159-178` |
| P1-3 | `GET/POST /api/pos/shift` 無鑑權 | 可替他店收工、篡改 `actual_cash`／`cash_difference` 對賬數字、讀走交班財務 | `api/pos/shift/route.ts:120-124,174-214` |
| P1-4 | `GET /api/pos/print-jobs/status` 無鑑權 | 讀他店打印任務狀態與 `last_error` | `api/pos/print-jobs/status/route.ts:16-31` |
| P1-5 | `POST /api/pos/print-agent/unpair` 無鑑權 | 可撤銷他店中繼機 → 雲端打印中斷（DoS） | `api/pos/print-agent/unpair/route.ts:12-36` |
| P1-6 | **管理員 PIN 明文儲存並明文比對** | `where pin_code = ?` 直接查——DB／備份一外洩，全部 PIN 即時可用；4 位空間 + 限流只在記憶體 | `lib/admin-account-server.ts:72-77` |
| P1-7 | `/api/auth/login` 生產環境缺 mock 帳號防護 | mock 帳號硬編碼公開（`60000000`/`0000` 等）；若 Supabase 未設即可通過取得 session。`/api/admin/session` **有**擋，這條**冇** | `api/auth/login/route.ts:5-18` vs `api/admin/session/route.ts:45-51`；`lib/mock-data.ts:90-91` |
| P1-8 | **RLS：`pos_orders`／`pos_print_jobs` 對 anon 開放 SELECT 且無 `store_id` 過濾** | anon key 係編譯入瀏覽器的公開值 → `curl` 即可拉全平台近 14 日訂單 | `supabase/migrations/0016_security_rls_hardening.sql:141-143,156-158`；`0021` 檔頭自認「**未跑**」 |
| P1-9 | `print-relay/server.mjs` 認證係 placeholder 且綁 0.0.0.0 | `authenticate()` 任何非空 token 都通過；`WebSocketServer({port})` 無 host 限制 | `print-relay/server.mjs:14,30-35`；README 自承「auth 係 placeholder、無 rate limit」 |
| P1-10 | 全部 rate limit 係 in-memory per-instance | Vercel serverless 多實例下基本無效；`clientIp()` 只讀 `x-forwarded-for`（可偽造） | `lib/pos/rate-limit.ts:1-14,43-47` |

### 2.4 P2 / P3

| 級別 | 項目 | 證據 |
|---|---|---|
| P2 | `/api/pos/sync` 匿名通道可為任何已知 `storeId` 注入 `source: scan/kiosk` 訂單 | `api/pos/sync/route.ts:337-340,628-633` |
| P2 | `verifyAgent` 用非 timing-safe 字串比較（`!==`），同專案其他簽名驗證都用 `timingSafeEqual` | `lib/print-agent-server.ts:65` |
| P2 | `/api/pos/note-presets`、`/api/online-order-settings` 無鑑權 | 可改他店備註預設、關掉自動接單鏡像 |
| P2 | `/api/inventory/health` 無鑑權洩漏基建資訊（`shop_users_count`） | `api/inventory/health/route.ts:9-36`，代碼自註「上線前可移除」 |
| P2 | `pos_kds_item_state` RLS `USING (true)`；`pos_store_status` 同樣 | `0033_pos_kds.sql:70-73`、`0039_pos_store_status.sql:77-80` |
| P3 | `.env.local.example` 把 HiveMQ 密碼放 `NEXT_PUBLIC_` 前綴（**不良示範**；已確認 `src/` 無實際使用，暫無洩漏） | `.env.local.example:11-15` |
| P3 | `LEDGER_WEBHOOK_SECRET` 單一 secret 驗所有店（無 per-store key） | `lib/ledger/webhook-signature.ts:24-26` |
| P3 | `inventory/receipts` 拼接 PostgREST `.or()` 字串（來源為 UUID，風險低但非參數化） | `api/inventory/receipts/route.ts:94-99` |

### 2.5 ✅ 值得肯定的安全設計（不要改壞）

- **入站 webhook 簽名**：HMAC-SHA256 + timestamp 寫入 signing string + **5 分鐘時間窗** + `timingSafeEqual` → 正確防重放與 timing attack（`lib/ledger/webhook-signature.ts:51-71`）。
- **POS 終端憑證**：HMAC-SHA256 + `timingSafeEqual` + **綁 `storeId`** + `pv1` 版本隔離 + 12h TTL，並在 `/api/pos/sync` 逐事件驗 `event.storeId === 請求 storeId`（`lib/pos/pos-device-token.ts:63-119`）。
- **免 PIN 窗口**：KDF 派生獨立子密鑰、先驗簽後用資料（`lib/ledger/scan-debit-crypto.ts:69-117`）。
- **scan-debit 報價核價**：金額由自己 DB 讀、不信 client（`api/ledger/scan-debit/quote/route.ts:58-86`）。
- **無 XSS 面**：全 `src/` 零 `dangerouslySetInnerHTML` / `innerHTML` / `document.write`。

---

## 3. 穩定性審查

### 3.1 🔴 三個「靜默永久失效」路徑（最痛）

#### (1) 同步 queue 永久閘住 backfill —— 其他終端新單永遠收唔到

```ts
// src/components/pos-app.tsx:1090（mount / 重連 / queue 變更）
if (queue.some((event) => event.status !== "synced")) return;
// src/components/pos-app.tsx:1702（realtime onResubscribed）同樣
```

`queue` 的合法狀態含 `pending | synced | failed | skipped`。而 `skipped` 由 `discardFailedSyncEvent()` 寫入（`lib/pos/sync-flush.ts:244-263`）＝**永遠唔會變 `synced`**。

> **後果**：只要本機殘留**一筆** failed/skipped 事件，`loadRuntimeState()` 與訂單頁 backfill **永遠唔再執行** → 其他終端／Kiosk／掃碼客落的新單，在 realtime 斷線期間漏掉的部分**永遠補唔返**。這正是商家最怕的症狀。

#### (2) Realtime `CLOSED` 狀態冇處理 —— 斷線後永久靜默

4 個 hook 的重連閉環只判 `CHANNEL_ERROR` / `TIMED_OUT`，**冇 `CLOSED`**：
`lib/pos/use-pos-realtime.ts:96`、`lib/ledger/use-ledger-orders-realtime.ts:116`、`lib/ledger/use-ledger-products-realtime.ts:79`、`lib/kds/use-kds-realtime.ts:116`

配套缺陷：固定 `RECONNECT_DELAY_MS = 3000`（**無 backoff**）＋ `subscribe()` 無 in-flight guard ＋ `visibilitychange` 無條件重訂 → 切前景與 timer 並發時可**洩漏 channel**（先建的那條永遠唔會被 remove）。

> **對照**：KDS 屏有 60 秒看門狗（`lib/kds/use-kds-board.ts:374-385`）可以救，**收銀台 `/` 沒有任何等價看門狗**。
> **正面**：`probePosRealtimeTarget()` 開機自檢（`pos-app.tsx:1068-1084`）確實兌現了 docs/113 的教訓，做得對。

#### (3) 打印 worker 可被單一懸掛 fetch 整體鎖死

```ts
// lib/print-bridge/dispatch.ts:42
if (isFlushing) return loadPrintJobs();   // module-level 鎖
```
`relay-transport.ts:29` 內部 `await flushPosSyncQueue()`，而該函數的 `fetch` **冇 AbortController、冇 timeout**（`lib/pos/sync-flush.ts:558-578`）。

> **後果**：流動網絡 half-open 時 fetch 可懸掛數分鐘 → `isFlushing` 一直 true → 每 2.5 秒的 tick 全部直接 return → **所有打印（連 native / companion 路徑）一齊停擺**。

### 3.2 🔴 重複出紙：三條獨立路徑

| 路徑 | 機制 | 證據 |
|---|---|---|
| ① DB 重排 | APK 已出紙但 result POST 失敗 → 行停 `printing` → **60 秒後被重新認領**（最多 5 次） | `0035_print_job_stale_claim_requeue.sql:50,52-62`；`api/pos/print-agent/result/route.ts:51-56` |
| ② 多終端 | 每部收銀機用**自己 localStorage** 判 `hasKitchen` 去重 → 兩部機各自建一張廚房單 | `pos-app.tsx:1581-1605` |
| ③ in-memory 去重 | `printedAddonSignatures` 註解自認「reload 後重設」；60 秒 once-guard | `pos-app.tsx:179`、`lib/print-jobs.ts:653-663` |

**去重鍵不可靠**：`PrintJob.id` = `crypto.randomUUID().slice(0,8)`，**冇任何內容／語義去重鍵**；DB 亦無 `(store_id, order_id, ticket_type, printer_id)` 唯一約束（`0011_pos_core_tables.sql:61-73`）。

**附帶**：`PrintJob.ttl` **從未設定**（只在 `types.ts:1399` 定義、只被 `native.ts:109` 讀取）→ `0035:60` 的 TTL 守衛永遠成立 → **打烊前卡住的單，明早 APK 上線照印**，出現「隔夜突然出舊紙」。

### 3.3 卡住冇人知：收銀台對 `pending` / `printing` 零感知

```ts
// pos-app.tsx:449-455
const failedPrintJobs = jobs.filter(j => j.status === "failed");   // 只認 failed
// pos-app.tsx:1668-1696 的 onPrintJobUpsert → isTerminalUp 只認 printed / failed
```

而 DB 端早就有答案：`/prints` 每 8 秒輪詢並顯示 `pending`/`printing`（`print-center.tsx:392-410`）。
> **後果**：`pending` / `printing` 卡住的單，在**收銀台零提示、零紅標、零自我修正**，直到有人主動開 `/prints`（可能永遠）。若**完全未配對打印通道**，`dispatch.ts:76-78` 會維持 `pending` 且**唔寫 `lastError`** → 一張紙都唔出而收銀員完全唔知。

### 3.4 錯誤處理：`AppErrorBoundary` 定義了但**全項目零引用**

```
Glob src/**/app-error-boundary.tsx  → 存在（元件 :33）
Grep "AppErrorBoundary"             → 只回該檔自身，零 import
Root layout 只掛：PwaRegister / PrintFlushWorker / PosSyncFlushWorker / IosFocusHelper
唯一的 route error boundary：src/app/salon/error.tsx（只有 salon 段）
```

> **後果**：`/`（收銀主畫面）、`/orders`、`/prints`、`/kitchen`、`/expo` **全部無錯誤邊界**。任何 render 期例外 = 白屏，而該元件提供的三個自救入口（重載／清快取／返登入頁）**全部叫唔到**。全域亦零錯誤上報（無 Sentry／`reportError`），前端崩潰對營運方**完全不可見**。
>
> ⚠️ 而 `docs/reviews/functional-review.md:76` 卻把「錯誤邊界（`app-error-boundary.tsx`）」標為 **已完成 [x]** —— **文檔與現實不符**，值得留意。

### 3.5 其他穩定性要點

| 項目 | 現狀 | 評價 |
|---|---|---|
| 對賬守護 | 每 60 秒掃「本地終態但雲端未確認」、指數退避 15s→1h、連續 3 次標 blocked、**無待確認單時完全唔打網絡** | ✅ 設計優秀（`sync-reconcile-daemon.ts:25-85`） |
| 同步失敗告警 | 三種可見告警（琥珀卡／realtime 失效條／列印失敗紅卡） | ✅ 非靜默（`pos-app.tsx:7431-7515`） |
| Salon 同步 | **冇鑑權、冇對賬、冇 LWW；失敗 5 次即靜默刪除** | 🔴 與餐飲側口徑不一致（`salon/idb.ts:225,271-293`） |
| SW 快取 | `CACHE_NAME` 寫死 `"macau-pos-v20-7-31"`；非 navigate 的 GET 一律 **cache-first** | 🟡 `/icon`、`/apple-icon`、`/manifest.webmanifest` 會被永久鎖死（`public/sw.js:1,37-46`）；另 `pwa-register.tsx` 無新版本提示 |
| 離線判準 | 只用 `navigator.onLine` | 🟡 連著 AP 但無互聯網時系統自認在線（`lib/use-network-online.ts:8-10`） |
| 背景計時器 | `/` 常駐約 4~5 個 interval；`pos-app.tsx:1846` 的 30s 批次同步 deps 含 `pendingQueue` → queue 抖動時計時器不斷重建 → **實際可能久久不觸發**（與設計意圖相反） | 🟡 |

---

## 4. 流暢度審查

### 4.1 ✅ 做得好的地方

- **核心路徑步數精簡**：落單 = 選枱 → 加菜 → `sendToKitchen` 即出紙，**無多餘確認彈窗**（`pos-app.tsx:2222,2753,3498`）。
- **空狀態寫得好**：`local-orders-panel.tsx:528-531`、`kitchen-screen.tsx:488`、`expo-screen.tsx:261`。
- **`useMemo` 覆蓋合理**：55 個 state 配 32 個 `useMemo`，關鍵重運算（`visibleTables`、`openOrders`、`tableOrderMap`）都有 memo。
- **`/orders` 無限 re-render 歷史事故已修**：`orders-hub.tsx:70-90` 有完整記錄且已用 `useMemo` + `useCallback` 穩定（本次未發現活的無限 re-render）。

### 4.2 🔴 / 🟡 改善點

| # | 問題 | 影響 | 證據 |
|---|---|---|---|
| 1 | **購物車加減數量掣 `h-7 w-7`（28×28px）** | 收銀連續操作對象，iPad 誤觸率高（減錯變加錯）。同檔 `:4622` 註解自稱守 40px 準則，這裡卻破了 | `pos-app.tsx:5295,5307` |
| 2 | **每個 realtime 事件重複 `JSON.parse` 全量 orders/printJobs** | 旺季日結數百張單時，成本隨資料量線性上升 → 「新單彈出時畫面卡一下」 | `pos-app.tsx:1543,1571-1574,1676,1141-1147` |
| 3 | **`activeTable` 的 `useMemo` 內部讀 localStorage** | 切枱是高頻動作，每次重跑 `JSON.parse` + `normalizePosLocalSettings` | `pos-app.tsx:1720-1734` |
| 4 | **「手動更新」= 全頁 `window.location.reload()`** | 把使用者從當前作業硬抽離（state 全清、7,649 行元件重跑） | `pos-app.tsx:1409` |
| 5 | 打印 flush 逐張串行 + companion 5 秒逾時 | 20 張 pending 而 companion 無回應 → 一次 flush 最壞 **100 秒** → 「出紙慢幾十秒」 | `dispatch.ts:68-85`、`companion-transport.ts:40` |
| 6 | 每 2.5 秒 `pruneSentPrintJobs()`（全量讀寫 + 可能發 POST） | 持續背景負擔 | `dispatch.ts:94`、`print-jobs.ts:717-736` |
| 7 | 次要按鈕 < 40px：告警卡約 18px、訂單頁匯出 36px | 觸控誤觸 | `pos-app.tsx:7440,7455,7508`；`orders-hub.tsx:213,222` |
| 8 | **無 skeleton**，載入只有一行「正在載入門店設定…」 | 首次 hydrate 7,649 行元件期間零進度回饋 | `pos-app.tsx:4603-4604`、`layout.tsx:57-66` |
| 9 | 前置條件用 toast 事後打斷（未開工／離線／會員）而非事前 disable | 使用者撳下去才被拒 | `pos-app.tsx:4016-4019,4037-4041` |

### 4.3 結構性問題：單一元件承擔 55 個 state

`pos-app.tsx` = 7,649 行 / 55 `useState` / 25 `useEffect`。任何一個 state 變更都令整棵樹重跑 reconciler。

> 這不是靠加 `useMemo` 能救的——是**「一撳掣全畫面微頓」的結構性來源**。建議按工作台（堂食／快餐）與面板（購物車／桌台／訂單／打印）分拆。

---

## 5. 優化建議 · 可行性 · 優先順序

### 5.1 P0 — 立即處理（7 日內）

| # | 建議 | 工作量 | 可行性 | 風險若不做 |
|---|---|---|---|---|
| A1 | **建立統一 API 授權 guard**：新增 `src/middleware.ts` 或共用 `requirePosAuth(request, storeId)`，套用到 28 條無鑑權端點。優先次序：`salon/*` → `backoffice/*` → `inventory/*` → `pos/orders` → `pos/shift` → `pos/print-agent/pair|unpair` | 中（2-3 日） | 高——`readPosDeviceToken` 與 `readAdminSessionFromRequest` 已存在，是**套用**而非**發明** | 個資外洩、訂單被刪、交班數字被改 |
| A2 | **`/api/salon/state`、`/api/backoffice/overview`、`/api/pos/orders` 補 `storeId` 必填**（禁止無 filter 的全表查詢） | 小（2 小時） | 高 | 全平台資料一次拖走 |
| A3 | **確認生產 DB 已跑 0016 / 0021 / 0022**，並為 `pos_orders`／`pos_print_jobs` 的 anon SELECT policy **加 `store_id` 條件** | 小（SQL，1 小時） | 高 | 公開 anon key 即可讀全平台訂單 |
| A4 | **修 backfill 閘門**：`status !== "synced"` → 只對 `pending` 生效（failed/skipped 不應阻塞雲端拉取），並為 `skipped` 提供「轉回 pending」路徑 | 小（半日） | 高 | 掉線後永久收唔到單 |
| A5 | **打印 dispatch 加 timeout**：`flushPosSyncQueue` 的 fetch 加 `AbortController`（建議 8s），並為 `isFlushing` 加保險釋放 | 小（半日） | 高 | 一次網絡抖動 = 全店停印 |
| A6 | **`admin_account_users.pin_code` 改 hash + salt**（bcrypt/scrypt），登入改為取 hash 後本地比對 | 小-中（1 日，含 migration） | 中——需同步改寫入路徑與既有帳號遷移 | DB 外洩 = 全部 PIN 直接可用 |
| A7 | **`/api/auth/login` 補 mock 帳號生產防護**（照抄 `admin/session/route.ts:45-51`） | 極小（15 分鐘） | 高 | 預設帳密可登入 |
| A8 | **`verifyAgent` 改用 `timingSafeEqual`** | 極小（15 分鐘） | 高 | timing side-channel |

### 5.2 P1 — 短期（2-4 週）

| # | 建議 | 工作量 | 可行性 |
|---|---|---|---|
| B1 | **掛上 `AppErrorBoundary`**（root layout + 各 segment），並接錯誤上報通道 | 小（1 日） | 高 |
| B2 | **Realtime 補 `CLOSED` 處理 + 指數退避 + `subscribe()` in-flight guard**；為收銀台加 60 秒看門狗（複用 KDS 的 `use-kds-board.ts:374-385`） | 中（1-2 日） | 高 |
| B3 | **打印去重加內容鍵**：`(store_id, order_id, ticket_type, printer_id)` 唯一索引 + 前端由雲端查「已出紙」而非只信本機 | 中（2-3 日，含 migration） | 中——需同時改三端 |
| B4 | **`PrintJob.ttl` 落地**：builder 寫 `ttl = createdAt + N 小時` | 小（半日） | 高 |
| B5 | **收銀台顯示 `pending`/`printing` 逾時紅標**（不是只認 `failed`）；無打印通道時寫 `lastError` 並告警 | 小（半日） | 高 |
| B6 | **沽清上雲**：落單／手動標沽清時寫 `pos_soldout`（表與 anon select policy 已存在） | 小-中（1-2 日） | 高 |
| B7 | **`sync-queue` outbox 加 IndexedDB 鏡像**（複用 salon 的 `idbSet` 模式） | 中（1-2 日） | 高 |
| B8 | **rate limit 改持久化**（Upstash Redis / Supabase table），並為 `x-forwarded-for` 加可信層校驗 | 中（2-3 日） | 中 |
| B9 | **`printZones` / `paymentMethods` / `specTemplates` 移到店級專表**（現為 per-device 卻被當店級讀，代碼自認 P1 未做） | 中（3-5 日，含 migration + 三端） | 中 |

### 5.3 P2 — 中期（1-2 個月）

| # | 建議 | 工作量 |
|---|---|---|
| C1 | **分拆 `pos-app.tsx`**：按工作台 + 面板抽出，先抽購物車／桌台／訂單列表 | 大（1-2 週，需 UI 回歸測試） |
| C2 | **零售商品／庫存上雲**（新增 `retail_products` 表或複用 `inv_products`） | 中-大（1 週） |
| C3 | **`retailLabel` 上雲** + `DEVICE_CONFIG_UPDATED` 事件 payload 補齊零售欄位（現時離線保存＝永遠上唔到雲） | 小-中（2-3 日） |
| C4 | **Kiosk／掃碼待補推隊列改寫雲**（現時換機 = 客人訂單蒸發） | 中（3-5 日） |
| C5 | **SW 快取策略修正**：build id 注入 `CACHE_NAME`，非雜湊資產改 stale-while-revalidate，加「有新版本請重整」提示 | 小-中（1-2 日） |
| C6 | **BOM／人流計數上雲**（BOM 可接 Ledger `menu_item_ingredients`） | 中（3-5 日） |
| C7 | **Salon 同步補齊**：加鑑權 + 對賬 + LWW；salon shift 補雲表 | 中（1 週） |
| C8 | **前端效能**：realtime 事件改讀 React state 而非重 parse；`activeTable` memo 去 localStorage；手動更新改就地 merge | 中（3-5 日） |
| C9 | **觸控與骨架屏**：加減掣 → 40px；各頁補 skeleton | 小（1-2 日） |
| C10 | **提交訊息規範**：現時大量 commit 只寫 "up"，事後無法追溯 | 極小（約定） |

---

## 6. 三面向具體結論

### 6.1 穩定性

**結論：架構設計優秀，但存在「靜默失效」盲區，屬「平時好、出事難救」。**

- ✅ **強項**：離線優先 + outbox + 60 秒對賬守護 + 指數退避 + 三層可見告警 + Realtime 開機自檢，這套組合在 POS 領域屬**上游水準**。761 個測試全綠、`tsc` 零錯誤，回歸風險可控。
- 🔴 **短板**：三條「靜默永久失效」路徑（backfill 被 queue 閘死、Realtime `CLOSED` 無處理、打印 worker 被懸掛 fetch 鎖死）＋ 三條重複出紙路徑 ＋ 全應用無錯誤邊界。
- **共同病根**：**「狀態機只處理 happy path」**——`skipped` 冇出口、`CLOSED` 冇重訂、`pending`/`printing` 冇逾時上報、`ttl` 冇設定。所有 bug 都是「某個狀態進入後沒有出路」。
- **改善方向**：為每個狀態機**補終態與逾時出口**；把「看門狗」從 KDS 推廣到收銀台；把錯誤邊界真正掛上。

### 6.2 安全性

**結論：交易層防護紮實，但**授權覆蓋率不足一半**，屬最高風險項。**

- ✅ **強項**：webhook HMAC + 時間窗、POS 終端憑證（綁店 + timing-safe + TTL）、scan-debit 子密鑰、RSL 加固 0016 收窄了 11 張表、零 XSS 面。**核心交易路徑（`/api/pos/sync`、`/api/pos/state`）是真的守住了。**
- 🔴 **短板**：57 條端點中 44 條冇鑑權表徵，其中約 28 條有實際風險；**冇 `middleware.ts`** 導致授權靠逐條自律；服務端用 service_role 連 DB → **無鑑權 = 直接裸奔資料庫**。
- 🔴 **最嚴重**：`salon/state`（全平台客人 PII 一次拖走）、`pos/orders DELETE`（營收紀錄可被一鍵清空）、`backoffice/*`（員工帳號列舉 + 停用門店）、`print-agent/pair`（冒充中繼機竊取打印內容）、`inventory/*`（跨店庫存寫入）。
- **改善方向**：**不要逐條補**——建立**統一的授權 middleware / guard**，先收口高風險群組（salon → backoffice → inventory → pos 設定類），再做 per-store key 與持久化限流。

### 6.3 流暢度

**結論：操作步數已相當精簡，瓶頸在「巨型元件 + 全量 JSON parse + 過小觸控目標」。**

- ✅ **強項**：落單／出紙／結帳主流程冇多餘確認；空狀態文案清楚；`useMemo` 覆蓋合理；歷史上的無限 re-render 已修。
- 🟡 **短板**：7,649 行 / 55 state 的巨型元件是「一撳掣全畫面微頓」的結構性來源；每次 realtime 事件重 parse 全量 orders；購物車加減掣只有 28px；「手動更新」觸發全頁 reload；無 skeleton。
- **改善方向**：先做**低成本高回報**的三項——加減掣放大到 40px、realtime 事件改讀 state、`activeTable` memo 去 localStorage；**元件分拆列入中期**，需配合 UI 回歸測試（可複用 `pos-ui-live-verify` 流程）。

---

## 7. 不確定 / 需人工確認清單

| # | 項目 | 為何無法從程式碼定論 |
|---|---|---|
| 1 | 生產 DB 是否真的跑過 0016 / 0021 / 0022 | `0021` 檔頭自認「未跑」；需在 Supabase 跑 0016 §5 驗收 SQL |
| 2 | `POS_REQUIRE_DEVICE_AUTH` 在 Vercel 生產的值 | 若設為 `0`，`pos/state`、`pos/sync`、`kiosk-settings` 等授權同時失效（預設 fail-closed，但環境變數無法從 repo 得知） |
| 3 | `ADMIN_SESSION_SECRET` / `POS_DEVICE_TOKEN_SECRET` / `LEDGER_WEBHOOK_SECRET` / `POS_SCAN_DEBIT_SECRET` 是否已在生產設定 | 未設會 fail-closed（安全）但功能會壞，易被誤判為 bug |
| 4 | `print-relay/server.mjs` 是否真的部署在公網 | repo 內只是 skeleton（auth placeholder、出紙 stub） |
| 5 | `desktop-companion/server.mjs` 是否存在 | `companion-transport.ts:4` 引用該路徑，但全 repo **找不到**該目錄；其 `/api/print` token 驗證無從稽核 |
| 6 | `x-forwarded-for` 是否由可信層清洗 | 若 Vercel 前置未覆寫，`clientIp()` 與限流都可被偽造 header 繞過 |
| 7 | `admin_*` / `backoffice_*` 表是否開 RLS | `0016` 清單不含這批表；需查 `pg_class.relrowsecurity` |
| 8 | 8 位 `shop_users.login_id` 是否連續／可枚舉 | 決定 P0-6 的實際爆破難度 |
| 9 | `pos_orders.created_at` 是否有 `NOT NULL` 約束 | 0016 的 policy 用 `coalesce(created_at, now())`，NULL 會被放行 |

---

## 8. 建議執行順序（一句話版）

> **先關門（A1-A3，7 日，零功能改動）→ 再修靜默失效（A4-A5 + B1-B2，2 週）→ 然後補一致性（B6-B9，4 週）→ 最後分拆重構（C1-C9，1-2 個月）。**
>
> A 組全部是**收口既有函式**（`readPosDeviceToken` / `readAdminSessionFromRequest` 已存在），**風險極低、收益極高**，建議立即開工。
