# 實作計劃：列印記錄、報表與點餐提示優化

> 計劃日期：2026-09-04  
> 對應需求：5 項  
> 目的：整理每項需求的處理方式、需調整的頁面/欄位、計算邏輯與注意事項，供審閱後執行。

---

## 1. 列印記錄時間篩選

### 背景
列印中心（`/prints`）目前僅提供狀態篩選（全部 / 已發送 / 待補傳 / 失敗），沒有時間維度篩選。隨著列印記錄累積，店員難以快速查看「今天」或「最近 7 天」的記錄。

### 調整目標
在列印頁面加入時間篩選器，選項為「今天」「昨天」「7天」「30天」「全部」，預設為「今天」，進入頁面時自動載入該時間範圍的資料。

### 修改範圍

| 項目 | 位置 | 說明 |
|------|------|------|
| 狀態與時間篩選區 | `src/components/print-center.tsx` 第 742 行附近 | 加入與狀態按鈕並列的時間篩選 UI（可使用現有的 `SegmentedControl` 或新增按鈕組）。 |
| 時間篩選狀態 | `src/components/print-center.tsx` 第 130 行附近 | 新增 `dateFilter` state，型別沿用 `ReportRangeKey`（`"today" \| "yesterday" \| "7d" \| "30d" \| "all"`）。 |
| 篩選邏輯 | `src/components/print-center.tsx` 第 194–198 行 `filteredJobs` | 先以時間篩選，再以狀態篩選；兩者為 AND 關係。 |
| 日期工具 | `src/lib/ledger/report-period.ts` | 複用 `orderMatchesReportRange` 或新增 `printJobMatchesDateRange`；列印任務使用 `createdAt`。 |

### 計算邏輯
1. 預設 `dateFilter = "today"`。
2. `filteredJobs` 執行順序：
   ```ts
   const base = printJobs
     .filter((job) => dateFilter === "all" || printJobMatchesDateRange(job.createdAt, dateFilter))
     .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
   if (filter === "all") return base;
   return base.filter((job) => job.status === filter);
   ```
3. 時間比對以 `Asia/Macau` 時區為準（與報表一致），使用 `macauDateKey()` 或 `ledgerReportRangeForKey()`。

### 預期結果
- 列印中心頂部出現「今天 / 昨天 / 7天 / 30天 / 全部」時間篩選。
- 預設選中「今天」，僅顯示今天產生的列印記錄。
- 切換狀態篩選時，仍受時間篩選約束。

### 注意事項
- 列印任務儲存在 `localStorage`，`createdAt` 為 ISO 字串，與 `PosOrder` 相同，可直接套用 `report-period.ts` 工具。
- 雲端回填輪詢（`syncCloudPrintOutcomes`）不應受時間篩選影響，仍每 8 秒更新全部記錄。
- 考慮在「全部」時間範圍下是否仍要按 `createdAt` 倒序顯示，並限制最大筆數（例如 200 筆）以避免本地資料過多時卡頓。

---

## 2. 「失敗」狀態篩選顯示不一致

### 背景
截圖顯示：「全部」狀態可見一筆標示為「失敗」的列印記錄，但切換到「失敗」分頁後卻顯示「目前沒有列印記錄」。

### 調整目標
查明兩種篩選下資料不一致的原因，並修正為同一筆記錄在所有狀態篩選下都能正確顯示。

### 調查方向
目前 `filteredJobs` 邏輯非常單純：
```ts
if (filter === "all") return base;
return base.filter((job) => job.status === filter);
```
若「全部」可見而「失敗」不可見，可能原因如下：

| 可能原因 | 檢查位置 | 說明 |
|----------|----------|------|
| A. 該筆記錄的 `status` 不是 `"failed"` | `src/lib/types.ts` `PrintJob.status` | 可能前端 UI 用其他欄位（如 `lastError` 或 `cloudStatus`）判斷為失敗，但本地 `status` 仍是 `pending` / `sent`。 |
| B. 雲端回填與本地狀態不同步 | `src/components/print-center.tsx` `syncCloudPrintOutcomes` | 雲端回傳 `failed`，但本地未正確寫入 `status`。 |
| C. 篩選前被 tombstone / 清除機制排除 | `src/lib/storage.ts` `loadClearedPrintJobIds` | 若該筆 id 在「清除已失敗」後仍顯示，表示 UI 快取與 localStorage 不一致。 |
| D. 狀態欄位拼字或型別不一致 | `PrintJob` 型別與實際資料 | 例如 `"failed"` vs `"fail"` / `"error"`。 |

### 修改範圍

| 項目 | 位置 | 說明 |
|------|------|------|
| 除錯與資料一致性檢查 | `src/components/print-center.tsx` | 在篩選前加入暫時性 `console.log` 或資料檢視，確認 `status` 與 UI 徽章顯示是否一致。 |
| 本地狀態統一 | `src/lib/print-bridge/dispatch.ts`、`src/app/api/pos/print-jobs/status/route.ts` | 確保失敗時本地 `PrintJob.status` 一定寫入 `"failed"`，並同步 `lastError`。 |
| 雲端回填修正 | `src/components/print-center.tsx` 第 404–438 行 | 確認回填後有呼叫 `savePrintJobs` 並觸發 `pos-print-jobs-changed`。 |
| UI 徽章邏輯 | `src/components/print-center.tsx` 第 790–800 行 | 若決定以雲端 `cloudStatus` 為準，需同步修改狀態徽章的判斷依據。 |

### 建議處理方式
1. **先查**：在 `filteredJobs` 與 UI 徽章處同時印出 `job.id`、`job.status`、`job.lastError`，確認不一致的確切原因。
2. **再修**：
   - 若為原因 A：統一以 `job.status === "failed"` 作為失敗判斷標準；UI 徽章與篩選使用同一來源。
   - 若為原因 B：修正 `syncCloudPrintOutcomes` 的合併邏輯，確保雲端 `failed` 能覆蓋本地狀態。
   - 若為原因 C：檢查「清除已失敗」後是否正確從 `printJobs` 移除，並避免 UI 仍保留舊參照。
3. **後驗**：提供一筆失敗記錄，切換「全部」「失敗」「今天」「全部時間」四種組合，均應看到同一筆。

### 預期結果
- 「全部」與「失敗」篩選對同一筆記錄的顯示結果一致。
- 狀態徽章、重試按鈕、清除功能都基於相同的 `status` 值。

### 注意事項
- 修改後需測試雲端回填場景：列印失敗後，無需重新整理頁面，8 秒內「失敗」分頁應出現該筆。
- 若決定引入新的「雲端狀態」欄位，需同步更新 `PrintJob` 型別與儲存/序列化邏輯。

---

## 3. 列印失敗提示 Toast 優化

### 背景
點餐介面（`/pos`）左下角會出現一個固定的紅色列印失敗提示，佔據較大面積且無法關閉，會阻礙收銀員操作。

### 調整目標
將該提示整體尺寸縮小至原尺寸的一半，並設定每次出現後 3 秒自動消失，避免長時間遮擋畫面。

### 修改範圍

| 項目 | 位置 | 說明 |
|------|------|------|
| 列印失敗提示 | `src/components/pos-app.tsx` 第 5438–5452 行 | 縮小 padding、字級與最大寬度；加入 3 秒自動消失計時器。 |
| 容器寬度 | `src/components/pos-app.tsx` 第 5411 行 | 外層 `max-w-xs` 可改為 `max-w-[10rem]` 或更小，避免撐開版面。 |
| 自動消失狀態 | `src/components/pos-app.tsx` 第 319–352 行附近 | 新增 `suppressedFailedPrints` 或基於 timestamp 的隱藏機制。 |

### 計算邏輯
1. 每次 `failedPrintJobs.length > 0` 時，啟動一個 3 秒計時器；3 秒後將該提示隱藏。
2. 若 3 秒內 `failedPrintJobs` 變為 0，提示自然消失。
3. 若 3 秒後又有新的失敗記錄，提示重新出現並重新計時。
4. 縮小後的樣式建議：
   - 外層：`max-w-[10rem] rounded-lg px-2 py-1.5 text-xs`
   - 主文字：`text-xs font-semibold`
   - 錯誤詳情：`text-[10px]` 或完全隱藏，僅顯示數量與連結文字

### 預期結果
- 提示高度與寬度約為目前的一半。
- 提示出現 3 秒後自動隱藏。
- 點擊提示仍可前往 `/prints`；在 3 秒內點擊不受影響。

### 注意事項
- 自動消失不等於問題解決，建議保留某種持續提醒（例如側欄圖示紅點），避免店員忽略列印失敗。
- 若同時有「同步失敗」提示，兩者皆需縮小，並維持垂直堆疊不互相遮蓋。
- 避免使用 `setInterval`，改用 `setTimeout` 並在 `useEffect` cleanup 中清除。

---

## 4. 報表「當日人流」計算方式修正

### 背景
報表中「當日人流（入店人次）」目前可手動輸入數字。需求方認為此設計不正確，應改為系統根據訂單自動計算。

### 調整目標
移除手動輸入框，改由系統自動計算：
- **堂食**：按實際堂食訂單的 `partySize` 加總。
- **快餐 / 外賣**：每一張單視為 1 人，加總單數。

### 修改範圍

| 項目 | 位置 | 說明 |
|------|------|------|
| 人流計算邏輯 | 新增於 `src/components/restaurant-daily-report.tsx` 或 `src/lib/restaurant-footfall.ts` | 根據範圍內訂單自動算出 `footfallTotal`。 |
| UI 卡片 | `src/components/restaurant-daily-report.tsx` 第 732–765 行 | 移除 `input` 與「儲存」按鈕；改為純顯示。 |
| 手動輸入儲存 | `src/lib/restaurant-footfall.ts` | 可保留檔案但改為只讀遷移；或完全棄用 `macau-pos-footfall` localStorage key。 |
| 轉化率計算 | `src/components/restaurant-daily-report.tsx` 第 329、739–743 行 | `conversion = agg.covers / footfallTotal`，其中 `footfallTotal` 改為自動值。 |

### 計算邏輯
在 `aggregate()` 內同步計算人流：
```ts
let footfall = 0;
for (const o of inRange) {
  if (isDineInOrder(o)) {
    footfall += o.partySize ?? 0;
  } else {
    footfall += 1; // 快餐 / 外賣 / 自取，一單一人
  }
}
```

判斷堂食的方式（沿用專案既有慣例）：
```ts
function isDineInOrder(o: PosOrder): boolean {
  return o.tableId !== "counter";
}
```
- `tableId === "counter"` 為快餐 / 自取 / 外賣（`tableName` 為「自取」或「外賣」）。
- `tableId !== "counter"` 為堂食。

`footfallTotalInRange` 改為接受 `orders` 與 `range`，直接從訂單加總：
```ts
export function computeFootfallTotal(orders: PosOrder[], range: ReportRangeKey): number {
  return orders
    .filter((o) => orderMatchesReportRange(o, range))
    .filter((o) => o.status === "settled" || o.status === "partially_refunded" || o.status === "refunded")
    .reduce((sum, o) => sum + (o.tableId === "counter" ? 1 : (o.partySize ?? 0)), 0);
}
```

### 預期結果
- 報表「當日人流」卡片不再出現輸入框與儲存按鈕。
- 人流數字隨訂單資料即時變化。
- 堂食人流 = 各單 `partySize` 總和；快餐 / 外賣人流 = 單數總和。

### 注意事項
- 需決定計算時是否只納入「已結帳 / 已退款」等終態單，或連進行中訂單也納入。建議與「營業額」統一採用終態單（`settled` / `partially_refunded` / `refunded`）。
- 線上訂單轉到堂食枱時，`tableId` 會變成真實桌號，應計為堂食。
- 純線上 counter 單（`onlineOrderId` 存在且 `tableId === "counter"`）是否納入報表範圍？目前 `aggregate()` 的 `inRange` 已包含所有終態訂單，會一併計入。
- 若門店確實需要手動修正人流（例如計算走過門口但沒消費的人），可考慮保留一個「調整值」輸入，但預設仍由系統計算。

---

## 5. 出餐時間統計與「堂食/外賣時長」

### 背景
目前報表的「出餐時間」以 `sentToKitchenAt` 與 `servedAt` 計算。但堂食沒有明確的「出餐」動作，導致堂食訂單的出餐時間經常為估算值。需求方希望新增「堂食時長」與「外賣時長」兩項指標，針對不同流程的每個步驟計算時間長度。

### 調整目標
1. 區分堂食與快餐 / 外賣流程。
2. 為每個流程定義可測量的步驟與對應時間戳。
3. 在報表中分開呈現「堂食時長」與「外賣時長」。

### 現有時間戳欄位
參考 `PosOrder`（`src/lib/types.ts`）：
- `createdAt`：點單時間
- `sentToKitchenAt`：首次送廚房時間
- `servedAt`：出餐 / 可取餐 / 交付時間
- `originalSettledAt`：結帳時間
- `updatedAt`：最後更新時間

### 建議的步驟與指標定義

#### 堂食時長（Dine-in Duration）
堂食沒有「出餐」概念，建議以「下單 → 結帳」為整體時長，並細分：

| 步驟 | 起點 | 終點 | 說明 |
|------|------|------|------|
| 點單 → 送廚 | `createdAt` | `sentToKitchenAt` | 下單到首次送廚的時間。 |
| 送廚 → 結帳 | `sentToKitchenAt` | `originalSettledAt` | 廚房製作加上桌邊服務的總時間。 |
| 點單 → 結帳 | `createdAt` | `originalSettledAt` | 堂食整體時長。 |

#### 外賣 / 快餐時長（Quick/Delivery Duration）

| 步驟 | 起點 | 終點 | 說明 |
|------|------|------|------|
| 點單 → 送廚 | `createdAt` | `sentToKitchenAt` | 下單到首次送廚的時間。 |
| 送廚 → 出餐 | `sentToKitchenAt` | `servedAt` | 實際製作出餐時間。 |
| 出餐 → 完成 | `servedAt` | `originalSettledAt` | 等待取餐 / 交付的時間。 |
| 點單 → 完成 | `createdAt` | `originalSettledAt` | 整體流程時長。 |

### 修改範圍

| 項目 | 位置 | 說明 |
|------|------|------|
| 型別擴充 | `src/components/restaurant-daily-report.tsx` 第 72–120 行 | 新增 `DineInServingStats`、`QuickServingStats` 或統一 `ServingBreakdown` 介面。 |
| 聚合函數 | `src/components/restaurant-daily-report.tsx` 第 122–213 行 `aggregate()` | 分開收集堂食與快餐樣本，並計算各步驟平均 / 中位數 / P95。 |
| 現有 `servingMinutes()` | `src/components/restaurant-daily-report.tsx` 第 81–90 行 | 可保留作為總覽，但新增專用計算函數。 |
| 報表 UI | `src/components/restaurant-daily-report.tsx` 第 711–729 行 | 將單一「出餐時間」卡片改為「堂食時長」與「外賣時長」兩張卡片。 |
| 流程埋點 | `src/lib/quick-order-fulfillment.ts`、`結帳相關程式碼` | 確保 `servedAt`、`sentToKitchenAt`、`originalSettledAt` 在正確步驟寫入。 |

### 計算邏輯
新增函數：
```ts
function dineInStepMinutes(o: PosOrder): DineInSteps | null {
  const created = Date.parse(o.createdAt);
  const sent = o.sentToKitchenAt ? Date.parse(o.sentToKitchenAt) : null;
  const settled = o.originalSettledAt ? Date.parse(o.originalSettledAt) : null;
  if (!Number.isFinite(created)) return null;
  return {
    orderToKitchen: sent ? Math.max(0, sent - created) : null,
    kitchenToSettle: sent && settled ? Math.max(0, settled - sent) : null,
    total: settled ? Math.max(0, settled - created) : null,
  };
}

function quickStepMinutes(o: PosOrder): QuickSteps | null {
  const created = Date.parse(o.createdAt);
  const sent = o.sentToKitchenAt ? Date.parse(o.sentToKitchenAt) : null;
  const served = o.servedAt ? Date.parse(o.servedAt) : null;
  const settled = o.originalSettledAt ? Date.parse(o.originalSettledAt) : null;
  if (!Number.isFinite(created)) return null;
  return {
    orderToKitchen: sent ? Math.max(0, sent - created) : null,
    kitchenToServed: sent && served ? Math.max(0, served - sent) : null,
    servedToSettle: served && settled ? Math.max(0, settled - served) : null,
    total: settled ? Math.max(0, settled - created) : null,
  };
}
```

在 `aggregate()` 中：
1. 遍歷 `inRange` 訂單。
2. 堂食（`tableId !== "counter"`）計入 `dineInSamples`。
3. 快餐 / 外賣（`tableId === "counter"`）計入 `quickSamples`。
4. 每個步驟分別計算 count / avg / median / p95。
5. 僅當某步驟有足夠樣本時才顯示；缺時間戳的步驟標示「—」。

### 預期結果
- 報表「出餐時間」區塊改為兩張卡片：「堂食時長」與「外賣時長」。
- 每張卡片列出各步驟的平均、中位數、P95。
- 堂食不再顯示不適用的「出餐時間」，改為顯示下單→送廚、送廚→結帳、整體時長。

### 注意事項
- 舊訂單可能缺少 `sentToKitchenAt` 或 `servedAt`，需 graceful 處理：缺值時該步驟不納入統計。
- 堂食結帳時是否應寫入 `servedAt`？目前 `markQuickOrderCompletedInStore` 會寫 `servedAt`，但堂食結帳流程可能不會。需確認堂食結帳程式碼，並視情況補上 `originalSettledAt`（通常已有）。
- 若未來要更細緻（如「廚房製作時間」「送餐時間」），可能需要新增時間戳欄位；本次建議先以現有欄位組合出指標，避免改 DB schema。
- UI 呈現時建議使用小字註解「樣本數」與「部分舊單缺時間戳」，避免數據被誤解。

---

## 整體實作順序建議

1. **第 2 項（失敗篩選不一致）**：優先調查，因為這是資料正確性問題，也可能影響第 1 項時間篩選的測試。
2. **第 1 項（時間篩選）**：在確認狀態資料正確後，加入時間維度篩選。
3. **第 3 項（Toast 縮小）**：獨立小改動，可與第 1、2 項並行。
4. **第 4 項（當日人流自動計算）**：涉及報表核心數字，建議在前三項完成後實作。
5. **第 5 項（堂食/外賣時長）**：變動範圍最大，建議最後處理。

---

## 待確認問題

請協助確認以下幾點，以便細化實作：

1. 列印記錄的「時間篩選」與「狀態篩選」是否應該互相獨立（AND）？例如選「失敗」+「今天」僅顯示今天失敗。
2. 「當日人流」是否仍需保留手動調整值（例如門口計數器數字），還是完全由訂單自動計算？
3. 第 5 項的「堂食時長」是否確定以「下單 → 結帳」為主？還是希望加入更多步驟（如入座、點餐、送餐）？
4. 外賣時長是否包含「等待取餐 / 等待外送員」的時間？目前 `servedAt` 標記為「可取餐/待交付」，結帳才標記完成。
