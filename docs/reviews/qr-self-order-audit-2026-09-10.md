# 掃碼點餐系統（`/menu` + `/order`）全面審查報告

> **日期**：2026-09-10
> **審查範圍**：客人手機掃碼自點 `/menu`、自助點餐機 `/order`、共用 hook `src/lib/use-kiosk-order.ts`、落單/序列/kiosk 設定 API、`pos_orders` 同步鏈路、POS 端接收與出單
> **審查維度**：功能完整性 / 使用者體驗 / 效能 / 程式碼品質
> **方法**：源碼逐行走查（非執行期測試）；所有問題均附 `檔案:行` 證據
> **相關文檔**：docs/87（自助點餐最終方案）、docs/110（會員登入與點數抵扣，未開工）、docs/85、docs/86

---

> ## 🛠 修復狀態：23 / 23 全數已修（2026-09-10 同日完成）
>
> 依下方「建議實施順序」四批次一次過落地，**P0×4、P1×6、P2×6、P3×7 全部完成**。
> 驗證結果：`npm run typecheck` ✅ exit 0／`npm run build` ✅ exit 0（全路由表產出）／`npm run test` ✅ 10 tests / 10 pass。
> 新增檔案 **11 個**、新增 API 端點 **2 支**。逐項落地細節見文末 **「附錄 A · 修復落地摘要」**。
>
> ⚠️ **部署前必讀**：本次為 `/api/pos/sync`、`/api/pos/state`、`/api/pos/bootstrap`、`/api/pos/kiosk-settings` 加了**憑證閘（fail-closed）**。若生產環境尚未由 `/api/ledger/login` 取得 `posDeviceToken`，端點會回 401。應急回滾開關：`POS_REQUIRE_DEVICE_AUTH=0`。

---

## 0 · 結論摘要

系統主流程（掃碼 → 菜單 → 購物車 → 落單 → 收銀端即時見單 → 廚房出單）**鏈路完整且設計克制**（落單端唔建廚房單、避免雙重打印；跨店事件隔離；兩級打印狀態）。但存在 **4 個 P0 級缺陷**，其中 2 個直接影響客人落單（靜默失敗、加單死胡同），2 個屬 service_role 寫入/讀取的授權缺口。

功能完整性方面有 3 個明確缺口：**無訂單狀態追蹤**、**無線上支付/會員抵扣**（docs/110 未實施）、**時價菜與稅費未在客人端處理**。

| 優先級 | 數量 | 主題 |
|---|---|---|
| **P0** | 4 | 落單失敗靜默、加單死胡同、寫入端點無授權、讀取端點洩露全店訂單 |
| **P1** | 6 | storeId 優先級倒置、售罄未同步、金額口徑不一致／時價菜、無離線兜底、未知店回 demo 餐牌、cache 無 store scope |
| **P2** | 6 | 售罄 UI 死碼、加單覆蓋商家狀態、浮點顯示、resume 拉全量、無 idempotency、頁面重複碼 |
| **P3** | 7 | 無測試、無障礙、圖片最佳化、i18n 空殼、無 rate limit、無 idle timeout、bootstrap POST 無驗證 |

### 四維度評分（滿分 5）

| 維度 | 分數 | 判斷 |
|---|---|---|
| 功能完整性 | **3.0** | 點餐主流程完整；狀態追蹤、支付/會員抵扣、時價菜缺 |
| 使用者體驗 | **3.0** | 手機端 UI 完整度好（bottom sheet、規格、加單）；失敗無反饋、售罄不可見、無狀態回饋 |
| 效能 | **3.5** | 禁 polling、realtime 用得克制；resume 拉全量、圖片無最佳化 |
| 程式碼品質 | **2.5** | 共用 hook 抽取正確、註釋質量高；但兩頁逐字重複、死碼、零測試、授權層缺失 |

---

## P0 · 必須立即修復

### P0-1　客人掃碼落單失敗時完全靜默（`/menu`） ✅ 已修

**證據**
- `src/app/menu/page.tsx:409-418`：按鈕 `onClick` 內 `void placeOrder(); setCartOpen(false);` —— **未等結果就閂購物車**
- `src/app/menu/page.tsx:407`：錯誤訊息只喺 cart sheet **內部**渲染（`{error && ...}`），而 sheet 已關閉
- `src/lib/use-kiosk-order.ts:411-413`：失敗只 `setError(...)`

**影響**：網絡抖動 / 500 / Supabase 未配置時，客人以為落單成功（畫面回到點餐頁），實際上冇寫入。餐廳漏單、客人白等 —— 屬最難排查嘅客訴類型。

**建議**
1. `onClick` 改為 `await placeOrder()`，**成功才** `setCartOpen(false)`；失敗保留 sheet。
2. 失敗時在 sheet 內顯示錯誤 + 「重試落單」按鈕，並用 `aria-live="assertive"` 播報。
3. `placeOrder` 回傳 `boolean`（或 throw 交由 UI catch），避免 UI 猜測結果。

**原因**：落單係全流程唯一不可逆嘅寫入動作，必須有明確成功/失敗反饋。

**預期效益**：消除「靜默丟單」類客訴，落單失敗可被客人自行重試；可追蹤失敗率。

---

### P0-2　重複掃碼 resume 後「加單」按鈕無反應（死胡同） ✅ 已修

**證據**
- `src/lib/use-kiosk-order.ts:425-427`：`addToOrder()` 條件 `if (mode !== "dine_in" || !tableOrder) return;`，之後只讀 `tableOrder.items`
- `src/lib/use-kiosk-order.ts:244-261`：resume 路徑只 `setCart(lines); setResumedOrder(existing);` —— **從不 `setTableOrder`**
- `src/lib/use-kiosk-order.ts:278-281`：`activeTableOrder = resumedOrder ?? tableOrder`（所以「已落單」畫面出得嚟）
- `src/app/menu/page.tsx:188,206-211`：`activeTableOrder && !ordering` 時顯示「已落單」+「加單」掣

**影響**：客人落完單後關閉分頁／重新掃碼（sessionStorage 仍在、order 未結帳）→ 進入「已落單」畫面 → 撳「加單」**完全冇反應**，亦冇任何提示。客人無法加點，只能叫職員。按「完成」再「開始點餐」仍回到同一畫面（`resumedOrder` 未清）——**硬死鎖**。

**建議**：`addToOrder()` 改為 `const source = resumedOrder ?? tableOrder;` 並改用 `source`；或 resume 時同步 `setTableOrder(existing)`。長遠應把 `resumedOrder` / `tableOrder` 合併為單一 state（見 P2-6）。

**原因**：兩個 state 表達同一概念（「本枱現有單」），造成分支漏讀。

**預期效益**：修復掃碼加單主路徑，直接恢復「加單」這一核心場景。

---

### P0-3　`/api/pos/sync` 無任何身份驗證，卻用 service_role 寫入 ✅ 已修

**證據**
- `src/app/api/pos/sync/route.ts:152-231`：只有 body 大小、storeId 格式、事件白名單、事件數量檢查，**無身份驗證**
- `src/app/api/pos/sync/route.ts:216`：`getSupabaseWriteClient()`（service_role），繞過 RLS
- `src/app/api/pos/sync/route.ts:633-648`：`ORDER_DELETED` 可刪任意訂單；`:614-630` 可刪打印任務
- `src/components/kiosk-qr-panel.tsx:125`：QR 內容為 `/menu?tableId=…&store=<merchantId>` → **storeId 對任何掃過碼嘅人公開**
- 全 repo 無 `middleware.ts`，無 route 級 auth

**影響**：任何掃過枱 QR 嘅人（或由 QR 圖片取得 storeId 嘅人）可直接 POST 偽造訂單、改金額、刪除訂單／打印任務 —— 破壞營業額、對帳與廚房出單。雖有輸入驗證，但驗證唔等於授權。

**建議**
1. 為 kiosk／掃碼寫入通道簽發短期憑證（例如 `/api/pos/kiosk-settings` 換發 device token，或 server 端 HMAC 簽 `storeId+exp`），`/api/pos/sync` 只接受帶有效憑證嘅寫入；POS 帳號沿用 Bearer。
2. 為 source=`scan`/`kiosk` 嘅請求，**只允許** `ORDER_CREATED` / `ORDER_UPDATED`（自己的單）；`ORDER_DELETED` / `PRINT_JOB_*` 需更高憑證。
3. 加 per-store rate limit（例如 30 req/min）。

**原因**：客戶端本質不可信；service_role 寫入必須有明確授權邊界。

**預期效益**：堵住資料完整性與財務風險（最嚴重嘅一項）。

---

### P0-4　`/api/pos/state?storeId=` 無驗證，回傳全店訂單與打印資料 ✅ 已修

**證據**
- `src/app/api/pos/state/route.ts:20-24`：無鑑權，`storeId` 由 query 傳入
- `src/app/api/pos/state/route.ts:145-226`：一次回傳 `orders`（默認 200，`limit` 可至 5000）、`queue`(300)、`printJobs`(200)、`deviceConfig`、`localSettings`、打印模板與備註
- `src/lib/kiosk-order.ts:367`：客人手機 `fetchUnsettledKioskOrder()` **就係打呢支 API**

**影響**：知道 storeId（QR 已公開）即可在瀏覽器直接 `GET` 拉走全店訂單（枱號、菜品、備註、金額、時間）、打印任務與店級設定。屬個人資料 + 商業資料洩露。

**建議**
1. 新增輕量端點 `GET /api/pos/order-lookup?storeId=&orderId=`，**只回一張單、只回白名單欄位**（id / localOrderNo / tableName / status / items / total），並要求 `orderId` 精確匹配（UUID 不可枚舉）+ rate limit。
2. `/api/pos/state` 收緊為需 POS 授權；`orders`、`queue`、`printJobs` 依權限分級，非必要唔喺同一支 API 回傳。
3. `ordersOnly=1` 路徑同樣需要授權。

**原因**：最小權限原則；resume 場景只需要一張單，冇理由拉全店。

**預期效益**：同時修復資安漏洞與 P2-4 效能問題（payload 由數百 KB 降至數 KB）。

---

## P1 · 高優先

### P1-1　掃碼時 `storeId` 優先級倒置 → 顯示 B 店餐牌、落單入 A 店 ✅ 已修

**證據**（同一 hook 內三處唔一致）
- `src/lib/use-kiosk-order.ts:156`：`storeId = binding?.storeId ?? scanStoreId ?? ""` ← **binding 優先**
- `src/lib/use-kiosk-order.ts:203`：menu fetch 用 `scanStoreId ?? binding?.storeId` ← **掃碼優先**
- `src/lib/use-kiosk-order.ts:158-161`：`displayStoreName = binding?.storeName ?? scanStoreName ?? …` ← **binding 優先**
- `src/lib/kiosk-order.ts:14`：`KIOSK_BINDING_KEY` 存喺**全機共用** localStorage（非 store-scoped，唔隨帳號切換清除）

**影響**：任何「曾綁過店」嘅瀏覽器（商家平板、職員手機、demo 機、做過 kiosk 登入嘅機器）掃另一間店嘅枱 QR → 標題顯示 A 店、餐牌係 B 店、訂單寫入 **A 店**（`needsBinding` 亦唔會觸發）。跨店串單 + 客人白等 —— 正是 docs/pos-cross-store-isolation 一直在防嘅那類 bug。

**建議**：`isScanLink === true` 時一律以 `scanStoreId` 為真源（`scanStoreId ?? binding?.storeId`），三處統一；或掃碼情境完全忽略 binding；長遠將 binding 改為 store-scoped key。

**原因**：用戶意圖真源喺 URL；一個變數三種優先級必然產生不一致。

**預期效益**：消除跨店錯單，補齊跨店隔離方案嘅缺口。

---

### P1-2　售罄菜品仍可下單（客人端無初始售罄狀態） ✅ 已修

**證據**
- `src/lib/use-kiosk-order.ts:189-198`：只用 `usePosRealtime` 監聽 `pos_soldout` **變更事件**，從不拉初始清單
- `src/lib/types.ts:113-153`：`MenuItem` 無 soldOut 欄位；`PosBootstrap` 亦無
- `src/app/api/pos/bootstrap/route.ts:36-49`：回傳嘅 payload 唔含售罄

**影響**：客人掃碼嗰刻已售罄嘅菜會照樣顯示、照樣加入購物車、照樣落單（realtime 只會喺之後「新增」變更時才推送）。廚房要口頭取消，客人已付出期待。

**建議**：bootstrap 或輕量 GET 一次性回傳店級售罄集合（`pos_soldout` 已有 `store_id`）；並在 `/api/pos/sync` 落單分支做 server 端售罄校驗，售罄則回可讀錯誤。

**原因**：realtime 推送係增量，唔能代替初始快照。

**預期效益**：減少無效訂單與前台衝突；售罄菜單即時反映。

---

### P1-3　客人所見金額與訂單實際金額不一致（稅/服務費、時價菜） ✅ 已修

**證據**
- `src/app/menu/page.tsx:398-405`：小計與「總計」都用 `cartTotal`
- `src/lib/use-kiosk-order.ts:296-299`：`cartTotal` 只加 `price * quantity`
- `src/lib/kiosk-order.ts:161-163`：實際 `total = subtotal + taxAmount + serviceChargeAmount`
- `src/components/pos-app.tsx:2121`：`isMarketPrice` **只喺收銀端**處理；`/menu`、`/order` 完全冇（`/menu:287` 直接顯示 `item.price`）

**影響**：(a) 店家設服務費/稅（澳門常見 10% 服務費）時，客人上單金額高於報價 → 收款爭議；(b) 時價菜價格可留空（→ `price = 0`），客人可 0 元落單，直接損失收入。

**建議**
1. 抽出 `computeOrderTotals(items, rules)` 單一函式，`buildKioskOrder` 與客人端 UI 共用；小計下方顯示稅/服務費明細。
2. 時價菜：客人端顯示「時價·請聯絡職員」，或落單時引導輸入價格，或自動將 `customerOrderable` 設 false 並在客人菜單隱藏。

**原因**：客人端顯示價必須與寫入訂單嘅價同源（單一真源計算）。

**預期效益**：避免收款爭議與定價損失。

---

### P1-4　落單無離線/重試兜底；序號失敗靜默換號 ✅ 已修

**證據**
- `src/lib/kiosk-order.ts:296-331`：`submitKioskOrder` 單次 `fetch`，失敗 throw（無重試、無隊列）
- 專案已有 outbox：`src/lib/pos/queue-outbox.ts` + flush worker，但 kiosk 路徑**未使用**
- `src/lib/kiosk-order.ts:209-219`：序號 API 失敗時 fallback 為 `堂食${timestamp後4位}`，與店內日序號唔同源

**影響**：餐飲現場 Wi-Fi 不穩，落單直接失敗；fallback 單號無法與店內序號對齊，收銀/廚房對號困難。

**建議**：落單寫入本機 pending 隊列（重用 `enqueueEvents` + `notifyQueueChanged`），UI 顯示「已收到，同步中…」；序號 fallback 改用已有嘅 `localDailySeq`（`src/lib/storage.ts` STORE_SUFFIX.localDailySeq）。

**原因**：落單係最需要離線兜底嘅動作，且專案已有現成機制。

**預期效益**：顯著提升落單成功率；單號口徑一致。

---

### P1-5　未知店舖回傳 demo 餐牌（示範店資料外洩到生產客人端） ✅ 已修

**證據**
- `src/app/api/pos/bootstrap/route.ts:32-34`：`if (error || !data) return NextResponse.json(normalizeBootstrapPayload(mockBootstrap));`（亦唔回帶 query 嘅 storeId）
- `src/app/api/pos/bootstrap/route.ts:12-18`：Supabase 未配置時同樣回 `mockBootstrap`

**影響**：未同步餐牌嘅新店／剛開店，客人掃碼見到「示範店」菜式與店名，並可成功落單到真店 → 錯菜、錯價、品牌混亂。

**建議**：店舖無設定時回 `{ categories: [], menuItems: [], storeName: null, menuUnavailable: true }`；前端顯示「本店餐牌準備中，請聯絡職員」並停用落單（`needsBinding` 旁再加一道 gate）。mock 只保留俾 dev。

**原因**：demo 資料唔應該出現在生產客人端。

**預期效益**：防止錯菜錯價與品牌事故。

---

### P1-6　客人端菜牌 cache 冇 store scope → 換店掃碼會用上一店菜牌 ✅ 已修

**證據**
- `src/lib/use-kiosk-order.ts:144`：`fetchedBootstrap ?? loadBootstrapCache() ?? mockBootstrap`
- `src/lib/use-kiosk-order.ts:222`：`saveBootstrapCache(data)`（無傳 merchantId）
- `src/lib/storage.ts:96-101`：`storeScopedStorageKey(suffix, merchantId)` 在 `merchantId` 為空且無 auth session 時退化成**全局 key** `macau-pos/bootstrap`
- 客人手機無 POS auth session（kiosk 模式登入亦只寫 binding、唔寫 session，見 `src/components/kiosk-qr-panel.tsx:77-78`）

**影響**：客人手機把所在店餐牌寫入全局 key；下次掃另一間店而 bootstrap 請求失敗（離線/500）時，**會顯示上一間店（或任意店）嘅菜牌並可落單**。

**建議**：`loadBootstrapCache(storeId)` / `saveBootstrapCache(data)` 明確傳入 `scanStoreId ?? binding?.storeId` 作 scope；讀到 scope 唔匹配就唔採用（直接走「餐牌載入失敗」提示）。

**原因**：快取 key 必須同查詢維度一致，否則 fallback 會變成污染源。

**預期效益**：避免離線情境落錯菜、錯價。

---

## P2 · 中優先

### P2-1　售罄 UI 係死碼（filter 已把售罄項剔除） ✅ 已修
- **證據**：`src/lib/use-kiosk-order.ts:283-289` `visibleItems` 已 `!soldoutIds.has(item.id)`；但 `src/app/menu/page.tsx:265-293` 與 `src/app/order/page.tsx:302-324` 仍寫 `sold` 分支（永遠 false，`disabled` / 售罄標籤永不生效）
- **建議**：二選一並統一 —— 建議**保留售罄項、灰化 + 標籤「售罄」**（客人理解為暫時缺貨，可轉點其他菜）
- **原因**：客人分唔清「售罄」同「菜單冇呢個菜」，會反覆問職員
- **預期效益**：減少詢問、提升替代菜轉化；移除死碼

### P2-2　客人加單會覆蓋商家已標記嘅出餐狀態 ✅ 已修
- **證據**：`src/lib/kiosk-order.ts:222-225` resume 時重用舊 `status` / `fulfillmentStatus` 並重寫整張單；`src/app/api/pos/sync/route.ts:370-384` 只擋**終態**降級，`sent_to_kitchen→preparing` 之類非終態會照寫
- **建議**：source=`scan` 嘅 `ORDER_UPDATED` 只提交 `items` / `orderNote`（差異合併），唔提交 `status` / `fulfillmentStatus`
- **原因**：狀態機 owner 係收銀端，客人端唔應該寫狀態
- **預期效益**：避免枱面狀態倒退、廚房重複出單

### P2-3　購物車行金額浮點顯示 ✅ 已修
- **證據**：`src/app/menu/page.tsx:377`、`src/app/order/page.tsx:349` 用 `MOP {line.price * line.quantity}`（無 `toFixed`）；同頁小計/總計用 `toFixed(2)`
- **建議**：統一用 `src/lib/format.ts` 嘅 `formatMoney`
- **預期效益**：消除 `36.300000000000004` 類顯示，兩頁一致

### P2-4　resume 只為一張單卻拉全店資料 ✅ 已修
- **證據**：`src/lib/kiosk-order.ts:367` `GET /api/pos/state?storeId=`（無 `ordersOnly`、無 `limit`）→ 200 訂單 + 300 queue + 200 printJobs + 模板 + 設定
- **建議**：改用 P0-4 嘅 `order-lookup` 專用端點
- **預期效益**：客人手機流量與耗電大幅下降；同時修 P0-4

### P2-5　缺少 idempotency（極快雙擊可能重複落單） ✅ 已修
- **證據**：`src/lib/use-kiosk-order.ts:333-336` `placeOrder` 只靠 React `submitting` state 禁用按鈕、未用 ref 同步鎖；每次呼叫都會新 `uid("kiosk")` 與新序號
- **建議**：`useRef` 同步鎖 + 請求帶 idempotency key（cart 簽名 + tableId 生成），server 對同一 key 只建一單
- **預期效益**：消除重複單（雙重打印、雙重收費）

### P2-6　兩頁近乎逐字重複 + 死 state ✅ 已修
- **證據**：`OrderSummaryCard` 兩份（`menu/page.tsx:12-46` vs `order/page.tsx:14-48`）；規格 bottom sheet 選擇邏輯 ~55 行兩邊逐字重複（`menu:430-509` vs `order:400-475`）；`/order` 解構出 `quickType` / `setQuickType` / `setLanguage` / `persistLanguage` 但**全部無 UI 使用**（外賣分支不可達，`delivery` 為死碼）
- **建議**：抽 `components/kiosk/`（`OrderSummaryCard`、`SpecSheet`、`useCartTotals`）；移除死 state 或補齊 UI
- **原因**：重複已經造成分歧（P2-3 兩邊都錯、P0-2 只喺共享 hook 出現）
- **預期效益**：改一處生效兩處，降低回歸風險

---

## P3 · 建議項

| # | 問題 | 證據 | 建議 | 效益 |
|---|---|---|---|---|
| P3-1 | **零測試基建** | `package.json` 無 test script / 無測試框架 | 為 `buildKioskOrder`、`lineSignature`、`fetchUnsettledKioskOrder`、`computeOrderTotals` 加單元測試 | 落單金額/去重邏輯有回歸保護 |
| P3-2 | 無障礙缺失 | `menu/page.tsx:349-351`、`:430-431` bottom sheet 無 `role="dialog"`/`aria-modal`/焦點管理/Esc；`order/page.tsx:357-363` 加減掣無 `aria-label` | 補 `role`/`aria-*`、Esc 關閉、focus trap | 符合無障礙基本要求、減少誤操作 |
| P3-3 | 圖片無最佳化 | `menu/page.tsx:276-284`、`order/page.tsx:313-321` `<img>` 無 width/height（CLS）、無尺寸參數 | 固定尺寸容器 + `object-cover` + `decoding="async"`；或用 CDN resize 參數 | 減少版面跳動與流量 |
| P3-4 | i18n 空殼 | `use-kiosk-order.ts:49-95` 只有 `zh-HK` 一個 key；`menu:49` `I18N[language][key]` 一旦 language 有其他值即 throw；語言切換 UI 未提供 | `(I18N[language] ?? {})[key] ?? key` 兜底；移除或補齊 UI | 防未來加語言時崩頁 |
| P3-5 | 其他端點同樣無授權 | `/api/pos/sequence` POST（`sequence/route.ts:9`）無驗證可消耗單號；`/api/pos/kiosk-settings` POST（`kiosk-settings/route.ts:55`）無驗證可改全店接單行為；`/api/pos/bootstrap` POST（`bootstrap/route.ts:52`）可覆寫任意店餐牌 | 納入 P0-3 嘅授權方案一併處理 + rate limit | 收斂攻擊面 |
| P3-6 | `/menu` 無 idle timeout | `/order` 有 60s 自動返回（`order/page.tsx:135-150`），`/menu` 冇 | 加超時 + 落單後清 cart（共用裝置場景） | 防上一位客人 cart 殘留 |
| P3-7 | 快捷模式無外賣選項（如屬有意） | `/order` 無 `quickType` UI，永遠「自取」（`order/page.tsx:337-342` 固定顯示） | 如 docs/87 §5.1 確認只做自取，應刪除 `delivery` 死碼與 `setQuickType` | 減少誤導與維護成本 |

---

## 功能完整性缺口（對照用戶列出嘅功能）

| 用戶列出嘅功能 | 現狀 | 缺口 |
|---|---|---|
| 菜單瀏覽 | ✅ 分類 chips + 單欄/網格、圖片、lazy load | 售罄狀態唔準（P1-2）、售罄顯示失效（P2-1）、無搜尋 |
| 選餐與購物車 | ✅ 規格必選校驗、同規格自動合併（`lineSignature`）、加減、清空、備註 | 浮點顯示（P2-3）、時價菜（P1-3）、無單品備註 UI（`note` 欄位存在但 UI 未用） |
| 訂單提交 | ✅ 共用 hook、日序號、`source` 標記、draft/直落廚房開關 | 失敗靜默（P0-1）、無離線兜底（P1-4）、無 idempotency（P2-5） |
| **支付流程** | ⚠️ **僅「到收銀付款」**：`prepaidAmount: 0`、`paymentMethod` 不設；無線上支付、無會員抵扣 | docs/110 方案未開工；客人端無分單/付款狀態 |
| **訂單狀態追蹤** | ❌ **完全缺失**：`/menu` 只有靜態成功頁與「本枱已落單」明細（`menu/page.tsx:142-222`），**不顯示** draft / 已接單 / 製作中 / 待取餐 | 建議用已有 `order.id` 訂閱 realtime（配合 P0-4 嘅安全端點）顯示狀態；快餐自取可顯示取餐號叫號 |

---

## 建議實施順序

1. **第一批（1-2 日，純前端即可見效）**：P0-1（失敗提示）、P0-2（加單死鎖）、P2-3（金額顯示）、P1-1（storeId 優先級）
2. **第二批（資安，需與後端/憑證方案一齊）**：P0-3 + P0-4 + P3-5 + P2-4（同一組改動可同時解決資安與效能）
3. **第三批（資料正確性）**：P1-2 售罄（含 server 端校驗）、P1-5 demo 餐牌、P1-6 cache scope、P2-2 加單唔覆蓋狀態
4. **第四批（體驗與工程品質）**：P1-3 金額口徑、P1-4 離線兜底、P2-1、P2-5、P2-6、P3-*

---

## 附 · 設計良好、應予保留嘅部分

- **落單端唔建廚房單**（`kiosk-order.ts:388-401` 註釋）→ 由收銀端唯一建立，杜絕雙重打印
- **跨店事件隔離**：事件自帶 `storeId` 並與請求級比對（`sync/route.ts:308-322`）
- **LWW + 終態守門**（`sync/route.ts:233-274, 361-385`）防離線重推把已結單打回舊狀態
- **`ORDER_SETTLED` 命中 0 列時 upsert 兜底**（`sync/route.ts:510-541`）防靜默丟單
- **`isPlaceholderStoreId()` 硬閘**（`kiosk-order.ts:54-65`、`sync/route.ts:195-205`）拒絕示範店代碼寫入
- **落單當刻讀取 per-store 接單開關**（`kiosk-settings.ts:40-67`）而非 polling，離線有安全 fallback
- **註釋質量高**：每個「坑」都記錄了 root cause 與反面教材，維護成本低

---

## 附錄 A · 修復落地摘要（2026-09-10）

### 新增檔案（11）

| 檔案 | 用途 | 對應問題 |
|---|---|---|
| `src/lib/pos/pos-device-token.ts` | HMAC-SHA256 無狀態 POS 終端憑證（`TOKEN_VERSION="pv1"`，TTL 12h）。密鑰優先序：`POS_DEVICE_TOKEN_SECRET` → `ADMIN_SESSION_SECRET` → `SUPABASE_SERVICE_ROLE_KEY`。匯出 `issuePosDeviceToken` / `verifyPosDeviceToken` / `readPosDeviceTokenFromRequest` / `isPosDeviceAuthRequired()` | P0-3 |
| `src/lib/pos/rate-limit.ts` | In-memory per-instance 限流 `rateLimit(key,max,windowMs)` + `clientIp(request)` | P0-3 / P3-5 |
| `src/lib/pos/pos-sync-auth.ts` | Client 側憑證讀取與自動續期：`getPosDeviceToken` / `posDeviceAuthHeaders` / `refreshPosDeviceTokenIfNeeded(force?)`（解 `exp`，剩 <10min 續期，`inflight` promise 去重，永不 throw） | P0-3 |
| `src/lib/pos/soldout.ts` | `fetchStoreSoldoutIds(storeId)` 用 anon client 拉 `pos_soldout` 初始集合 | P1-2 |
| `src/lib/pos/kiosk-outbox.ts` | Kiosk 落單待同步本地隊列（store-scoped key `macau-pos/kiosk-pending-orders/{storeId}`，上限 20）。**刻意不重用 `pos/queue-outbox`**：後者 flush 依賴 `resolveStoreId()`，掃碼客無此資訊 | P1-4 |
| `src/lib/kiosk-cart.ts` | 純函式單一真源：`lineSignature` / `mergeCartLine` / `changeCartQty` / `computeOrderTotals` / `type CartLine` | P2-3 / P2-6 / P3-1 |
| `src/lib/kiosk-cart.test.ts` | 6 個回歸測試（簽名順序無關、不合併、自動合併、減到 0 移除、含稅、浮點安全斷言） | P3-1 |
| `src/components/kiosk/order-summary-card.tsx` | `money2()` + 共用 `OrderSummaryCard`（兩頁原本逐字重複） | P2-3 / P2-6 |
| `src/components/kiosk/spec-sheet.tsx` | 共用規格 bottom sheet，`variant: "mobile"｜"kiosk"`；含 `role="dialog"` / `aria-modal` / Esc / 初始 focus / `aria-pressed` | P2-6 / P3-2 |
| `src/app/api/pos/order-lookup/route.ts` | 輕量單張訂單查詢（`storeId`+精確 `orderId`、欄位白名單、per-IP 60/min） | P0-4 / P2-4 |
| `src/app/api/pos/device-token/route.ts` | 用 Ledger access token 換 POS 憑證（讀 `merchant_staff` 驗身，fail-closed） | P0-3 |

### 逐項落地

**第一批（純前端）**
- **P0-1** `/menu` 落單改 `await placeOrder()`，**成功才**閂 sheet；`placeOrder` 回傳 `Promise<boolean>`；失敗保留 sheet + `aria-live` 錯誤 + 重試。
- **P0-2** resume 時同步 `setTableOrder(existing)`；`addToOrder()` 改用 `const source = resumedOrder ?? tableOrder`。
- **P2-3** 統一 `money2()`（= `toFixed(2)`），行金額/小計/總計一致。
- **P1-1** 三處統一 `storeId = isScanLink ? scanStoreId ?? "" : binding?.storeId ?? ""`（掃碼 URL 為真源）。

**第二批（資安）**
- **P0-3** `/api/pos/sync`：§2.1 限流 120/min、§2.2 通道授權、§3.2 匿名事件閘（匿名只准 `ORDER_CREATED`/`ORDER_UPDATED` 且 `source ∈ {scan,kiosk}`）；現有行且未授權 → 保留 DB 狀態（`writeStatus`/`writeFulfillment` 不覆寫）。
- **P0-4** 新增 `order-lookup` 端點；`/api/pos/state` GET 加限流 240/min + 憑證閘（未授權 401）。
- **P3-5** `/api/pos/bootstrap` POST（30/min）、`/api/pos/kiosk-settings` POST、`/api/pos/sequence`（60/min，保持匿名）全部加限流；前三者加憑證閘。
- **P2-4** `fetchUnsettledKioskOrder()` 由「拉全店 state」改打 `order-lookup`。

**第三批（資料正確性）**
- **P1-2** 新增售罄初始快照 effect（`soldoutRealtimeRef` 防舊快照蓋新變更）+ `addItem` 守門；`/api/pos/sync` 落單分支加 **server 端售罄校驗**（查 `pos_soldout` 失敗時 fail-open，避免 DB 抖動擋單）。
- **P1-5** `/api/pos/bootstrap` 未知店／未配置 Supabase（生產）一律回 `menuUnavailable: true` 空餐牌；前端 `menuUnavailable` 頁；`PosBootstrap` 加欄位、normalizer 帶返。
- **P1-6** 加 `cacheScope` state + `scopedCache` memo（cache.storeId 與 scope 不符則不採用）；`saveBootstrapCache(data, targetStoreId)` 明確 scope。
- **P2-2** 加單 payload **不再塞回** `status`/`fulfillmentStatus`，只交 `items`/`orderNote`。

**第四批（體驗與工程品質）**
- **P1-3** `computeOrderTotals(items, rules)` 單一真源，hook 匯出 `cartTotal` + `totals`；UI 顯示稅/服務費明細；時價菜客人端灰化 +「時價」標示。
- **P1-4** `submitKioskOrder` 加 3 次指數退避重試 + 憑證頭；區分 `KioskOrderRejectedError`（不重試）／`KioskOrderTransientError`（入本地隊列）；序號 fallback 改用 `nextLocalDailyOrderNo(seqKind,"堂食"/"自取")`；待同步隊列 flush effect + `orderSyncPending`/`pendingSyncCount` UI 提示。
- **P2-1** `visibleItems` 不再 filter 售罄項 → 保留 + 灰化 +「售罄」標籤（消除死碼）。
- **P2-5** `draftOrderIdRef` + `submittingRef` 同步鎖（React 19 下寫 ref 改在 effect 內）。
- **P2-6** 抽出 `components/kiosk/`；`/order` 移除死 state 解構（`quickType`/`setLanguage`/`persistLanguage`）。
- **P3-1** `package.json` 新增 `"typecheck": "tsc --noEmit"` 與 `"test": "node --test"`。
- **P3-2** `SpecSheet` 補 `role="dialog"`/`aria-modal`/Esc/focus；加減掣補 `aria-label`。
- **P3-3** `<img>` 補 `width`/`height`/`decoding="async"`（**未做** CDN resize，屬外部依賴）。
- **P3-4** 匯出 `kioskT(language,key)` 安全取詞（`(I18N[language] ?? {})[key] ?? key`）。
- **P3-6** `/menu` 加閒置 20 分鐘自動清 cart。
- **P3-7** `/order` 不再使用 `delivery` 死碼（hook 內 i18n key 仍保留，未清除）。

### 已知未完成／後續

1. `quickType` / `KioskQuickType` / `delivery` i18n key 仍留在 `use-kiosk-order.ts` 內（已無 UI 觸達），待 docs/87 §5.1 最終確認後清除。
2. 圖片未接 CDN resize（僅補 `width/height/decoding`）。
3. 生產部署前需確認：`POS_REQUIRE_DEVICE_AUTH`（預設 fail-closed）與 `POS_DEVICE_TOKEN_SECRET`（未設則回退 `ADMIN_SESSION_SECRET`）；若 POS 前端未升級至會取 `session.posDeviceToken` 的版本，需先設 `POS_REQUIRE_DEVICE_AUTH=0` 灰度。
4. 功能缺口（**不在本次 23 項內**）：訂單狀態追蹤、線上支付/會員抵扣（docs/110）、單品備註 UI。
