# 專案記憶索引（macauPos / macauPosSystem）

> ⚠️ 有注入上限（3k 字元，超咗**靜默截斷**）。本檔只放**最高頻紅線**；
> 詳細「坑」總表 → [`docs/113-agent-gotchas.md`](../docs/113-agent-gotchas.md)（改動前必讀）；
> 逐日記錄 → `.workbuddy/memory/YYYY-MM-DD.md`；完整舊版快照 → `archive/MEMORY-2026-09-12-full.md`。
> 維護：新坑先寫 docs/113，只有最高頻才摘要上嚟。

## 快餐（counter）單：兩維狀態（2026-09-12 修）
- 出餐階段**唯一真源** `isQuickOrderReady(o)`（＝`fulfillmentStatus === "ready"`，`@/lib/pos-order-filters`）；**唔可以**夾 `status === "paid"`。快餐單有「未收款先出餐」「先出餐後付款」兩條路徑停在 `sent_to_kitchen`，夾 paid 就撳完「可取餐」表面零變化（其實 ready 已寫入本機＋雲端）。
- 付款狀態 `getPaymentBadge()`（已結帳／未結帳）同出餐狀態**兩粒標籤並列**（卡片／訂單列表／彈窗一致）。
- 分組一律按 ready，只認 draft/sent_to_kitchen/paid；**終態**（取消／退款／返結）就算殘留 ready 都唔可以講成「待取餐」。
- 按鈕語義：可取餐 → 完成（`markOrderCompleted` → `settled`＝同時結帳、計入收入）。訂單頁列表＋查看彈窗共用 `QuickOrderActions`，唔可以各自寫；狀態唔准靜默無反應，要出 toast。
- 🔴 全部收喺 `isQuickCounterOrder`（`!onlineOrderId && tableId === "counter"`）分支內 → **堂食（真枱號）單完全唔受影響**。詳見 docs/113。

## 改動前必查（紅線）
- 🔴 建單／接單後必須 `appendPrintJobsWithSync()`；`RelayTransport.send()` 係 no-op → 淨 `savePrintJobs()` = 零出紙＋零紅標。
- 🔴 出紙修正「改咗代碼但行為唔變」＝出紙程式冇 re-build／冇擰 `versionCode`（4 份實作：print-relay APK／print hub／print-agent-android／desktop-companion）。
- 🔴 `git` 一律 `CODEBUDDY_SAFE_DELETE_ENABLED=0 git …`；`.git` 散咗**先 fetch、唔好 rebuild**（`git update-ref -d` 清走指向目標 commit 嘅 ref → `git fetch --negotiation-tip=<好 commit>`）。
- 🔴「reload 先見到」＝Realtime 訂錯 Supabase 專案（要 `NEXT_PUBLIC_POS_SUPABASE_URL/_ANON_KEY` ＋ redeploy）。
- 🔴 顧客端 Ledger：扣費／核銷只看「有無店員 Ledger session」；`pos_orders` 只可存 `customer_id`（禁電話／PIN）。
- `normalizePosLocalSettings` 係白名單重建 → 加欄要同步白名單，否則靜靜剷走。
- `ORDER_UPDATED` 送 `{ order, addedItems? }`；`/api/pos/sync`：業務拒絕 4xx `retryable:false`／基建 500 `retryable:true`。
- 報表 KPI 帶固定 `grid-cols-5`；合併 grid 必須刪中間 `</div>`（JSX 仍平衡 → build 捉唔到）。
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
- `npm run typecheck`／`npm run test`（`node --test` 無參數；測試 import 用相對路徑＋`.ts`，`@/` 會 ERR_MODULE_NOT_FOUND；utility 模組唔好用 `test-` 前綴）。
- `next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 且沙箱外跑。
