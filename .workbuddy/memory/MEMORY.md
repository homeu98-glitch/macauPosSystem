# 專案記憶索引（macauPos / macauPosSystem）

> ⚠️ 注入上限 3k 字元，超咗**靜默截斷**。只放最高頻紅線；坑總表 → [`docs/113-agent-gotchas.md`](../docs/113-agent-gotchas.md)（改動前必讀）。

## React 依賴紅線（2026-09-13 實案：整個 tab 卡死）
- 🔴 **子元件上報 → 父層 `setState` → 又傳返落子元件** 嘅 prop **一定要穩定 identity**（物件／陣列 `useMemo`、函式 `useCallback`）。否則 = 無限 re-render，**`useEffect` 內 setState 唔會 throw，只會靜靜燒 CPU 到整個 tab 撳唔到**（易誤報成「導航壞咗」）。
- 🔴 實例：`orders-hub.tsx` `dateSelection = {key,custom}` inline（已改 `useMemo`）；子元件（`local-orders-panel`／`online-orders`）已加**內容簽名**守衛（`length|id 序列`）做第二道防線。
- ⚠️ 呢類 bug **tsc／eslint／build／node --test 全綠**（冇 React component 測試環境）→ 只能 code review 或實機。

## 枱位真源（2026-09-13，同一坑中過兩次）
- 🔴 **任何「列枱／選枱」UI 一律用 `buildDisplayFloors(bootstrapTables, localSettings.floors)`**，**唔可以**只讀 `localSettings.floors`（本機可能淨係出廠預設 `1樓 A01-A03 / 2樓 B01-B02`）。
- 🔴 中過兩次：2026-09-12 `pos-app.tsx`、2026-09-13 `online-orders.tsx`（`/orders` 頁）。
- 🔴 加新列枱 UI 前**一定要 grep `localSettings.floors`** 確認冇漏。模組：`src/lib/pos/display-floors.ts`（含 `loadAssignableTables()`）。

## 快餐（counter）單：兩維狀態
- 出餐階段唯一真源 `isQuickOrderReady(o)`（＝`fulfillmentStatus==="ready"`），**唔可以**夾 `status==="paid"`（有路徑停在 `sent_to_kitchen`）。付款 `getPaymentBadge()` ＋出餐狀態**雙標籤並列**。
- 按鈕：可取餐 → 完成（`markOrderCompleted` → `settled`）；列表／彈窗共用 `QuickOrderActions`。狀態唔准靜默。
- 🔴 `ready`、`paid` 都係**單向閘**：結帳只寫 `paid`，唔可以被舊 snapshot 降級（client `mergeOrderLists` ＋ server `/api/pos/sync` 兩邊守；server 判 `writeStatus`）。
- 🔴 **LWW 只可用 `mergeTimestamp()`**（`clientUpdatedAt` 優先）；唔可以用 `orderTimestamp()`。
- 🔴 `resolveExistingOrderForUpsert()`：快餐 counter 已 `paid` 唔可以做 upsert 目標。
- 🔴 **「取消結帳」唔可以消失**：只喺 draft/sent_to_kitchen 出；齊結帳彈窗 header＋pos-app 詳情彈窗兩分支＋訂單頁列表／查看彈窗。
- 🔴 全部收喺 `isQuickCounterOrder`（`!onlineOrderId && tableId==="counter"`）→ 堂食完全唔受影響。詳見 docs/113。

## 線上堂食單「排位」（2026-09-13）
- 🔴 隔離閘只有一個：`isOnlineDineInOrder(o)`（帶 `onlineOrderId` ＋真枱 ≠ counter）。**結帳放寬同排位自動推 Ledger 共用同一份**。
- 🔴 可結帳＝`isSettleableOrder(o)`：`sent_to_kitchen`／`reopened`／（`onlineOrderId`＋真枱＋`paid`）。**四個入口全要改**（`currentSettlementOrder`／`openSettlementModal`／`confirmPayment`／`confirmComp`／`completeOnlinePaidOrder`），漏一個就卡死嗰條路。
- 🔴 排位＝一次過做齊：Ledger 爬梯到 `completed`（`syncOnlineDineInCompletion`，梯底 `accepted`）＋本地寫 `paid`＋桌台**綠卡**「已結帳 / 待收尾」。本地成功、Ledger 失敗**唔准靜默**。
- 🔴 返結守門：`mergeOrderLists()` **排喺「終態優先」之前**＋server `/api/pos/sync` `isReopenRegression`。分界用**返結審計欄 `reopenedAt`**（唔可以用時間／狀態：`settled` 一律拒會擋死合法重結）。一定要排除終態。
- 🔴 返結掣守門＝`isReopenable(o)`（本身已接受 `paid`），**唔可以**多夾 `status==="settled"`。
- `canCancelSettle()` **唔跟住放寬**（`paid` 已收錢 → 走返結／退款）。`paid` 唔係終態（要佔枱、可加菜）。
- ⚠️ 沖正 RPC `revert_transaction` 仍 Phase 2 未開放 → 返結彈窗照標「線上已付唔會沖正」。

## 打印區塊
- 🔴 加「靜態文字區塊」＝**零跨 repo 改動**（五個 renderer 全部係 `content[block.id] ?: continue` 查表式）。**只有**「逐項資料」（`PrintJob.items[]` 加欄）或改區塊語義才要四端同步 + 擰 `versionCode`。
- 加區塊必改：`SECTION_META` ＋ `BLOCK_DEFAULTS`（`Record<>` 逼 tsc）＋ `buildReceiptContent`。出票一律 `appendPrintJobsWithSync()`。

## 改動前必查（紅線）
- 🔴 建單／接單後必須 `appendPrintJobsWithSync()`；`RelayTransport.send()` 係 no-op → 淨 `savePrintJobs()` ＝零出紙＋零紅標。
- 🔴 出紙「改咗代碼但行為唔變」＝出紙程式冇 re-build／冇擰 `versionCode`（4 份：print-relay APK／print hub／print-agent-android／desktop-companion）。
- 🔴 `git` 一律 `CODEBUDDY_SAFE_DELETE_ENABLED=0 git …`；`.git` 散咗**先 fetch、唔好 rebuild**（見 git-repo-rescue skill）。
- 🔴「reload 先見到」＝Realtime 訂錯 Supabase 專案（要 `NEXT_PUBLIC_POS_SUPABASE_URL/_ANON_KEY` ＋ redeploy）。
- 🔴 顧客端 Ledger：扣費／核銷只看「有無店員 Ledger session」；`pos_orders` 只可存 `customer_id`（禁電話／PIN）。
- `ORDER_UPDATED` 送 `{ order, addedItems? }`；`/api/pos/sync`：業務拒絕 4xx `retryable:false`／基建 500 `retryable:true`。
- 報表 KPI 固定 `grid-cols-5`；合併 grid 必須刪中間 `</div>`（JSX 仍平衡 → build 捉唔到）。
- `nextLocalDailyOrderNo` 只可喺真正派新號時叫。

## 硬性口徑
- 收入認列 `isSaleCountable(o)`：只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`。
- 日期一律 Macau 邊界 ISO（`ledger/report-period.ts`）。
- 雲端讀到＝唯一可信源；雲端空＋成功＝空狀態，唔 fallback 本機。
- store 隔離 strict `o.storeId === merchantId`；缺失一律唔拉。
- admin 面板唔可以行 `/api/pos/state`（要終端憑證）→ `adminOrderFetcher()`。
- 取消線上單一律 RPC `merchant_resolve_order_change`。
- 快餐／Kiosk 打印機真源 `pos_kiosk_settings`；`resolveJobPrinter()` 必須合併 kiosk 機，否則靜靜印去收銀台。

## 登入 → 選工作台（2026-09-13）
- 流程：`/login`（只帳號+PIN）→ `/select-workbench`（只列已開通）→ 首頁。詳見 [`docs/127`](../docs/127-login-workbench-permission-plan.md)。
- 🔴 **`allowedModules` 缺失 = 全部開通**（唔係「全閂」）→ 口徑要四處一致：`merchant-modules-server.ts`／`AuthSession`／`login-screen`／`app-sidebar`。當成全閂 = 全線入唔到 POS。
- 🔴 加新模組**一律先改 `src/lib/pos/module-catalog.ts`**（唯一真源）；只改一邊唔會 throw，只會靜靜冇咗個開關。
- 🔴 商戶授權真源 `pos_merchant_modules`（migration 0037），per-store 一行；Admin PATCH 要**兩組一齊送**。
- 🔴 工作台副作用只有一份：`src/lib/pos/apply-workbench.ts`。掃碼模式由**所選工作台**決定（`retail` 唔寫 `saveOperatingMode`）；終端行業每次明確寫 salon/restaurant。

## 命令／環境
- ⚠️ `npm` 經 git-bash **跑唔到** → 直接 `node node_modules/typescript/bin/tsc --noEmit`、`node --test`、`node node_modules/eslint/bin/eslint.js`。git-bash **冇 coreutils**（ls/grep/sed/head/tail 全無）→ 用 `node -e`。
- ⚠️ 已有 **~34 個既有 lint error**（唔係回歸）。另有 **~8 個喺 `src/lib/pos/print-job-merge.test.ts`**（`no-explicit-any`，既有）。
- ⚠️ 本機**冇** `.env.local`、冇 supabase CLI → migration 要人手喺 Supabase SQL Editor 跑。
- ⚠️ 同一個 repo **可能有另一個 session 同時改嘢** → `tsc` 偶發語法錯誤（對方寫檔中途被讀到），**重跑再判斷**，唔好當成自己整壞。
- `node --test` 無參數；import 用相對路徑＋`.ts`（`@/` 會 ERR_MODULE_NOT_FOUND，**同層 runtime import 亦一樣**）；純模組必須零 runtime 依賴。`next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。

## 加設定欄鐵律（2026-09-12）
- `PosLocalSettings` 新欄一律**必填**（唔加 `?`）→ tsc 即刻指出要補 `normalizePosLocalSettings`（storage.ts）＋`defaultPosLocalSettings`（mock-data.ts）。漏白名單 = reload 靜靜剷走。
- 改既有型別一律**加選填欄**（另加 `retailPaymentMethods?` / `roles?`）→ 舊設定零遷移。
