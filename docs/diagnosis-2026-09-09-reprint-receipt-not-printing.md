# 診斷：補打帳單（收據）印唔出 +「找不到原始訂單」（2026-09-09）

## 症狀
- 線上／線下訂單「補打帳單（收據）」：job 出現喺打印中心，但實體唔出紙。
- 喺打印中心對該 job 撳「重打整單」→「找不到原始訂單，無法重打。」

## 根因 1（印唔出）：補打 job 從來冇上雲
店內實際出紙通道係 **雲端 `pos_print_jobs` → print-relay APK（Realtime + claim RPC）出紙**。
雲端嗰行**只有** `PRINT_JOB_CREATED` 事件經 `/api/pos/sync` 先會寫（`src/app/api/pos/sync/route.ts:454`）。

- 正常結帳收據：pos-app `enqueuePrintJobs()`（pos-app.tsx:2615）＝ persistPrintJobs **＋ pushEvents(PRINT_JOB_CREATED)** ✅
- 補打收據：`printReceiptForPosOrder()` → `appendPrintJobs()`（print-jobs.ts）**淨寫本機 localStorage，冇 push 任何 sync 事件** ❌
- 更險：`RelayTransport.send()` 係 no-op（`relay-transport.ts:25`，只 flush sync queue、樂觀回 ok）→ 本地 flush 會將張 job 標做 `sent`（睇落「已發送」），但雲端根本冇呢張單 → APK 永遠收唔到 → 一張紙都唔出。呢個亦解釋點解 job 卡顯示係 `sent`（先會有「重打整單」掣可撳）。

### 修復
`src/lib/print-jobs.ts` 新增 `appendPrintJobsWithSync()`：append 本機之後，照 pos-app／shift-page／print-center 現行模式
`saveQueue(enqueueEvents(loadQueue(), withStoreScope(events)))` + `notifyQueueChanged()`（入隊即 flush）。
`printReceiptForPosOrder()` 改行呢個 → 一個點覆蓋晒：線下 `reprintReceiptForOrder`、線上 `reprintReceiptForLedgerOrder`、自動 `printReceiptForLedgerOrder`。

刻意**唔改**：`printKioskReceiptForOrder`（docs/87 §3.1 明言 Kiosk 小票唔好上雲，否則收銀台會多印一張）。

## 根因 2（找不到原始訂單）：orderMap 反查唔到線上單
`print-center.tsx` 嘅 `orders` 係 mount 時 `loadOrders()` 嘅一次性 snapshot，而：
- 線上單**從來唔 mirror 入 localStorage**（契約 M3/M8，只存 `ledger-pos-bridge.ts` 嘅 in-memory registry）→ `orderMap.get("ledger-…")` 永遠 undefined；
- 本頁 mount 之後先結帳／先由其他終端同步入嚟嘅線下單都唔會喺 snapshot 入面。

### 修復
`print-center.tsx` 新增 `findJobSourceOrder(job)` 三層 fallback：
1. `orderMap`（mount 快照）→ 2. 即時 `loadOrders()` → 3. `ledger-` 前綴走 `findPosOrderForLedger()`（in-memory bridge / legacy row）。
「重打整單」三個 `orderMap.get()` call site 全部改用；bridge 都搵唔到（例如 reload 後 registry 清空）時，線上單 toast 改為準確指引「請到訂單頁『查看』→『補打帳單（收據）』」。

## 已知同類缺口（未改，記錄待議）
- `printVoidForLedgerOrder`（線上單取消作廢單）同樣淨 `appendPrintJobs` —— 純雲端通道嘅店作廢單都會印唔出；今日啱啱上線嘅取消審核流程靠 native/LAN 通道出紙，改動前要先確認雙通道裝置會唔會雙印，建議獨立跟進。
- 線上單 bridge 產生嘅廚房 job 係 template-less/content-less（見今日 12:00 日誌已知事項），同本次無關。
