# 專案記憶索引（macauPos / macauPosSystem）

> ⚠️ 注入上限 3k 字元，超咗**靜默截斷**。本檔只放最高頻紅線；詳細「坑」總表 → [`docs/113-agent-gotchas.md`](../docs/113-agent-gotchas.md)（改動前必讀）；逐日記錄 → `.workbuddy/memory/YYYY-MM-DD.md`。新坑先寫 docs/113，只有最高頻才摘要上嚟。

## 快餐（counter）單：兩維狀態（2026-09-12 修）
- 出餐階段**唯一真源** `isQuickOrderReady(o)`（＝`fulfillmentStatus === "ready"`）；**唔可以**夾 `status === "paid"`。快餐單有「未收款先出餐」「先出餐後付款」兩條路徑停在 `sent_to_kitchen` → 夾 paid 就「撳完可取餐零變化」（ready 其實已寫入）。
- 付款 `getPaymentBadge()`（已結帳／未結帳）＋出餐狀態**雙標籤並列**（卡片／列表／彈窗一致）。分組只認 draft/sent_to_kitchen/paid 且按 ready；**終態**殘留 ready 唔可以講成「待取餐」。
- 按鈕：可取餐 → 完成（`markOrderCompleted` → `settled`＝結帳＋計收入）。訂單頁列表／查看彈窗共用 `QuickOrderActions`。狀態唔准靜默無反應，要 toast。
- 🔴 **`ready`、`paid` 都係單向閘**：快餐結帳只寫 `paid`（唔係 `settled`），**唔可以**被 draft/sent_to_kitchen 舊 snapshot 降級（client `mergeOrderLists` ＋ server `/api/pos/sync` 兩邊守；server 要判 `writeStatus` 而唔係 raw `incomingStatus`，否則 kiosk 加菜整條被拒）。
- 🔴 **LWW 只可用 `mergeTimestamp()`**（`clientUpdatedAt` 優先＝同 server `client_updated_at` 同鐘域）；**唔可以用 `orderTimestamp()`**（雲端 `updatedAt` 係 server 蓋章）→ 否則「已結帳」閃回「未結帳」。
- 🔴 `resolveExistingOrderForUpsert()`：快餐 counter 已 `paid` 唔可以做 upsert 目標（要 `return null` 開新單），否則撳「下單」打返未結帳。
- 🔴 **「取消結帳」唔可以喺重構中消失**（未收款逃生口）：只喺 draft/sent_to_kitchen 出；最少齊結帳彈窗 header＋pos-app 訂單詳情彈窗（`isQuick` 同 self-`showSplit` 兩分支）＋訂單頁列表／查看彈窗（用 `cancelLocalOrder()`）。
- 🔴 全部收喺 `isQuickCounterOrder`（`!onlineOrderId && tableId === "counter"`）→ **堂食單完全唔受影響**（`paid` 亦只有快餐會寫）。詳見 docs/113；測試 `src/lib/pos-order-filters.test.ts`。

## 改動前必查（紅線）
- 🔴 建單／接單後必須 `appendPrintJobsWithSync()`；`RelayTransport.send()` 係 no-op → 淨 `savePrintJobs()` ＝零出紙＋零紅標。
- 🔴 出紙「改咗代碼但行為唔變」＝出紙程式冇 re-build／冇擰 `versionCode`（4 份：print-relay APK／print hub／print-agent-android／desktop-companion）。
- 🔴 `git` 一律 `CODEBUDDY_SAFE_DELETE_ENABLED=0 git …`；`.git` 散咗**先 fetch、唔好 rebuild**（`git update-ref -d` 清走指向目標 commit 嘅 ref → `git fetch --negotiation-tip=<好 commit>`）。
- 🔴「reload 先見到」＝Realtime 訂錯 Supabase 專案（要 `NEXT_PUBLIC_POS_SUPABASE_URL/_ANON_KEY` ＋ redeploy）。
- 🔴 顧客端 Ledger：扣費／核銷只看「有無店員 Ledger session」；`pos_orders` 只可存 `customer_id`（禁電話／PIN）。
- `normalizePosLocalSettings` 係白名單重建 → 加欄要同步白名單，否則靜靜剷走。
- `ORDER_UPDATED` 送 `{ order, addedItems? }`；`/api/pos/sync`：業務拒絕 4xx `retryable:false`／基建 500 `retryable:true`。
- 報表 KPI 固定 `grid-cols-5`；合併 grid 必須刪中間 `</div>`（JSX 仍平衡 → build 捉唔到）。
- `nextLocalDailyOrderNo` 只可喺真正派新號時叫。

## 硬性口徑
- 收入認列 `isSaleCountable(o)`：只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`。
- 日期一律 Macau 邊界 ISO（`ledger/report-period.ts`）。
- 雲端讀到＝唯一可信源；雲端空＋成功＝空狀態，唔 fallback 本機。
- store 隔離 strict `o.storeId === merchantId`；缺失一律唔拉。
- admin 面板唔可以行 `/api/pos/state`（要終端憑證）→ `adminOrderFetcher({ storeId })`。
- 取消線上單一律 RPC `merchant_resolve_order_change`。
- 快餐／Kiosk 打印機真源 `pos_kiosk_settings`；`resolveJobPrinter()` 必須合併 kiosk 機，否則靜靜印去收銀台。

## 命令
- `npm run typecheck`／`npm run test`（`node --test` 無參數；測試 import 用相對路徑＋`.ts`，`@/` 會 ERR_MODULE_NOT_FOUND；utility 模組唔好用 `test-` 前綴）。要測嘅純模組必須零 runtime 依賴。
- `next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 且沙箱外跑。
