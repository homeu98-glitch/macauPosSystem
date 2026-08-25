# 52 · 清除 / 刪除與同步的資料一致性方案

> 目的：診斷「打印中心清除已發送/失敗後記錄復活」與「點餐介面刪除訂單後經立即同步復活」兩個問題，
> 確認清除/刪除是否真刪 DB，並給出一致性的修復方案。
> 狀態：**已實作（2026-08-25）**。用家決定：打印清除 + 訂單刪除均做「真刪（local + DB）」，pruneSentPrintJobs 一併接 tombstone；訂單詳情 modal 加「刪除訂單」硬刪按鈕。tsc 零錯誤（layout.tsx LayoutProps 為 standalone tsc 已知誤報，Vercel build 唔受影響）。

---

## 一、直接回答你的兩個問題

### Q1：打印「清除已發送 / 清除已失敗」是否真刪 DB？
**否。只刪了本機 localStorage，沒有刪 Supabase `pos_print_jobs` 資料表。**

- `clearSentPrintJobs()` / `clearFailedPrintJobs()` 只呼叫 `savePrintJobs(kept)` → 寫入本機
  `macau-pos/stores/{merchantId}/print-jobs`（`src/lib/print-jobs.ts:249`、`:263`；`src/lib/storage.ts:404-409`）。
- 伺服器 `pos_orders` 同店的 `pos_print_jobs` 行完全冇被碰。
- 收銀側掛咗 `pos_print_jobs` 嘅 Realtime 訂閱（`src/lib/pos/use-pos-realtime.ts:77-84`），
  (re)subscribe 成功 3 秒後會觸發一次 backfill（`scheduleResubscribedSync`，`:95`），
  backfill 經 `/api/pos/state` 拉返**全店所有** `pos_print_jobs`（`src/app/api/pos/state/route.ts:28-30`，**冇 status 過濾**），
  再 `persistPrintJobs(payload.printJobs)` → `mergePrintJobs`（`src/lib/pos/print-job-merge.ts:16`，規則 3：server 有、本地無 → 補返）。
- 因為你清走嘅 sent/failed 行仲喺伺服器，backfill 就將佢哋補回 localStorage → 切頁 + 等幾秒後**復活**。
- 切頁時機吻合：切去其他頁再返轉 `pos-app` 重新 subscribe，`onResubscribed` 3 秒 debounce 觸發 backfill。

**結論：清除按鈕係「本機暫時隱藏」，未同步刪除後端；後端係「存在性真源」，會將記錄復活。**

### Q2：刪除訂單後點「立即同步」為何復原？
**因為刪除只係本機移除（或只軟取消），伺服器 `pos_orders` 仲有該行；「立即同步」間接觸發 backfill 將伺服器行重新合併回本地。**

- 「立即同步」= `syncNow(queue, …)`（`src/components/pos-app.tsx:1871`，按鈕喺 `:3083-3089`）。佢只將本機 queue POST 去 `/api/pos/sync`，成功後 `persistQueue(synced)` 將 queue 標為全 synced。
- `pos-app.tsx:556-562` 個 effect 依賴 `queue`：當 queue 全部 `synced`，守衛通過 → 呼叫 `loadRuntimeState()` 做 backfill。
- `loadRuntimeState` 經 `/api/pos/state` 拉返**全店所有** `pos_orders`（`route.ts:24-26`，**冇 status 過濾**），再
  `mergeOrderLists(loadOrders(), current, payload.orders)`（`:583-584`）將伺服器行合併返本地。
- 刪除/退桌 handler：`persistOrders(orders.filter(o => o.id !== order.id))`（`:1806`）只本機移除；
  退桌仲會推 `ORDER_UPDATED` + `status:"cancelled"` 事件（`:1771-1776`），`/api/pos/sync` 確實會將伺服器行 `upsert` 成 `cancelled`（`route.ts:44-72`）。
  **但** backfill 會將呢行 `cancelled` 單（route 冇過濾終態）經 `mergeOrderLists`（`src/lib/pos-order-filters.ts:29`，按 id 補回）重新加返本地 → `counterKioskOrders`（`pos-app.tsx:789-791`，`openOrders.filter(tableId==="counter" && !onlineOrderId)`）再次見到佢。
- 離線情境更慘：退桌事件 `status:"pending"` 未同步，伺服器行仲係 active，backfill 直接將**active** 單拉返。

**結論：刪除≠真刪。本機移除被「無條件 backfill 全店訂單」抵銷，伺服器行（active 或 cancelled）被重新合併。**

---

## 二、共同根因

兩個 bug 係**同一個架構問題**嘅兩種表現：

1. **雙真源 + 唔對稱**：本機 localStorage（狀態/即時真源）同伺服器資料表（存在性真源）並存；
   但**本地刪除/清除冇傳遞到伺服器**（冇 `DELETE` 事件，customer 側冇 tombstone）。
2. **backfill 無條件合併全表**：`/api/pos/state` 唔過濾 status，`mergePrintJobs` / `mergeOrderLists` 見 server 有、本地無就補回。
   設計契約係「server 係存在性真源」，但**冇考慮「本地用家已主動清除」呢個意圖**。
3. **「立即同步」副作用**：`syncNow` 成功 → queue 全 synced → 觸發 `loadRuntimeState` backfill → 復活本地已刪記錄。

>

現有契約（見 `print-job-merge.ts` 註解）係：
- server `pos_print_jobs` = 存在性真源
- 本機 localStorage = sent/failed 派發狀態真源
呢個契約本身冇錯，但**缺咗第三條：「本地清除/刪除意圖」必須壓過伺服器存在性**。

---

## 三、建議修復方案（分兩層，可分步做）

### 層 A — 本機 tombstone，立即止血（客戶端，防 backfill 復活）

不硬刪伺服器，只保證「你清走/刪走嘅，本機唔會被 backfill 復活」。適合打印記錄（本就係 per-terminal）。

1. **storage.ts** 加持久化集合：
   - `loadClearedPrintJobIds() / saveClearedPrintJobIds(ids)`（localStorage）
   - `loadDeletedOrderIds() / saveDeletedOrderIds(ids)`（localStorage）
2. **print-jobs.ts** `clearSentPrintJobs` / `clearFailedPrintJobs`：過濾時，將被刪 job id 寫入 `clearedPrintJobIds`。
3. **print-job-merge.ts** `mergePrintJobs(local, incoming, clearedIds?)`：incoming server job 若 `id ∈ clearedIds` → 跳過（唔補回）。
4. **pos-app.tsx** `persistPrintJobs(nextPrintJobs)`（backfill 用，`:1016-1023`）：傳入 `clearedPrintJobIds` 畀 `mergePrintJobs`。
5. **pos-app.tsx** `loadRuntimeState` orders merge（`:583-584`）：傳入 `deletedOrderIds`；
   並將 server 回傳嘅**終態單**（`cancelled` / `refunded` / `partially_refunded` / `settled`）排除出活躍工作列表
   （除非本機原本就有，留返本地對賬 tab 睇）。
6. **退桌/刪除 handler**（`:1806` 及類似本地移除路徑，如 `local-orders-panel.tsx` `handleDeleteAllOrders`）：
   本地移除同時把 id 寫入 `deletedOrderIds`。

### 層 B — 真同步到伺服器（跨終端一致，可選/建議）

要其他終端都唔見呢張單，就必須將「刪除意圖」寫入伺服器。

7. **/api/pos/sync/route.ts** 加分支：
   - `PRINT_JOB_DELETED` → `delete from pos_print_jobs where id = … and store_id = …`
   - `ORDER_DELETED` → `delete from pos_orders where id = … and store_id = …`（若決定「真刪」而非軟取消）
8. **事件推送**：
   - 打印清除 handler：`pushEvents([{ type:"PRINT_JOB_DELETED", entityId, status: networkOnline?"synced":"pending", … }])`
   - 訂單刪除：`pushEvents([{ type:"ORDER_DELETED", … }])`（替代或補充現有 `ORDER_UPDATED cancelled`）
9. **/api/pos/state/route.ts**（可選）：`pos_orders` / `pos_print_jobs` 查詢加 `status not in (終態)`，
   減少回傳雜訊、降低 backfill 復活風險（需權衡：對賬 report 係咪要靠伺服器終態單？建議對賬改讀本機 localStorage 或獨立 reporting 表）。

### 層 C — 切斷「立即同步」無意副作用（依賴 A/B 生效即安全）
- `syncNow` 成功後觸發 `loadRuntimeState` 本身冇問題，前提係 `loadRuntimeState` 嘅 merge 已尊重 tombstone（層 A.4/A.5）。
- 唔使改 effect 邏輯，只要 merge 唔復活本地已刪記錄即可。

---

## 四、防競態 / 防重複（沿用現有契約）
- 保留「本機 = sent/failed 狀態真源、server = 存在性真源」。
- 新增規則：「本地清除/刪除意圖（tombstone）優先於伺服器存在性」。
- `mergePrintJobs` rule 1（同 id 留本機）維持，避免 flush worker 當 sent 未印 → 重印。

---

## 五、待你決定嘅事項（實作前請回覆）

1. **打印清除範圍**：要「真刪伺服器行」（其他終端都唔見）定「只本終端 tombstone 隱藏」？
   打印歷史是否跨終端共享？呢點決定做唔做層 B 嘅 `PRINT_JOB_DELETED`。
2. **訂單刪除語義**：要「軟取消（留 cancelled 記錄對賬）」定「真刪除」？
   現有退桌已係軟取消，問題只係 backfill 拉返顯示 → 建議：backfill 唔拉終態 + `deletedOrderIds` 防復活（層 A 已解）；
   若要「誤單真消失」先加 `ORDER_DELETED`（層 B）。
3. **自動清理 `pruneSentPrintJobs`**（`print-jobs.ts:230`，每 tick 清 >7 日 sent）：
   係咪一併接 tombstone，避免自動清嘅又被 backfill 復活？（建議：係，順手修。）
4. **「刪除訂單」按鈕確認**：你講嘅「訂單列表刪除訂單」係咪即 `counterKioskOrders` 卡片入面（目前卡片只有 查看/標記可取/結帳，刪除可能在「查看」modal 內，或用緊退桌路徑）？
   請確認確切入口，我會確保該路徑接 `deletedOrderIds` + 推送刪除事件。

---

## 六、建議實作順序
1. storage.ts 加 `clearedPrintJobIds` / `deletedOrderIds` 持久化。
2. print-job-merge.ts：`mergePrintJobs` 收 `clearedIds`，跳過。
3. print-jobs.ts：clearSent/clearFailed 寫 `clearedPrintJobIds`。
4. pos-app.tsx：`persistPrintJobs` 傳 `clearedPrintJobIds`；`loadRuntimeState` orders merge 傳 `deletedOrderIds` + 排除終態。
5. 退桌/刪除 handler：寫 `deletedOrderIds`（＋推 `ORDER_DELETED` 事件，若決定層 B）。
6. /api/pos/sync：加 `PRINT_JOB_DELETED` / `ORDER_DELETED` 分支（層 B）。
7. /api/pos/state：orders/printJobs 過濾終態（可選，層 B.9）。
8. 回歸測試：
   - 清已發送 → 切頁等 3s → 唔復活；
   - 刪單 → 立即同步 → 唔復活；
   - 離線清/刪 → 重連補傳 → 唔復活；
   - 多終端：A 終端清/刪，B 終端 backfill 後行為符合決定（1）（2）。

---

## 七、受影響檔案清單
- `src/lib/print-jobs.ts`（clearSent/clearFailed、pruneSent）
- `src/lib/pos/print-job-merge.ts`（mergePrintJobs）
- `src/lib/pos-order-filters.ts`（mergeOrderLists 終態處理）
- `src/lib/storage.ts`（tombstone 持久化）
- `src/components/pos-app.tsx`（persistPrintJobs、loadRuntimeState、退桌/刪除 handler、syncNow effect）
- `src/components/local-orders-panel.tsx`（handleDeleteAllOrders 若需接 tombstone）
- `src/app/api/pos/state/route.ts`（終態過濾，可選）
- `src/app/api/pos/sync/route.ts`（PRINT_JOB_DELETED / ORDER_DELETED，層 B）
- `src/lib/pos/use-pos-realtime.ts`（確認 backfill 觸發點，唔使改邏輯，只驗證）

---

## 八、實作紀錄（2026-08-25）

用家確認四項決定後，已按「真刪（local + DB）」全量實作。tsc 零錯誤（layout.tsx LayoutProps 為 standalone tsc 已知誤報，Vercel build 唔受影響）。

### 用家決定（覆核後）

1. 打印清除範圍 → **真刪全部**（local + DB `pos_print_jobs`）
2. 訂單刪除語義 → **真刪除**（測試用途，要徹底消失）
3. `pruneSentPrintJobs` 自動清理 → **接 tombstone + 推伺服器 DELETE**
4. 「刪除訂單」按鈕入口 → 係**訂單詳情 modal 內**個隻（快捷操作嘅訂單只係同批單喺 UI 放出嚟），所以 modal 內按刪除 = 全站清走該單

### 實際改動

**storage.ts**
- `STORE_SUFFIX` 加 `clearedPrintJobIds: "cleared-print-jobs"`、`deletedOrderIds: "deleted-orders"`
- 匯出 `loadClearedPrintJobIds / saveClearedPrintJobIds / addClearedPrintJobIds / loadDeletedOrderIds / saveDeletedOrderIds / addDeletedOrderIds`；每個 `add` 用 `Array.from(new Set([...load, ...ids]))` 去重

**types.ts**
- `QueueEventType` 聯合加 `"ORDER_DELETED"`、`"PRINT_JOB_DELETED"`

**pos/print-job-merge.ts**
- `mergePrintJobs(local, incoming, clearedIds?)`：incoming 單 `id ∈ cleared` → `continue` 跳過（唔補回）；`clearedIds` 支援 `string[] | Set`

**print-jobs.ts**
- `deletePrintJobsOnServer(ids)`：建 `PRINT_JOB_DELETED` 事件 POST `/api/pos/sync`，storeId 取自 `loadAuthSession()?.merchantId ?? loadBootstrapCache()?.storeId`，失敗靜默
- `pruneSentPrintJobs` / `clearSentPrintJobs` / `clearFailedPrintJobs`：算 removed ids → `savePrintJobs(kept)` → `addClearedPrintJobIds(removedIds)` → `void deletePrintJobsOnServer(removedIds)` + dispatch `pos-print-jobs-changed`

**api/pos/sync/route.ts**
- 事件迴圈加兩分支：
  - `PRINT_JOB_DELETED` → `delete from pos_print_jobs where id = payload.id and store_id = storeId`
  - `ORDER_DELETED` → `delete from pos_orders where id = payload.orderId and store_id = storeId`（store_id 隔離，防跨店刪）

**pos-order-filters.ts**
- `isTerminalOrderStatus(status)` → cancelled/refunded/partially_refunded/settled 為 true
- `filterResurrectedOrders(orders, deletedOrderIds, localOrders)`：濾走 tombstone id 同伺服器獨有終態單（除非本機原本就有）

**pos-app.tsx**
- import `loadClearedPrintJobIds / loadDeletedOrderIds / addDeletedOrderIds` + `isTerminalOrderStatus, filterResurrectedOrders`
- `persistPrintJobs`：`mergePrintJobs(loadPrintJobs(), nextPrintJobs, loadClearedPrintJobIds())`
- `onPrintJobUpsert`：`loadClearedPrintJobIds().includes(job.id)` → 直接 return
- `loadRuntimeState` orders merge：包 `filterResurrectedOrders(merged, loadDeletedOrderIds(), loadOrders())`
- `onOrderUpsert`：`loadDeletedOrderIds().includes(order.id)` → return；merge 包 `filterResurrectedOrders`
- `deleteOrderPermanently(orderId)`：加 tombstone → `persistOrders` 移除 → `pushEvents([ORDER_DELETED])` → 在線 `syncNow([...queue, deleteEvent], {silent:true})`；清 active order 狀態、關 modal、toast
- 訂單詳情 modal actions 加紅色「刪除訂單」按鈕，`window.confirm` 防誤觸 → `deleteOrderPermanently(viewingOrder.id)`

### 未做（可選，非必要）

- `local-orders-panel.tsx` 嘅 `handleDeleteAllOrders` 未接 `deletedOrderIds`（用家確認入口係 modal 內按鈕，該路徑已做）。如日後要「全部刪除」也防復活，可補接。
- `/api/pos/state/route.ts` 伺服器端終態過濾（客戶端 `filterResurrectedOrders` 已處理，唔使改 server）。

### 手動回歸步驟

1. 打印中心 → 清除已發送/失敗 → 切頁等 3s → 唔復活（tombstone 擋住 backfill）
2. 訂單詳情 modal → 刪除訂單 → 立即同步 → 唔復活（tombstone + 伺服器 DELETE）
3. 離線清/刪 → 重連 → syncNow 補傳 → 伺服器行清走、本地唔復活
4. 多終端：A 清/刪，B backfill 後該單唔見（真刪伺服器行生效）
