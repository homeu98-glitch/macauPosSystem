# 專案記憶索引（macauPos / macauPosSystem）

> ⚠️ 注入上限 3k 字元，超咗**靜默截斷**。只放最高頻紅線；坑總表 → [`docs/113-agent-gotchas.md`](../docs/113-agent-gotchas.md)（改動前必讀）。

## 快餐（counter）單：兩維狀態
- 出餐階段唯一真源 `isQuickOrderReady(o)`（＝`fulfillmentStatus==="ready"`），**唔可以**夾 `status==="paid"`（有兩條路徑停在 `sent_to_kitchen`）。付款 `getPaymentBadge()` ＋出餐狀態**雙標籤並列**；只認 draft/sent_to_kitchen/paid 且按 ready。
- 按鈕：可取餐 → 完成（`markOrderCompleted` → `settled`）；列表／彈窗共用 `QuickOrderActions`。狀態唔准靜默。
- 🔴 `ready`、`paid` 都係**單向閘**：結帳只寫 `paid`（唔係 `settled`），唔可以被舊 snapshot 降級（client `mergeOrderLists` ＋ server `/api/pos/sync` 兩邊守；server 判 `writeStatus` 唔係 raw `incomingStatus`）。
- 🔴 **LWW 只可用 `mergeTimestamp()`**（`clientUpdatedAt` 優先）；唔可以用 `orderTimestamp()` → 否則「已結帳」閃回「未結帳」。
- 🔴 `resolveExistingOrderForUpsert()`：快餐 counter 已 `paid` 唔可以做 upsert 目標（要 `return null`）。
- 🔴 **「取消結帳」唔可以消失**：只喺 draft/sent_to_kitchen 出；齊結帳彈窗 header＋pos-app 詳情彈窗兩分支＋訂單頁列表／查看彈窗（`cancelLocalOrder()`）。
- 🔴 全部收喺 `isQuickCounterOrder`（`!onlineOrderId && tableId==="counter"`）→ 堂食完全唔受影響。詳見 docs/113；測試 `src/lib/pos-order-filters.test.ts`。

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

## 命令／環境
- ⚠️ `npm` 經 git-bash **跑唔到** → 直接 `node node_modules/typescript/bin/tsc --noEmit`、`node --test`、`node node_modules/eslint/bin/eslint.js`。git-bash **冇 coreutils**（ls/grep/sed/head/tail 全無）→ 用 `node -e`。
- ⚠️ 已有 **~34 個既有 lint error**（唔係回歸，睇 daily log）。
- `node --test` 無參數；import 用相對路徑＋`.ts`（`@/` 會 ERR_MODULE_NOT_FOUND，**同層模組之間嘅 runtime import 亦一樣**）；utility 模組唔好用 `test-` 前綴；純模組必須零 runtime 依賴。
- `next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 且沙箱外跑。

## 加設定欄鐵律（2026-09-12 實證）
- `PosLocalSettings` 新欄一律宣告**必填**（唔加 `?`）→ tsc 即刻指出要補 `normalizePosLocalSettings`（storage.ts）＋`defaultPosLocalSettings`（mock-data.ts）。漏白名單 = reload 靜靜剷走。
- 改既有型別一律**加選填欄**（`paymentMethods` 保持 `string[]` 另加 `retailPaymentMethods?`；`role` 保持單值另加 `roles?`）→ 舊設定零遷移。
