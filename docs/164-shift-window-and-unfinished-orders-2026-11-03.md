# 164 · 交班「本班時間窗」＋未完成訂單提示（2026-11-03）

> 商家回報（2026-11-02 晚）：
> ① 線上單客人已付款，店員冇喺 POS 完成就直接交班 —— 錢係啱（Ledger 已付款），但 POS 狀態仍然未完成，**流程零提示**。
> ② 交完班之後，交班頁「今日摘要」啲數仍然停留喺畫面；而且夜宵店 11/3 20:00 → 11/4 02:00 係同一個「交班日」，用日曆日計會令 11/3 晚市完全消失。

## 一、根因

| 位置（改動前） | 用咩區間 | 後果 |
|---|---|---|
| `shift-page.tsx` 拉雲端單 | `macauTodayRange()` | 跨午夜班只拉到 00:00 之後 |
| 線下彙總／線上本地投影／明細 | `orderMatchesReportRange(o, "today")` | 11/3 晚市全部唔計 |
| Ledger 摘要 + 已付款單加總 | `"today"` | 交班單紙本一樣錯 |
| `expectedCash`（現金箱應收） | 由上面嘅 summary 派生 | 夜宵班現金數唔啱 |
| 「結數交班並打印」按鈕 | 直接開 step1 | 未完成單直接放行 |

另外順帶發現一個**漏數**：`onlineLocalOrders` 只認 `settled`，但 `localOnlineIds` 用 `loadOrders()` 全量去重
⇒ 一張「已付款但未結帳」嘅線上投影單，本地唔計、Ledger 又被 id 排除 ⇒ 線上實收變 **0**。

## 二、商家決策（2026-11-03）

1. 紅色掣文案用「**仍然交班**」（唔用「確定」）。
2. **平台單（澳覓／MFOOD）唔提** —— 由平台 App 自己管流程，計落去會每班誤報。
3. 「未完成」＝**任何未完成狀態**：本地 `draft / sent_to_kitchen / paid / reopened` ＋ 線上非終態（**包括未付款**）。
4. 「本地 paid 線上投影漏計」**一齊修**。

## 三、口徑

### 3.1 本班時間窗（`src/lib/pos/shift-window.ts`）

```
本班 = [ shift.openedAt , now ]     // 開班中（自然跨午夜）
     = null                         // 未開工／已交班 → 所有數字 0
```

- 純模組、零 `@/` import，`shift-window.test.ts` 覆蓋跨午夜／邊界／裝置鐘被調慢。
- 交班頁每 60 秒 tick 一次 `nowMs`（只在開班中），令區間尾跟得上新單。
- 交班頁嘅 `pos-orders-changed` listener 只重讀本機、**唔重拉雲端、唔落 loading**（避免整頁閃）。

### 3.2 未完成訂單（`src/lib/pos/unfinished-orders.ts`）

| 來源 | 算未完成 | 排除 |
|---|---|---|
| 本地 `pos_orders` | `draft` / `sent_to_kitchen` / `paid` / `reopened`（＝報表「未結帳」同一口徑） | `settled` / `cancelled` / `refunded` / `partially_refunded`；平台單 |
| Ledger 線上單 | 任何非終態，**唔理付款狀態** | `completed` / `cancelled` / `refunded` |

兩個紀律：

1. **平台單唔提**（`isPlatformOrderSource()` 直接複用）。
2. **同一張單本地／線上只列一次**：本地任何投影（不論狀態）都會令對應 Ledger id 被剔除，
   避免「本地已 settled、Ledger 未 completed」嘅同步滯後被誤報。

### 3.3 Ledger 精確窗（`src/lib/ledger/report-period.ts`）

`ReportRangeArg` 加咗可選 `window: { start, end }`（ISO，兩端皆含）：

- `resolveReportRange()` 見到 `window` 就**優先**採用；格式無效 → `null`（fail-closed，唔會退回「今日」）。
- `orderMatchesReportRange()` 唔會再落 `all` / 「custom 未有區間」嘅短路。
- `getMerchantReportSummary()` / `sumPaidLedgerOrders()` 本身經 `resolveReportRange()`，**零額外改動**就支援任意起訖。

> ⚠️ 唔可以用 `custom`（`YYYY-MM-DD`）代替：日級區間會連上一班嘅日間單都包埋。

## 四、UI 行為

### 4.1 交班前提示

撳「結數交班並打印」→ 即場用「本機 `loadOrders()` ∪ 已 merge 嘅雲端 `orders`」＋「Ledger 已付款＋未付款單」重算：

- **0 張** → 直接入原本 step1（流程零改動）。
- **有** → 彈窗「有 N 張訂單仲未完成」，列出頭 5 張（單號／枱或類型／時間／金額／付款狀態），
  按鈕：`查看訂單`（白）／`仍然交班`（**紅**）。彈窗**唔會阻止交班**。
- Ledger 讀唔到（未登入／失敗）→ 彈窗加一行提示，只列本機單。

### 4.2 「查看訂單」→ `/orders` 高亮

- URL：`/orders?unfinished=1&from=YYYY-MM-DD&to=YYYY-MM-DD`
  （`from` ＝ min（班次窗首日, 最早未完成單嘅日）；`to` ＝ 今日）。
- `orders-hub.tsx` 入頁讀 query → 設 `custom` 日期範圍 → 傳 `highlightUnfinished` 落兩個 panel → `replaceState` 清 query。
- 兩個 panel 用**同一個 predicate** 各自計高亮集；本地有投影嘅線上單由本地 panel 負責，唔會重複標。
- 每張未完成卡／列：`ring-2 ring-rose-400` ＋ `pos-unfinished-highlight`（`globals.css`，閃 3 下；`prefers-reduced-motion` 停用）＋「⚠️ 未完成」chip；自動捲到第一張。
- 列表頂 banner：「⚠️ 有 N 張未完成」／「✅ 呢邊全部訂單已完成」。
- 高亮模式放寬本地 panel 嘅可見範圍（連快餐 counter 單），否則 counter 單高亮唔到。

### 4.3 交班後清零

- 摘要標題改「**本班摘要**」，副題顯示「本班：開工時間 → 現在 · 跨午夜照計同一班；交班後清零」。
- 已交班 → 「本班已交班（{time}），數據已清零。下一班由『開工』開始。」；從未開工 → 「未開工 · 開工後由 0 開始計。」
- 買貨支出卡：冇開班 → `—`；開班中照顯示**今日**買貨（收據只有 `receipt_date`，做唔到班次級），
  卡片加註「（今日買貨；收據只有日期，唔跟班次）」。
- 交班單紙本／預覽嘅分節標題預設由「（今日）」改為「（本班）」（`SHIFT_SECTION_TITLES`）。
  ⚠️ 已有自訂模板嘅商戶保留自己嘅文字。

### 4.4 線上實收漏數修正

`onlineLocalOrders` 由「只認 `settled`」放寬為「`settled` **或** `paid`」。
`reopened` 刻意唔包（筆錢已喺上次結帳計過，會雙計）。
明細 caption 同步改為「只列已結帳」，避免同 `onlineLocalMop` 嘅差額被誤讀。

## 五、檔案

**新增**

- `src/lib/pos/shift-window.ts` ＋ `.test.ts`
- `src/lib/pos/unfinished-orders.ts` ＋ `.test.ts`
- `src/lib/pos/order-merge.ts` ＋ `.test.ts`（終態優先合併：防止遲到嘅「未完成」舊 event 蓋走「已結帳」）

**修改**

- `src/lib/ledger/report-period.ts`（`window` 支援）
- `src/lib/ledger/paid-orders.ts`（回傳 `unpaidOrders`，提示用，**唔計錢**）
- `src/components/shift-page.tsx`（班次窗、提示彈窗、導航、文案）
- `src/components/orders-hub.tsx`（query → custom range + 高亮模式）
- `src/components/local-orders-panel.tsx` / `online-orders.tsx`（高亮 + banner + scroll）
- `src/lib/escpos-template.ts`（分節標題預設「本班」）
- `src/app/globals.css`（`pos-unfinished-pulse`）
- `src/lib/i18n-dict-zh.ts` / `i18n-dict-en.ts`（31 條新 key）

## 六、驗證

```bash
node node_modules/typescript/bin/tsc --noEmit     # 0 error
node --test                                        # 2867 pass / 0 fail
node --test src/lib/pos/shift-window.test.ts src/lib/pos/unfinished-orders.test.ts
```

人手驗收：

1. 模擬 11/3 20:00 開班 → 11/3 19:50 結帳單**唔計**、23:50 **計**、11/4 01:30 **計**。
2. 交班後三個大數 = 0 並出現「已交班、數據已清零」；開新班後由 0 累積。
3. 有未完成單 → 彈窗；0 張 → 直接 step1。
4. 「查看訂單」→ 兩邊 panel 標紅、動畫、自動捲到第一張。
5. 英文介面全部新文案有翻譯。

## 七、已知限制

- **Ledger 純線上舊單**（上一班之前已付款、一直未完成）唔會喺本班提示，因為 `sumPaidLedgerOrders`
  只掃班次窗。如要「永遠提示直到完成」，需額外掃 7 日（多一次分頁請求）—— 未做。
- 交班數（本班）同報表（日曆日）對跨午夜店**刻意不同**；對帳時要知。
- 買貨支出只做到日級（收據冇時刻）。
- 交班單序號 `YYYY-MM-DD-NN` 仍按**交班日**（closedAt）分日，夜宵班嘅單號日期會係翌日。未改。
