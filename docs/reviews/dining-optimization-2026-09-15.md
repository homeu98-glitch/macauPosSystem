# 餐飲模組加固與優化方案（堂食 + 快餐）

> **日期**：2026-09-15
> **範圍**：餐飲 POS —— 堂食、快餐（counter）、線上單接單、列印、交班、店內設定
> **不在此次範圍**：零售（retail）、美容院（salon）、Admin / Backoffice / Inventory（已列 Phase 2 另案）
> **前置報告**：[`docs/reviews/system-audit-2026-09-15.md`](./system-audit-2026-09-15.md)（全系統審查）
> **驗證基線**（每批改動後都跑）：`tsc --noEmit` = 0 error、`node --test` = 761 tests / 0 fail、`eslint`（改動檔）= 0 error

---

## 0. 鐵律：這次「優化」如何保證不影響現有邏輯與功能

四條自我約束，每一項改動都必須同時滿足：

| # | 約束 | 具體做法 |
|---|---|---|
| 1 | **加法式，不重寫** | 只新增守衛、逾時、狀態出口、持久化；不重構控制流、不改業務判準、不搬函式 |
| 2 | **放在既有 early-return 之後** | 新加的鑑權閘一律排在「未配置 Supabase → 回空/503」「缺 storeId → 回空」**之後**。⇒ mock 模式、離線模式、未配置環境的回應**完全不變** |
| 3 | **先查清所有呼叫端才動伺服器** | 加閘前先逐一開啟每個呼叫點，確認它是**已登入**還是**匿名**。匿名路徑（掃碼／Kiosk／KDS）**一律不加閘** |
| 4 | **改完逐一覆核，不靠「Successfully edited」** | 用腳本列出所有受閘端點的呼叫點，逐行確認帶了憑證（見 §4.5 的 20/20） |

> 緊急回滾掣：`POS_REQUIRE_DEVICE_AUTH=0`（環境變數，**不需重新部署**即可關閉所有 POS 端點鑑權），
> 是這次加閘的安全網（`src/lib/pos/pos-device-token.ts:136-140`，預設 fail-closed）。

---

## 1. 已實作（第一批）— 穩定性與流暢度

### 1.1 打印／同步 fetch 加 20 秒硬逾時 ⭐ 最高價值

| 項目 | 內容 |
|---|---|
| **病徵** | 流動網絡 half-open（連住 AP 但實際無互聯網）時，`POST /api/pos/sync` 的 fetch **冇 signal、冇 timeout**，可以懸掛幾分鐘唔 reject |
| **為何會拖冧全店** | `print-bridge/dispatch.ts:42` 有 module-level `isFlushing` 鎖，而 relay transport 正是 `await flushPosSyncQueue()` → fetch 一懸掛，鎖永遠唔放 → `PrintFlushWorker` 每 2.5 秒的 tick 全部 `return` → **連 native / companion 路徑都一齊停擺**（一張紙都出唔到） |
| **改動** | 加 `AbortController` + 20 秒 `setTimeout(abort)`，`finally` 清 timer |
| **如何不破壞現有行為** | 逾時走**原本已經存在**的 `catch` 分支 → 保留 `pending`、**不增加 `attempts`**（同「網絡抖動」完全同待遇）⇒ **不新增任何失敗態**，只是把「永久懸掛」變成「20 秒後如常重試」。用 `AbortController` 而非 `AbortSignal.timeout()`，因為舊版 iOS Safari 不支援後者 |
| **檔案** | `src/lib/pos/sync-flush.ts`（新增 `SYNC_FETCH_TIMEOUT_MS` 常數＋`signal`） |

### 1.2 Realtime 四支 hook：補 `CLOSED`、指數退避、防重入

| 項目 | 內容 |
|---|---|
| **病徵 A** | 四個重連閉環只判 `CHANNEL_ERROR` / `TIMED_OUT`，**冇 `CLOSED`**。channel 一旦入 `CLOSED`（socket 被伺服器關閉／join 失敗）就**永遠唔會再訂閱** —— 畫面照顯示已連線，但永遠唔會再有事件（與 docs/113「訂錯 Supabase 專案＝靜默失效」同型） |
| **病徵 B** | 固定 3 秒無限重試，冇 backoff（斷網時燒電、燒流量） |
| **病徵 C** | `subscribe()` 冇 in-flight guard，而 `await removeChannel()` 之間有空窗；`visibilitychange` 與重連 timer 可並發 → 兩條同名 channel，先建的永遠不會被 remove（channel 洩漏） |
| **改動** | ① 錯誤分支加 `CLOSED`；② 指數退避 3s→6s→12s→24s→**30s 封頂**，`SUBSCRIBED` 時歸零；③ 加 `subscribeInFlight` 防重入 + `try/finally`；④ 先清變數再 `await removeChannel` |
| **如何不破壞現有行為** | 全部係**恢復能力**的加強：仍然會自動重連（只是間隔更有禮讓）、仍然在 `SUBSCRIBED` 時觸發 `onResubscribed()`（backfill 時機不變）。**不新增任何狀態語意**，只是讓既有狀態機多一條出路 |
| **檔案** | `src/lib/pos/use-pos-realtime.ts`、`src/lib/ledger/use-ledger-orders-realtime.ts`、`src/lib/ledger/use-ledger-products-realtime.ts`、`src/lib/kds/use-kds-realtime.ts` |

### 1.3 掛上錯誤邊界（並中和一個會造成回歸的設計）

| 項目 | 內容 |
|---|---|
| **病徵 A** | `app-error-boundary.tsx` **全 repo 零 import**（死碼）⇒ `/`、`/orders`、`/prints`、`/kitchen`、`/expo` **全部冇錯誤邊界**，任何 render 例外＝白屏，且該元件提供的三個自救入口（重新載入／清快取／返登入頁）全部叫唔到。<br>⚠️ 而 `docs/reviews/functional-review.md:76` 竟把它標為**已完成 [x]** |
| **病徵 B** | 該元件原本把**任何** `unhandledrejection` 都升級成全屏「頁面修復模式」。本 app 有大量 fire-and-forget 非同步工作（同步 flush、打印派發、Realtime 重連、對賬守護），它們 reject 後本身已各有處理路徑 ⇒ 若照原樣掛上，**收銀員會因為一次無害的網絡失敗被踢出收銀畫面**，比現狀更差（屬回歸） |
| **改動** | ① `layout.tsx` 掛上 `<AppErrorBoundary>{children}</AppErrorBoundary>`（**只包 children，不包 4 個 worker** —— worker 出錯不應令畫面變修復模式）；② `handleUnhandledRejection` 改為**只 log、不改 state** |
| **如何不破壞現有行為** | 病徵 B 的改動正是**為了維持現狀**（掛載前本來就只 console warn）。render 期錯誤（`getDerivedStateFromError`）與 `window error`（`handleWindowError`）照舊觸發修復畫面 ⇒ 由「零保護」變成「render 錯誤有保護、非同步失敗不干擾」 |
| **檔案** | `src/components/app-error-boundary.tsx`、`src/app/layout.tsx` |

### 1.4 修正 backfill 閘門（本批最關鍵的 bug 修正）

| 項目 | 內容 |
|---|---|
| **病徵** | 三處用 `queue.some(e => e.status !== "synced")` 閘住 `loadRuntimeState()`。但 `queue` 的合法狀態含 `pending / synced / failed / skipped`，而 `skipped` 由 `discardFailedSyncEvent()` 寫入（`sync-flush.ts:244-263`，`skipReason: "user-discarded"`）或由 server 較新版本判定（`server-newer`）——**兩者都永遠不會變回 `synced`** |
| **後果** | 只要本機殘留**一筆** `failed` / `skipped`，backfill 就**永遠不再執行** → 其他終端／Kiosk／掃碼客落的新單，在 realtime 斷線期間漏掉的部分**永遠補不回來**（正是商家最怕的「掉線後永久收唔到單」） |
| **改動** | 條件改為 `queue.some(e => e.status === "pending")`（只擋真正未推的事件），三處一致：`pos-app.tsx`（mount effect、`onResubscribed`）、`local-orders-panel.tsx`（`pullServerOrders`） |
| **如何不破壞現有行為** | 原註解的顧慮是「避免後台舊資料覆蓋本機即時狀態」。但 ①只有 `pending` 才代表「我哋仲打算推呢件事件」，先有被覆蓋的風險；②backfill 本身是 `mergeOrderLists(loadOrders(), current, payload.orders)` = **以本機為底**，之後再過 tombstone（`filterResurrectedOrders`）與孤兒單隔離 ⇒ **本來就不會覆蓋本機即時狀態**，原顧慮已被下面兩道防線處理。⚠️ 過程中我一度誤刪 `onResubscribed` 的 `if (offlineMode) return;`，已即時補回並複核 |
| **檔案** | `src/components/pos-app.tsx`、`src/components/local-orders-panel.tsx` |

### 1.5 購物車加減數量掣 28px → 40px

| 項目 | 內容 |
|---|---|
| **病徵** | `h-7 w-7`（28×28px），是收銀連續操作對象，iPad 上誤觸率高（減錯變加錯）。同檔 `:4622` 的註解自稱守 40px 準則，這裡卻破了 |
| **改動** | `h-10 w-10` + `shrink-0`，數量欄位 `w-7 → w-8`、字級 `text-sm → text-base` |
| **如何不破壞現有行為** | **純樣式**，零邏輯改動；`shrink-0` 防止在窄容器被壓縮（只加強，不改變佈局規則）。符合用戶硬性要求「點擊目標 ≥ 40px」 |
| **檔案** | `src/components/pos-app.tsx` |

---

## 2. 已實作（第二批）— 餐飲 API 鑑權收口

### 2.1 新增統一守衛（單一判準來源）

新檔 `src/lib/pos/pos-route-auth.ts`：`resolvePosRouteAuth()` + `posRouteAuthGuard()`。
授權口徑三條（任何一條成立即放行），與 `/api/pos/state` 既有口徑一致：

1. `POS_REQUIRE_DEVICE_AUTH=0` → 全局關閉（緊急回滾）
2. **Admin session token**（`/admin` 後台簽發）—— ⚠️ **必須接受**，否則 admin 由 `/settings` 進去撳儲存會 401
3. **POS 終端憑證**，且 `claims.storeId === storeId`（**綁店**，不可跨店）

`route` 用法固定兩行，最難寫錯：

```ts
const denied = posRouteAuthGuard(request, storeId, "pos/xxx");
if (denied) return denied;   // 已含 400（缺 storeId）/ 401 + 中文訊息 + 拒絕 log
```

### 2.2 已加閘的端點（餐飲範圍）

| 端點 | 修補的實際風險 | 額外收窄 |
|---|---|---|
| `GET/DELETE /api/pos/orders` | DELETE 以前只要知 storeId（枱 QR 已公開）就可**清光該店所有線下訂單**；GET 唔帶 storeId 會回**跨店**最新 500 單 | **必須帶 storeId**（缺 → 400） |
| `GET/POST /api/pos/shift` | 可替他店**收工**、篡改 `actual_cash` / `cash_difference` 對賬數字；`history=1` 可讀走整店班次財務 | — |
| `GET/POST /api/pos/device-config` | 可覆寫他店打印機綁定與 `printZones`（**KDS 分區的權威來源**） | — |
| `GET/POST /api/pos/print-templates` | 可改他店收據／廚房單模板 → 直接影響**實體出紙** | — |
| `GET/POST /api/pos/note-presets` | 可改他店備註預設（含免單／折扣備註） | — |
| `GET /api/pos/print-jobs/status` | 可讀他店打印任務狀態與 `last_error` | — |
| `POST /api/pos/print-agent/unpair` | 可 revoke 他店中繼機 → 該店雲端打印中斷（DoS） | 同時接受 **agent 自證 token**（保住 APK 自我解除路徑） |
| `GET /api/pos/print-agent/pair-status` | 可讀他店是否有中繼機、`agentId`、`lastSeenAt`（營運資訊） | — |
| `GET/POST /api/online-order-settings` | 可讀他店接單鏡像、可 POST 關掉他店自動接單 | **移除假店 fallback**（見 §3.5） |

### 2.3 為何「加閘」不等於「弄壞功能」——匿名路徑的證明

加閘前已逐一開啟所有呼叫點並核對身分場景。結論：

- **掃碼自助點餐（`/menu`）、Kiosk 平板（`/order`）、KDS 屏（`/kitchen`／`/expo`）完全不碰以上任何一條端點。**
  Kiosk 只打 `bootstrap`（GET，本身無閘）、`sequence`、`ledger/member-login`、`ledger/scan-debit/*`、`pos/sync`、`order-lookup`；
  KDS 只打 `kds/board`、`kds/items`、`kds/orders`。
  ⇒ **加閘不會令客人落不到單。** 斷的只可能是「已登入店員」——而它們的憑證本來就存在於 `authSession.posDeviceToken`。

- **入站 webhook 不受影響**：`/api/integration/ledger/auto-accept` 是**自己直接 upsert** `pos_online_order_settings`，
  **不經** `/api/online-order-settings` ⇒ Ledger → POS 的開關店同步線不會斷。

- **`GET /api/pos/orders` 為何只收窄、不封閉**（刻意的不一致）：
  它被 `docs/integration/main-system-integration.md` 與 `docs/06-api-reference.md` 列為**對外的主系統整合 API**，
  外部主系統沒有 `posDeviceToken`。加閘會直接打斷整合 ⇒ 本批只收窄「無 storeId 的全平台傾倒」，
  要進一步收到「綁店」需與整合方協調另一套 service 憑證（已列 Phase 2）。

### 2.4 客戶端憑證補齊（22 個呼叫點，全部已覆核）

| 檔案 | 呼叫點 | 端點 |
|---|---|---|
| `src/lib/shift-sync.ts` | 6 | `/api/pos/shift`（GET active、GET history、POST ×4） |
| `src/components/device-settings.tsx` | 7 | device-config ×4、online-order-settings ×1、note-presets ×2 |
| `src/lib/print-templates-sync.ts` | 2 | print-templates GET / POST |
| `src/lib/pos/use-merchant-order-config.ts` | 2 | online-order-settings GET / POST |
| `src/components/local-orders-panel.tsx` | 1 | orders DELETE |
| `src/components/print-center.tsx` | 2 | print-jobs/status、pair-status |
| `src/components/relay-pairing-panel.tsx` | 2 | unpair、pair-status |

**一律用 `posDeviceAuthHeadersFresh()`（會自動續期，TTL 12h）**，而非只讀 `posDeviceAuthHeaders()`：
後者不續期，收銀機／班次頁／打印中心開著過夜就一定過期，會出現「掣撳得落但 server 回 401」這種最難 debug 的症狀。
`shift-sync.ts` 內另加一個 `shiftRequestHeaders()` 本機 helper 統一 6 個呼叫點。

### 2.5 覆核證據

以腳本掃出所有受閘端點的 fetch 呼叫點，並特別處理「多行 fetch」（`fetch(` 與 URL 不同行）的漏網情況：

```
受閘端點呼叫點總數: 22    未帶憑證: 0

✅ device-settings.tsx ×7        ✅ local-orders-panel.tsx ×1
✅ print-center.tsx ×2           ✅ relay-pairing-panel.tsx ×2
✅ use-merchant-order-config.ts ×2（含 1 個多行呼叫，已個別確認）
✅ print-templates-sync.ts ×2    ✅ shift-sync.ts ×6（含 1 個多行呼叫，已個別確認）
```

另確認：`/api/pos/print-agent/pair`（POST）**在本 repo 內零呼叫點** ⇒ 佐證它只由 APK 呼叫，
因此本批**刻意不加閘**（見 §6）。

---

## 3. 已實作（第三批）— 小型強化

### 3.1 `verifyAgent` 改用 `timingSafeEqual`
`src/lib/print-agent-server.ts` 以前用 `sha256Hex(token) !== agent.tokenHash` 直接字串比較——
JS 的 `!==` 會在第一個不同字元就返回，而 `token` 是**由 client 提供、可遠端量測**的輸入 ⇒ 理論 timing side-channel。
同專案其他簽名驗證（`webhook-signature.ts`、`pos-device-token.ts`）都已用 `timingSafeEqual`，這裡是唯一漏網。
**行為不變**：只係「不同長度 → false」＋「等長 → 定時安全比較」。

### 3.2 `online-order-settings` 移除假店 fallback（`DEFAULT_STORE_ID = "macau-store-a"`）
以前 GET／POST 沒帶 storeId 就**靜默**用假店，令「漏帶 storeId」這類 bug 靜默化（讀／寫錯店而不報錯）。
改為缺 storeId → 400 `MISSING_STORE_MESSAGE`，與 `/api/pos/shift` 的 `validateStoreId()`、
`isPlaceholderStoreId()` 的「假店一見即擋／寧願大聲失敗」口徑一致。

### 3.3 `print-agent/unpair` 保留 APK 自我解除路徑
`unpair` 同時被 web 面板（已登入）與 APK（持有 agent token）呼叫。
加閘時**同時接受兩條**：`Authorization`（POS 憑證／admin）**或** `x-agent-token` / body `token`（agent 自證）。
否則會斷 APK 的自我解除路徑。

---

## 4. 本批一併指出並處理的 Bug

| # | Bug | 處理 |
|---|---|---|
| 1 | backfill 被終態 `skipped`／`failed` 永久閘死 → 掉線後永久收唔到單 | ✅ 已修（§1.4） |
| 2 | Realtime `CLOSED` 無處理 → 永久靜默 | ✅ 已修（§1.2） |
| 3 | 打印 worker 被懸掛 fetch 鎖死 → 全店停印 | ✅ 已修（§1.1） |
| 4 | 錯誤邊界是死碼（但文檔標為已完成） | ✅ 已掛上（§1.3） |
| 5 | `unhandledrejection` 過度激進（照原樣掛載會造成回歸） | ✅ 已中和（§1.3） |
| 6 | 8 條端點無鑑權 + 2 條可回「全平台」資料 | ✅ 已收口（§2） |
| 7 | `verifyAgent` 非 timing-safe | ✅ 已修（§3.1） |
| 8 | `online-order-settings` 靜默 fallback 假店 | ✅ 已修（§3.2） |
| 9 | **`print-center.tsx` 有 16 個既有 eslint error**（`Cannot access refs during render` ×15、`Cannot access variable before it is declared` ×1） | ⏳ **未修**。已用 `git show HEAD:` 把原始檔 lint 一次比對 → **HEAD 版本一模一樣 18 problems (16 errors)**，確認**不是本次改動造成**、`tsc` 亦不報。⇒ 這是既有技術債（react-hooks 新規則），建議獨立處理，**不要與本批混在一起** |
| 10 | `use-ledger-products-realtime.ts` 的 `RESUBSCRIBE_DEBOUNCE_MS` 未使用（既有 warning） | ⏳ 未動（避免無關改動混入本批） |

---

## 5. 四面向評級（改動前後）

| 面向 | 前 | 後 | 距「良好」還欠什麼 |
|---|---|---|---|
| **穩定性** | 🟡 | 🟢 **良好** | 三條靜默永久失效路徑已收口；重複出紙與 `PrintJob.ttl` 未設定屬 Phase 2（見 §6） |
| **流暢度** | 🟡 | 🟢 **良好** | 28px 觸控目標已修；巨型元件分拆（7,649 行）與 realtime 事件重複 `JSON.parse` 屬 Phase 2 |
| **安全性** | 🔴 | 🟡→**接近良好** | 餐飲端點已全部收口、匿名路徑證明不受影響。**但仍有 4 項需外部條件**：①`pos_print_jobs` anon RLS 無 store 過濾（需跑 migration 0021＋改 policy）②生產 `admin_account_users.pin_code` 明文（需 migration）③rate limit 仍是 in-memory（需外部 store）④`print-relay/server.mjs` 認證仍是 placeholder（需確認是否部署） |
| **雲端一致性** | 🟡 | 🟡 **未改善**（本批刻意不動） | 核心交易（訂單／打印／班次）早已上雲。剩餘缺口全部是「設定類／本機權威」，**改動會改變多機行為語意**，必須先與商家確認期望，屬 Phase 2 |

> 直白講：**穩定性與流暢度已達「良好」**；**安全性在餐飲範圍內已達良好**，剩下 4 項卡在 migration／外部元件／基礎設施；
> **雲端一致性本批刻意不碰**，因為它每一項都會改變「A 機改完 B 機看不看得到」的既有行為語意 —— 這正是本次「不得改變現有功能」紅線所在。

---

## 6. Phase 2 待辦（附「為何本批不做」）

| 項目 | 為什麼本批不做 |
|---|---|
| **沽清（`pos_soldout`）上雲** | 雲表有表但零寫入。一旦寫入，**多機與掃碼客端會開始看到彼此的沽清** ⇒ 這是新增功能行為，不是修 bug。且 `/api/pos/sync` 現時對沽清是 fail-open。需先確認商家期望 |
| **`printZones` 由 per-device 升為店級** | 現時屈在 `pos_device_configs.local_settings`（per-device）卻被當店級讀。改為店級會**改變「最後保存的機蓋全店」的既有行為**（現時正是這個行為在造成 KDS 分區錯亂）。需 migration＋三端協調 |
| **`sync-queue` outbox 加 IndexedDB 鏡像** | 純加法、風險低，但涉及持久化層改動，建議獨立一批＋獨立驗證（可複用 salon 的 `idbSet` 模式） |
| **打印去重加內容唯一鍵** | 需 DB 唯一索引 ＋ 三端同步改；並且「同一張單出兩張紙」的部分路徑（多終端各自去重）需要先確定期望語意 |
| **`PrintJob.ttl` 落地** | 會**改變行為**：現在打烊前卡住的單，隔早 APK 上線會照印；設 TTL 後就不會。這是業務決策，需商家拍板 TTL 長度 |
| **`/api/pos/print-agent/pair` POST 加閘** | 🔴 **本批刻意不動**。它**只由 APK 呼叫**（APK 用 phone + PIN 取得 merchantId 後自註冊；web 只查 `pair-status`）。加閘會影響另一個 repo 的 APK → 可能弄壞配對。建議設計：由已登入 web 簽發**一次性配對碼**，或讓 APK 改用 `/api/ledger/login` 取得的 POS 終端憑證 |
| **`/api/auth/login` 生產環境加 mock 帳號防護** | 🔴 **本批刻意不動**。`/api/admin/session` 有這個保護，`/api/auth/login` 沒有。加 503 是**正確的修法，但若生產環境的 Supabase 憑證未設齊，會直接鎖死登入**。⇒ 需先確認生產 env 齊備再上 |
| **`admin_account_users.pin_code` 改 hash + salt** | 需 migration ＋ 既有帳號遷移，非餐飲 UI 範圍但影響 POS 登入，獨立一批處理 |
| **`print-relay/server.mjs` 認證** | 需先確認該服務是否真的部署在公網（repo 內只是 skeleton） |
| **rate limit 改持久化** | 需引入外部 store（Upstash / DB table），屬基礎設施決策 |
| **RLS／migration 0021 加 `store_id` 過濾** | 需在 Supabase 執行；且要先確認生產有無跑過 0016／0021 |
| **`pos-app.tsx` 分拆（7,649 行 / 55 state）** | 高風險重構，需配合 UI 回歸測試（可複用 `pos-ui-live-verify` 流程） |
| **`print-center.tsx` 16 個既有 eslint error** | 既有技術債，與本批無關，建議獨立修 |
| **`GET /api/pos/orders` 與外部整合方協調憑證** | 需第三方配合，非本 repo 可單獨完成 |

---

## 7. Action Plan

**已完成（本批，可即時部署）**

- ✅ 打印／同步 fetch 加 20 秒硬逾時 → 修「一次網絡懸掛拖冧全店出紙」
- ✅ Realtime 4 支 hook 補 `CLOSED` 恢復 + 指數退避（3→30 秒封頂）+ 防重入 → 修「靜默永久收唔到單」
- ✅ 掛上 `AppErrorBoundary` 並中和過度激進的 `unhandledrejection` → 修白屏無自救入口
- ✅ backfill 閘門只擋 `pending`（3 處）→ 修「掉線後永久收唔到單」
- ✅ 購物車加減掣 28px → 40px
- ✅ 新增統一守衛 `src/lib/pos/pos-route-auth.ts`
- ✅ 9 條餐飲端點加鑑權閘（orders / shift / device-config / print-templates / note-presets / print-jobs-status / print-agent-unpair / pair-status / online-order-settings）
- ✅ 22 個客戶端呼叫點補 POS 終端憑證（全部用會自動續期的 `posDeviceAuthHeadersFresh()`）
- ✅ `verifyAgent` 改 `timingSafeEqual`
- ✅ `online-order-settings` 移除假店 fallback
- ✅ 驗證：`tsc` 0 error、761/761 測試通過、改動檔 `eslint` 0 error、`next build` 編譯成功

**部署前必做（3 項，缺一不可）**

- ⬜ 確認 Vercel 生產環境變數齊備：`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `POS_DEVICE_TOKEN_SECRET` / `ADMIN_SESSION_SECRET`（否則加閘後店員會 401）
- ⬜ 部署後**先用一部機實測 5 條高頻路徑**：登入 → 開工 → 落單出紙 → 交班歷史 → 設置頁儲存（這 5 條覆蓋全部加閘端點）
- ⬜ 記住緊急回滾掣：`POS_REQUIRE_DEVICE_AUTH=0`（改環境變數即可，**不需重新部署**）

**下一步（Phase 2，建議按此順序）**

- ⬜ 先做零風險、純加法的一批：`sync-queue` 加 IndexedDB 鏡像；`print-center.tsx` 16 個既有 eslint error
- ⬜ 再處理需 migration 的一批：`pin_code` 改 hash；`pos_print_jobs` / `pos_orders` 的 anon RLS 加 `store_id` 過濾；確認 0016 / 0021 是否已跑
- ⬜ 然後處理需業務拍板的一批：沽清上雲、`printZones` 升店級、`PrintJob.ttl` 長度
- ⬜ 最後處理需外部協調的一批：`/api/pos/print-agent/pair` 配對碼設計、`/api/pos/orders` GET 與整合方憑證、`print-relay` 認證、rate limit 持久化
- ⬜ 獨立一批：`pos-app.tsx` 分拆（配合 UI 回歸測試）

**每批的固定驗收口令**

- ⬜ `node node_modules/typescript/bin/tsc --noEmit` → 0 error
- ⬜ `node --test`（收集全部 `*.test.ts`）→ 761 pass / 0 fail
- ⬜ `node node_modules/eslint/bin/eslint.js <改動檔>` → 0 error
- ⬜ 若動到伺服器端鑑權，**必須**重跑呼叫點覆核腳本 → 「未帶憑證: 0」

---

## 8. 一句話總結

> 本批把**三條靜默永久失效路徑**、**一個會造成回歸的錯誤邊界設計**、**九條無鑑權端點**全部收口，
> 手法一律是「加守衛、加逾時、加狀態出口」而非改寫流程；伺服器端改動全部排在既有 early-return 之後，
> 令 mock／離線／未配置環境的回應完全不變；並以 22/22 呼叫點覆核、`tsc` 0 error、761 測試全綠作結。
> **穩定性、流暢度、安全性的餐飲範圍已達「良好」**；雲端一致性因為每項都會改變多機行為語意，刻意留待 Phase 2 並先與商家對齊期望。
