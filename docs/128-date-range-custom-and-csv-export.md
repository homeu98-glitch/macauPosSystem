# 時間篩選「自訂」＋ 訂單頁匯出 CSV

> **日期**：2026-09-13  
> **狀態**：已實作（未部署）  
> **相關**：[`113-agent-gotchas.md`](./113-agent-gotchas.md) §時間篩選／§匯出

---

## 1. 需求來源

商家（J）2026-09-13：

> 在訂單頁面新增「匯出 CSV」功能，具體需求如下：
> 1. 匯出時，線上訂單的資料必須包含客人的電話號碼欄位。
> 2. 匯出內容以商家當前選擇的時間範圍為準，只匯出該範圍內的訂單資料。
>
> 另外，在系統中所有現有時間篩選的位置（目前選項為：今天、昨天、7 天內、30 天、全部），
> 於最右方新增一個「自訂」選項。點擊「自訂」後會彈出視窗，讓商家選擇起始日期與結束日期
> （例如 2026-08-01 至 2026-08-31），確認後即以該日期區間進行篩選，
> 並套用到對應的資料列表與匯出功能。

拍板結論（AskUserQuestion）：

| 問題 | 決定 |
|---|---|
| 「自訂」覆蓋範圍 | **全做** —— 訂單頁（A 系）＋ 報表系（B 系） |
| 客人電話入 CSV | **照做**，只入 CSV 不落庫 |
| 線上單長區間超 RPC 100 張上限 | **自動分頁抓齊** |
| 匯出格式 | **分兩檔**（線上／線下） |

---

## 2. 為什麼要做「統一收口」

加「自訂」之前，專案同時並存 **兩套 key-only 時間範圍型別**：

| 型別 | 檔 | 用喺邊 | 邊界口徑 |
|---|---|---|---|
| `LedgerOrderDateFilter` | `order-date-filter.ts` | 訂單頁 | `7d/30d` 用 `now - days*24h` **毫秒截止** |
| `ReportRangeKey` | `report-period.ts` | 報表／打印／庫存 | Macau **日曆起訖 ISO** |

兩者 key 一樣但語義唔同，而 predicate 更係**散落 6 個檔各寫一套**：

| 落點 | predicate |
|---|---|
| `report-period.ts` | `orderMatchesReportRange`（核心） |
| `print-center.tsx` | `printJobMatchesDateRange`（自寫） |
| `inventory-stats.ts` | `receiptDateMatchesRange`（自寫，字串比較） |
| `restaurant-footfall.ts` | `macauDateKeysInRange` / `footfallTotalInRange` / `footfallFocusKey` |
| `restaurant-bom.ts` | `rangePredicate` |
| `restaurant-daily-report.tsx` | 7 處直接呼叫 |

而且**邊界早就唔一致**：`inventory-stats` 用 `7d → 6 天` 字串比較，`print-center` 用毫秒比較。
所以今次唔只係「加一個 chip」，而係順手統一。

---

## 3. 設計

### 3.1 新增：`src/lib/ledger/date-range.ts`（唯一收口點）

```ts
export type CustomDateRange = { start: string; end: string };          // YYYY-MM-DD（Macau）
export type DateRangeSelection<K extends string> = { key: K; custom?: CustomDateRange | null };

isValidDateKey(v)            // 格式 + 真實存在（擋 2026-02-30 被 Date 自動滾月）
normalizeCustomRange({start,end})  // 無效 → null；start > end 唔自動對調
dateKeyToStartISO / dateKeyToEndISO  // → Macau 00:00:00 / 23:59:59.999 (+08:00)
customRangeToISO(range)
instantInRange(instant, {start,end}) // 毫秒比較，兩端皆含
macauDateKeyOf(instant)
```

### 3.2 兩套 key 型別各加 `"custom"`，但**唔合併**

`LedgerOrderDateFilter = "today"|"yesterday"|"7d"|"30d"|"all"|"custom"`  
`ReportRangeKey      = "today"|"yesterday"|"7d"|"30d"|"all"|"custom"`

合併會連帶改動訂單頁歷史上嘅滾動窗口語義（跨午夜 off-by-one 修過一次），風險唔值。

### 3.3 predicate 第二參數：**Either**（向後相容）

```ts
type DateFilterArg = LedgerOrderDateFilterKey | DateRangeSelection<LedgerOrderDateFilterKey>;
type ReportRangeArg = ReportRangeKey            | DateRangeSelection<ReportRangeKey>;

orderMatchesDateFilter(order, "today")                          // ✅ 舊呼叫照跑
orderMatchesDateFilter(order, { key: "custom", custom: {...} }) // ✅ 新呼叫
```

舊呼叫點**零改動** —— 呢個係今次能做到「改 6 個 predicate 但 tsc 零錯誤」嘅關鍵。

### 3.4 `custom` 未揀區間 ＝ 當「全部」

chips 撳「自訂」只係**開彈窗**，確認後才寫 `custom`。所以 `key === "custom" && !custom`
係一個正常嘅過渡狀態，語義上等於「全部」（`return true`），唔係「乜都唔顯示」。

### 3.5 新增：`src/components/date-range-filter-chips.tsx`（共用元件）

原本同一組 chips 喺 **5 個檔各自 hardcode**（`orders-hub`、`online-orders`、
`restaurant-daily-report`、`print-center`、`inventory-view`），加一個範圍要改 5 處。

元件含：chips ＋「自訂」chip（顯示已選區間）＋ 彈窗（兩個 `<input type="date">`、
驗證、4 個快速預設：今個月／上個月／近 14 日／今年、Esc 關閉）。

觸控規格：chip ≥ 32/36px、彈窗按鈕 ≥ 44px、`input` ≥ 44px、彈窗寬 `min(92vw, 420px)`。

### 3.6 新增：`src/lib/csv-export.ts`

專案本來有 **4 套各寫一次**嘅 CSV 匯出，今次抽共用（只新代碼用，舊嘅未強制遷移）：
`buildCsv` / `downloadCsv` / `csvCell` / `sanitizeFileLabel`。

三個必做細節：**BOM**（Excel 中文）、**引號逃逸**、**公式注入防護**（`= + - @` 前補 `'`）。

---

## 4. 落點清單（9 處）

| # | 檔案 | 改動 |
|---|---|---|
| 1 | `orders-hub.tsx` | chips → 共用元件；兩粒匯出掣；`onlineRows`/`localRows` 上報 |
| 2 | `online-orders.tsx` | chips → 共用元件；`dateFilterSignature()`；`listMerchantOrdersPaged()`；`truncated` 提示 |
| 3 | `local-orders-panel.tsx` | 接受 `DateFilterArg`；`onFilteredOrdersChange` |
| 4 | `restaurant-daily-report.tsx` | `range` 升為 `ReportRangeArg`；chips → 共用元件 |
| 5 | `print-center.tsx` | 刪 hardcode 5 顆 chips 陣列；predicate 收口 |
| 6 | `inventory-view.tsx` | chips → 共用元件；`range` 升為 `ReportRangeArg`；API 帶 `start`/`end` |
| 7 | `app/admin/reports/page.tsx` | `reportRange` 升為 `ReportRangeArg` |
| 8 | `api/inventory/receipts/route.ts` | `VALID_RANGES` 加 `custom`；讀 `start`/`end` |
| 9 | `lib/ledger/reports.ts` | `getMerchantReportSummary(ReportRangeArg)` |

---

## 5. 關鍵約束（唔可以違反）

### 🔴 線上單 RPC 冇 `start`/`end`

`list_merchant_orders` 只有 `p_limit`（**硬上限 100**）＋ `p_since`/`p_since_id` 游標。
自訂長區間（如一個月）會**靜靜截斷**。

解法 = `listMerchantOrdersPaged()`：逐頁以 `computeSyncCursor(batch)` 續抓，
安全上限 **10 頁／1000 張**，達上限 `setTruncated(true)` → 標題列琥珀警告。

⚠️ 分頁必須**順序**（下一頁游標依賴上一頁），唔可以 `Promise.all`。

### 🔴 客人電話 ＝ 個資紅線張力點

`docs/integration/ledger-client-api.md` §7.2：

> 自 Ledger 取得之 `customer_phone` 只**允許當次 UI 渲染**；
> **禁止**寫入 POS Supabase／localStorage／IndexedDB 長期快取／analytics／console.log。
> 若需落地電話須先與 Ledger 協商並更新條款 §6／§11。

CSV 匯出＝把電話寫成**用戶下載嘅檔案**（離開瀏覽器記憶體、可再分發），
嚴格講**超出「當次 UI 渲染」**。

**現行做法**（用戶拍板）：照放，但**只由 RPC → 記憶體 → CSV，零落地**
（唔寫 DB、唔寫 localStorage、唔 console.log）；拿唔到電話就留空，唔強求。

📌 **仍待與 Ledger 確認**。要收緊只需移除 `orders-hub.tsx` 匯出欄位中嘅 `客人電話`。
`PosOrder`（線下單）本身冇電話欄位，所以線下 CSV 無此問題。

### 🔴 唔可以用物件 identity 比較 selection

`orders-hub` 每次 render 都砌新 `{key, custom}` → 物件比對會令 embedded 同步 effect
每次都判定「有變」→ **無限重載**。用 `dateFilterSignature()`（`key:start:end` 字串）。

### 🔴 `range === f.key` 喺 range 變物件後會永遠 false

chip 高亮會全滅，但 **build 捉唔到**。一律 `splitReportRangeArg(range).key`。

---

## 6. 測試

`src/lib/ledger/date-range.test.ts` —— 16 個 `node --test`：

- `isValidDateKey`：合法／格式錯／**唔存在嘅日子**（`2026-02-30`、非閏年 `2026-02-29`、`2026-04-31`）
- `normalizeCustomRange`：正常／單日／`start > end` → `null`（**唔自動對調**）／任一端非法
- 邊界：`instantInRange` 兩端皆含（起始前 1ms、結束後 1ms 都唔計）
- 跨月區間（8 月尾 → 9 月頭）
- `macauDateKeyOf`：UTC 深夜歸入澳門當日

執行：`node --test src/lib/ledger/date-range.test.ts`（16 pass）

---

## 7. 未做 / 後續

- ⏳ **未部署、未 commit**。
- ⏳ 客人電話入 CSV **待 Ledger 確認**（見 §5）。
- 💡 線上單長區間仍受 1000 張安全上限限制；如商家經常匯出超過 1000 張，
  應向 Ledger 要求 `list_merchant_orders` 加 `p_start`/`p_end` 參數。
- 💡 舊嘅 4 套 CSV 匯出（`restaurant-daily-report`、`shift-page`、`pos-app` ×2）
  尚未遷移到 `csv-export.ts`，屬技術債。
