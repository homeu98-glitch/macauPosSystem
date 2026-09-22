# 打印排查報告：部分單據印唔出 ＋ 出紙非常慢

日期：2026-09-22
觸發：商家截圖（打印中心 → 打印記錄）＋ 文字投訴「部分狀態似乎無法正常打印出來」、「打印非常的慢，非常的不即時」

---

## 0. 結論先講（兩個**互相獨立**嘅問題，唔可以當同一個查）

| # | 問題 | 根因 | 引入時間 | 性質 |
|---|---|---|---|---|
| A | 部分單據**永遠印唔出**（打印中心綠色「已發送」、無紅標、無失敗原因） | 2026-09-11 重構把 `appendPrintJobs()` 嘅**語義靜默改為「只寫本機」**，但有 5 個呼叫端冇跟住搬去 `appendPrintJobsWithSync()` | 2026-09-11（commit `1e08343`） | **迴歸（regression）**，已持續 ~11 日 |
| B | 出紙**非常慢／唔即時** | 2026-09-21／22 嘅 egress 優化把「APK 認領雲端任務」由 ~30–60 秒放到 **180 秒**；同時網頁側結果回填由 8 秒放到 30 秒 | 2026-09-21 23:54（server）／2026-09-22 早上 09:00–09:30（APK 生效） | **刻意取捨嘅副作用**（為省 Supabase egress 而放慢） |

⚠️ 兩者症狀**會撞樣**（都係「卡在已發送」），但判別方法唔同，見第 4 節。

---

## 1. 問題 A：部分單據永遠印唔出

### 1.1 症狀

- 打印中心見到 **綠色「已發送」**，而且**永遠唔會變**「打印成功」；
- **冇紅色「列印失敗」**、**失敗原因欄係「—」**；
- 底部「未上雲」警示**都唔會出**（見 1.4）。

### 1.2 機制（一句話）

店內實體出紙通道係「雲端 `pos_print_jobs` → 中繼 APK claim 出紙」。
雲端嗰行**只有** `PRINT_JOB_CREATED` 事件經 `/api/pos/sync` 先會寫。
`RelayTransport.send()` 本身係 **no-op**（只 flush sync queue，見 `src/lib/print-bridge/relay-transport.ts:25-34`）。

所以：**只寫本機 = 本地被樂觀標成 `sent`（顯示「已發送」），但雲端根本冇呢張單 ⇒ APK 永遠 claim 唔到 ⇒ 一張紙都唔出。**

### 1.3 根因（已用 git 歷史實錘）

commit `1e08343`（2026-09-11 15:07，「update」，把 enqueue 邏輯抽去新模組）對 `src/lib/print-jobs.ts` 做咗一個**同名函數嘅語義反轉**：

```diff
-export function appendPrintJobs(jobs: PrintJob[]) {
-  ... savePrintJobs(merged);            // 舊版：落本機
-}
-
-/** 同 appendPrintJobs，但同步會將 PRINT_JOB_CREATED 推入 sync queue（上雲） */
-function appendPrintJobsWithSync(jobs: PrintJob[]) {
-  appendPrintJobs(jobs); ... saveQueue(...); notifyQueueChanged();
-}
+export function appendPrintJobs(jobs: PrintJob[]) {
+  persistMergedPrintJobs(jobs);          // 新版：**只寫本機，唔上雲**
+}
```

- **舊 `appendPrintJobs` = 落本機 ＋ 推上雲**（舊註釋明寫「淨行 appendPrintJobs 嘅建單路徑……一張紙都唔會出（2026-09-09 補打帳單印唔出嘅根因）」）；
- **新 `appendPrintJobs` = 只寫本機**，同步版本改名做 `appendPrintJobsWithSync`（搬去 `src/lib/pos/print-job-enqueue.ts`）。

該 commit 有跟住改部分呼叫端（例如 `printVoidForLedgerOrder` 由 `appendPrintJobs` 改成 `appendPrintJobsWithSync`），
但**其餘 5 個呼叫端沿用了同名嘅 `appendPrintJobs`**，於是**靜默地由「印得出」變成「永遠印唔出」**，
而 TypeScript / lint / 測試**完全唔會報錯**（同名、同簽名、同回傳）。

已驗證呢 5 個呼叫端**早於** `1e08343` 就存在（即係受影響，唔係新加）：
`git show 1e08343^:src/lib/pos-orders.ts` 見到第 209、275 行已經係 `appendPrintJobs(...)`。

### 1.4 受影響位置（逐個核對過）

| # | 檔案:行 | 觸發情境 | 受影響單據 | 判斷 |
|---|---|---|---|---|
| 1 | `src/lib/pos-orders.ts:248` | `reopenPosOrder()` — **返結（反結賬）** | 返結單 | ❌ 應修 |
| 2 | `src/lib/pos-orders.ts:314` | `confirmSelfOrder()` — **收銀台「確認自助單」**（kiosk／掃碼） | 廚房單 ＋ 標籤單 ＋ 掃碼單顧客小票 | ❌ 應修（最高頻） |
| 3 | `src/components/pos-app.tsx:1905` | realtime 收到**新自助單**（`isNewSelfOrder && status==="sent_to_kitchen"`） | 同上 | ❌ 應修 |
| 4 | `src/components/pos-app.tsx:1949` | realtime 收到**自助單加菜**（`ticketType:"addon"`） | 加單廚房單 ＋ 標籤單 | ❌ 應修 |
| 5 | `src/components/pos-app.tsx:1488` | `loadRuntimeState()` backfill **補建自助單廚房單**（收銀端恢復在線／重新載入） | 廚房單 ＋ 標籤單 | ❌ 應修 |
| 6 | `src/lib/print-jobs.ts:686` | `printKioskReceiptForOrder()` | Kiosk **本機**顧客小票 | ✅ **刻意**（docs/87 §3.1：唔好上雲，否則收銀端 merge 落本機再印多一次） |

即係：**自助點餐（掃碼／自助機）單嘅落單／加單／確認／backfill，以及返結單，全部印唔出。**

### 1.5 為何零症狀（最惡嘅一點）

打印中心本來設計咗「未上雲」徽章（`src/components/print-center.tsx:482-488`）：

```ts
// 只要該 job 嘅 PRINT_JOB_CREATED 仲未 synced，就喺狀態欄大聲標「未上雲」
for (const event of loadQueue()) {
  if (event.type === "PRINT_JOB_CREATED" && event.status !== "synced") ids.add(event.entityId);
}
```

但呢個徽章靠「queue 入面有條未 synced 嘅事件」——
而 `appendPrintJobs()` 路徑**連事件都冇入過 queue** ⇒ 冇徽章。
同時 `syncCloudPrintOutcomes()`（`print-center.tsx:1065`）只按 `job.id` 同雲端行配對，
雲端冇呢行 ⇒ 狀態永遠唔會被向上覆寫 ⇒ **一直停留「已發送」**。

⇒ 商家見到嘅係一個**乾淨嘅綠色「已發送」**，完全冇線索（同 `docs/113-agent-gotchas.md:465` 描述一致）。

---

## 2. 問題 B：出紙非常慢／唔即時

### 2.1 端到端延遲鏈（一次按鈕 → 一張紙）

| 步驟 | 驅動 | 現時延遲 | 近期有冇變 |
|---|---|---|---|
| ① 落本機 ＋ 入 outbox | 同步 | ~0 | 冇 |
| ② flush 上雲（`/api/pos/sync`） | `notifyQueueChanged()` 即時觸發 ＋ 30s 兜底 | ~0.5–2 秒 | 冇 |
| ③ 雲端寫 `pos_print_jobs` → 通知中繼 APK | Realtime INSERT（叫醒）**或** 週期 claim | **叫醒：~1–3 秒／冇叫醒：0–180 秒（平均 90 秒）** | 🔴 **60 → 180 秒** |
| ④ APK claim 批次上限 | `p_limit` | **一次最多 5 張** | 冇 |
| ⑤ 網頁見到「打印成功」 | `print-center` 輪詢 | **最多 +30 秒** | 🔴 **8 → 30 秒** |

### 2.2 具體改動（2026-09-21／22）

| 改動 | 檔案 | 舊值 | 新值 | 影響 |
|---|---|---|---|---|
| 建議 APK 認領間隔 | `src/app/api/pos/print-agent/claim/route.ts:20`（`SUGGESTED_CLAIM_MS`，commit `f25af2f` 2026-09-21 23:54） | ~30–60 秒 | **180 000 ms** | 最壞情況一張單等 **3 分鐘** |
| APK 刪獨立心跳 | `heartbeat/route.ts`（`c5db7a0`） | 心跳 30 秒 | 由 `claim` 順手蓋 `last_seen_at` | 唔影響出紙（但少了一個「叫醒」來源） |
| 網頁結果回填輪詢 | `src/components/print-center.tsx:448`（`9d8e1d5` 2026-09-21 13:13） | 8 秒 | **30 秒** | 紙出咗但 UI 最多遲 30 秒才變「打印成功」 |
| POS 網頁狀態輪詢 | `src/lib/pos/poll-gate.ts`（`f25af2f`） | 60 秒 | **Realtime 通 → 5 分鐘**；閒置 ≥5 分鐘 → 停 | 只影響兜底，唔影響出紙 |

### 2.3 生產 log 證據（權威）

2026-09-22 早上實測（`.workbuddy/memory/2026-09-22.md:152-158`）：

- `PATCH pos_print_agents` 22 次、**間隔中位 180.5 秒**（180.3／180.8／181.1／181.5／181.6，極穩定）；
- `rpc/pos_claim_print_jobs` 21 次、**間隔中位 180.9 秒**；
- ⇒ `claim` 讀到 `nextPollMs`（APK 已支援），而且**每 180 秒只有一個來源** ⇒ 獨立心跳已刪；
- 更新時間大約 2026-09-22 **09:00–09:30**（Vercel 08:24–08:53 仍見 30 秒心跳）。

⇒ **時間線同商家今日投訴「非常慢」完全吻合：APK 今日早上生效，之後每次認領最多要等 3 分鐘。**

### 2.4 兩個放大因素（唔可以忽略）

1. **批次上限 5 張** —— `RelayApi.claim(..., limit=5)` → `claim/route.ts:43` 夾在 1–50，RPC `pos_claim_print_jobs(p_limit)` 預設 5。
   即係**高峰時每 180 秒最多消化 5 張**（≈1.7 張/分鐘）。若一次過落 10 張單，第 6 張起要**多等 3 分鐘**，第 11 張等多 6 分鐘。
2. **叫醒路徑（Realtime）通唔通，決定咗實際係「1 秒」定「180 秒」** ——
   `RealtimeClient.kt` 訂 `pos_print_jobs` INSERT（filter `store_id`）→ `onWake()` → 立即 drain。
   呢條路若失效（訂錯 Supabase 專案會**照樣 SUBSCRIBED 但永遠收唔到事件**、`GET /pair` 缺 `supabaseUrl`/`anonKey` ⇒ APK 唔訂閱），
   出紙就**只靠 180 秒輪詢**。

---

## 3. 唔係本次問題（已核對，避免誤判）

- **結帳收據／免單收據**（`pos-app.tsx:4605`、`4837`、`4953` → `printReceipt()` → `enqueuePrintJobs()` → `pushEvents`）：✅ 有上雲。
- **收銀台落單／加菜**（`submitOrder()`，`pos-app.tsx:3981`）：✅ 有上雲（`claimOncePrintJobs` ＋ `pushEvents`）。
- **退菜單**（`pos-app.tsx:3266/3413/3494`）：✅（`print-jobs.ts:702` 已於 2026-09-11 修好）。
- **線上單接單／取消**（`ledger-pos-bridge.ts:486/715/891`）：✅ `appendPrintJobsWithSync`。
- **交班單**（`shift-page.tsx:1066/1381`）：✅ 刻意自砌 `PRINT_JOB_CREATED`（只推一條），設計如此。
- **店員手機落單**（`use-staff-order.ts:606`）：✅。

---

## 4. 快速判別（唔需要 devtools）

| 現象 | 判斷 | 下一步 |
|---|---|---|
| 該行**等到 3 分鐘以上**仍然係「已發送」 | **問題 A**（本地有、雲端冇） | 睇下係邊種單：自助單（掃碼／自助機）／返結單 ⇒ 符合第 1.4 節 |
| 3 分鐘內變「打印成功」 | **問題 B**（只係慢） | 睇 APK 通知文字、睇 claim 間隔 |
| 有「未上雲」徽章 | 另一類（事件在 queue 但未 synced，例如離線／401） | 睇 queue 事件 |

雲端交叉核對（在 Supabase SQL Editor，POS 專案 `iyrywzormzisyppkokbi`）：

```sql
-- ①② 本地見到嗰張單嘅 id，喺雲端存在嗎？
select id, status, ticket_type, order_no, created_at, last_error
  from public.pos_print_jobs
 where store_id = '<商家 storeId>'
 order by created_at desc
 limit 30;
-- 本地有、呢度冇 ⇒ 確認問題 A

-- ③ 近 2 小時 claim 之間有冇「額外」請求（有 = Realtime 叫醒通；只有 180 秒一個 = 冇叫醒）
--    喺 Supabase Logs 睇 POST /api/... `rpc/pos_claim_print_jobs` 嘅時間間隔
```

APK 側（最快）：睇中繼機（Sunmi）常駐通知文字 ——
「已連線」＝ Realtime 通；「雲端斷線，用 N 秒輪詢兜底」＝ Realtime 唔通（實際延遲即 180 秒）。

---

## 5. 修復建議（分優先級）

### P0 — 問題 A（5 個呼叫端，改法機械化、零風險）

把第 1.4 節 #1–#5 嘅 `appendPrintJobs(...)` 改為 `appendPrintJobsWithSync(...)`（由 `@/lib/pos/print-job-enqueue` 匯入）；
**#6 `printKioskReceiptForOrder()` 唔可以改**（刻意本機）。

建議同時做嘅兩件事：

1. **令同類 bug 唔可以再靜默發生** —— 加一條守衛測試：掃 `src/` 內所有 `appendPrintJobs(` 呼叫端，
   白名單只准 `print-jobs.ts:686`；其他一律 fail（呢類測試專案已有先例，例如
   `heartbeat-contract.test.ts` 用 regex 掃源碼）。
2. **自助單補 `onceKey`** —— 第 #2／#3 兩條路（手動確認 ＋ realtime 自動）會為同一張單各建一張廚房單；
   加 `onceKey: \`kitchen:normal:${order.reopenCount ?? 0}\`` 之後，兩個視窗／兩條路只出一張紙
   （口徑同 `submitOrder()` 一致，見 `print-dedupe.ts` 檔頭）。

### P1 — 問題 B（三選一／可疊加）

| 方案 | 改動 | 效果 | 代價 |
|---|---|---|---|
| **B1 自適應認領間隔**（推薦） | `claim/route.ts`：`jobs.length >= limit`（仲有積壓）→ 返 `3_000`；否則維持 `180_000`。真正即時、單獨改一行 | 高峰近乎即時、閒時照樣省 | 高峰多幾個請求 |
| **B2 調高批次上限** | APK `limit` 5 → 20（route 已夾 ≤50） | 高峰唔會「每 3 分鐘只消化 5 張」 | 需出 APK |
| **B3 結果回填輪詢** | `print-center.tsx` 30 秒 → 10 秒（只在 `/prints` 頁面，且入頁即拉） | UI 遲滯由 30 秒降到 10 秒 | 打印中心長開時 egress 增 |

> B1 係唯一「唔需要出 APK、又唔會令閒時 egress 反彈」嘅做法，建議先做。
> 注意 `SUGGESTED_CLAIM_MS` **唔可以超過 180 秒**（`print-center.tsx` 寫死「`last_seen_at` ≥5 分鐘 → 疑似離線」會誤報）。

### P2 — 補一個「真係印唔出」嘅可見性

現時「本地有、雲端冇」係**完全隱形**。建議喺打印中心加一條低成本檢查：
「job `status === "sent"` 但喺本機 queue 搵唔到對應 `PRINT_JOB_CREATED`，且 `createdAt` 已過 N 分鐘」
→ 標「**未上雲（疑似）**」並提供「重新推送」掣（用 `appendPrintJobsWithSync` 語義重入隊）。
呢個係問題 A 嘅長期防呆（即使再有人漏改，都唔會零症狀）。

---

## 6. 未確認／需要配合

1. **實際係邊幾張單中招**：需要喺 Supabase 用第 4 節 SQL 交叉核對（本機冇 `.env.local`，我讀唔到生產 DB）。
2. **Realtime 叫醒通唔通**：需要睇 APK 通知文字或 Supabase log 嘅 claim 間隔分布（決定問題 B 係「180 秒輪詢」定「Realtime 已失效」）。
3. 現役 APK 源碼：本機 5 個副本（`macauPosAndroid`／`print hub`／`print-relay`／`macauMemebershipPrintingService`／`_ref-macau-ledger-merchant`）
   **全部冇 `nextPollMs` 實作**，但生產 log 證明現役 APK 有讀 ⇒ **本機冇現役 APK 源碼**，
   所以 B2 之前要先確認邊個 repo 出 APK（同 `docs/apk-optimization-handover-2026-09-21.md` 嘅提醒一致）。

---

## 7. 已實作（2026-09-22 13:30）—— P0 ＋ B1 一併落

### 7.1 改動清單

| 檔案 | 改動 |
|---|---|
| `src/lib/pos-orders.ts` | import 由 `appendPrintJobs` 改 `appendPrintJobsWithSync`；`reopenPosOrder()`（返結單）＋ `confirmSelfOrder()`（確認自助單）兩處改用前者 |
| `src/components/pos-app.tsx` | 同上；3 處（backfill 補建、realtime 新自助單、自助單加菜）改用前者 |
| `src/app/api/pos/print-agent/claim/route.ts` | `SUGGESTED_CLAIM_MS` 180_000 → **30_000**；新增 `CLAIM_BACKLOG_MS = 5_000`；`nextPollMs` 改為雙檔自適應（`jobs.length >= limit` ⇒ 5 秒，否則 30 秒） |
| `src/app/api/pos/print-agent/heartbeat/heartbeat-contract.test.ts` | 合約守衛升級：值域檢查改為掃**所有**節奏常數（5_000~180_000）；新增「雙檔判斷式唔可以剝走」 |
| `src/lib/pos/print-enqueue-callsites.test.ts` | **新增**守衛：全 `src/` 掃 `appendPrintJobs(` 呼叫端，白名單只准 `lib/print-jobs.ts`（定義 ＋ 刻意本機 Kiosk 小票） |

已驗證：`tsc --noEmit` **0 error**；`eslint` 改動檔 **0 error**（9 個 warning 全部係 `pos-app.tsx` 既有、與本次無關）；`node --test` 全套見下。

### 7.2 P0 修復前後差異

| 情境 | 修復前 | 修復後 |
|---|---|---|
| 自助單（掃碼／kiosk）**確認**後廚房單＋標籤單＋掃碼單小票 | **永遠冇紙** | 正常出紙（走雲端鏈路，同結帳收據一樣） |
| realtime 收到**新自助單**自動建單 | **永遠冇紙** | 正常 |
| 自助單**加菜**補印 | **永遠冇紙** | 正常 |
| backfill **補建**自助單廚房單 | **永遠冇紙** | 正常 |
| **返結單** | **永遠冇紙** | 正常 |
| 結帳收據／免單／落單／加菜／退菜／線上單／交班單 | 本來正常 | **不變**（未觸及） |
| Kiosk **本機**顧客小票 | 本來正常（刻意本機） | **不變** |

🔴 **只影響「修復之後新發生」嘅單**。已經卡住嘅歷史 job（本地已標 `sent`、雲端冇行）**唔會自動補印** ——
要補就用手動「重打整單」，或做 P2 嘅「未上雲（疑似）＋重新推送」掣。

**代價**：修復後呢啲單會多寫雲端 `pos_print_jobs` 行 ＋ Realtime 事件（每張紙幾 KB）—— 屬正常用量回升，唔係新增浪費。

### 7.3 B1 修復前後差異（出紙延遲）

| 指標 | 修復前 | 修復後 |
|---|---|---|
| claim 基礎間隔 | 180 秒 | **30 秒** |
| 單張（叫醒路徑唔通）最壞等待 | 180 秒 | **30 秒** |
| 單張平均等待 | ~90 秒 | **~15 秒** |
| 一次過 10 張（APK 每次最多 5 張） | 第 6–10 張要再等一輪 180 秒 ⇒ 最壞 **~6 分鐘** | 取滿即回 5 秒 ⇒ 最壞 **~35 秒** |
| APK 請求數 | 0.33 次/分鐘 | **2 次/分鐘**（仍然 **< 優化前嘅 3.0 次/分鐘**） |
| Supabase 位元組 | — | +約 **1 MB/日**（空 claim 只幾百 byte）vs 現時 10~20 MB/日 |
| 出紙後網頁顯示「打印成功」 | 最多遲 30 秒 | **不變**（B3 未做；只影響顯示，唔影響紙） |

⚠️ **誠實講清楚**：若 APK 嘅 Realtime 叫醒本身係通嘅，實際出紙本來就係 1–3 秒 ——
B1 係把**最壞情況**（叫醒失效、網絡抖動、APK 冷啟）由 3 分鐘壓到 30 秒，
唔會令「本身已經快」嘅情況更快。所以：
- 若商家投訴係「**高峰期一次過落好多單，後面嗰幾張等幾分鐘**」⇒ B1 直接解決（6 分鐘 → 35 秒）。
- 若投訴係「**每張單都要等成分鐘**」⇒ 即叫醒路徑唔通，B1 由 180 秒 → 30 秒（仍然有改善，但要真正「即時」就要修叫醒路徑／加長輪詢風險）。

### 7.4 未做（建議下一步）

| 代號 | 內容 | 為何未做 |
|---|---|---|
| B3 | `print-center.tsx` 結果回填 30 秒 → 10 秒（或「出紙後短時追趕」） | UI 遲滯，非功能問題；省 egress 嘅原意要保留，建議做「事件觸發追趕」而唔係全域調快 |
| P2 | 打印中心「未上雲（疑似）＋重新推送」掣 | 需要新 UI ＋ 判定邏輯（防止殘留 job 自動補印） |
| B2 | APK `claim` 批次上限 5 → 20 | 需要出 APK，且要先確認邊個 repo 出 APK |
| — | 確認叫醒路徑（Realtime）實際通唔通 | 需商家睇中繼機通知文字 / 匯出 Supabase log |
