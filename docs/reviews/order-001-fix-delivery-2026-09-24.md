# 取餐碼 001 漏帳 ── P0／P1／P2 修復交付（2026-09-24）

> 前提約束：**修復後系統流量不得明顯上升**、**現有功能必須維持正常**。
> 本文件逐項列出改動、**流量足跡**與**既有功能影響**。

---

## 0. 一句話總結

**真因**：Ledger 線上單嘅「排序鍵」係 `updated_at`，但報表／交班用 `createdAt` 判斷有冇過區間起點
⇒ **一張「昨日落單、今日完成／今日預約取餐」嘅單（001 正是預約單）會令翻頁提早 `break`，
之後所有線上單一齊靜默消失。**

**修法**：三層 —— ①統一時間口徑（止血）②加對數警示（唔可以再靜默）③一鍵補建入 POS（還原數據）。

---

## 1. P2 ── 統一 Ledger 線上單時間口徑（止血）

### 改咗乜

| 檔案 | 改動 |
|---|---|
| `src/components/restaurant-daily-report.tsx` | 兩處翻頁迴圈（admin／非 admin）由 `const ts = o.createdAt ?? o.updatedAt` 改為 `orderEventInstant()` / `orderEventISO()`；`byHour` 一齊統一 |
| `src/lib/ledger/paid-orders.ts` | 交班側同款改動 |
| `src/app/api/admin/ledger/orders/route.ts` | server 端篩選由 `created_at` 改 `updated_at`，排序同步改（否則前端改了、server 照漏） |
| `src/lib/pos/ledger-online-range.test.ts`（新） | 迴歸測試：**重現事故**（舊寫法結果 `["007"]`、新寫法 `["001","002","003","007"]`）＋源碼掃描守衛 |

### 為何正確（而唔係「換個口徑遷就」）

- `order-event-time.ts` 明文係「**全站唯一時間口徑**」：`reopenedAt → originalSettledAt → updatedAt → createdAt`；
  報表／交班／訂單頁本來就應該一致。
- RPC 排序鍵係 `updated_at` ⇒ **過濾鍵必須等於排序鍵**，`break` 語義先至成立。
- 商家口徑係「今日**收到幾多錢**」，唔係「今日開咗幾多張單」⇒ `updatedAt` 才係對帳口徑。

### 流量影響 ── **零變化**

純本地判斷邏輯。**冇新增、冇修改、冇刪除任何請求**；RPC 呼叫次數、`limit`、分頁頁數完全不變。

### 既有功能影響

| 項目 | 影響 |
|---|---|
| 報表／交班線上單歸屬日 | 由「下單日」改為「最後事件日」。**跨午夜結帳嘅線上單會移到「收到錢嗰日」** —— 呢個係修正（兩頁同步改，唔會重複計） |
| 尖峰時段圖 | Ledger 單嘅鐘頭分組改用同一口徑（以前係 `createdAt`，同一張單「歸屬日」同「鐘頭」讀唔同欄位） |
| admin 後台報表 | server 由 `created_at` 改 `updated_at` ⇒ 會多回「昨日落單、今日完成」嘅單（同商家口徑對齊） |
| POS 單（線下） | **唔受影響**（本來就用 `orderEventInstant`） |

---

## 2. P0 ── 線上單對數警示（唔可以再靜默漏單）

### 改咗乜

| 檔案 | 內容 |
|---|---|
| `src/lib/pos/online-reconcile.ts`（新，零依賴） | `reconcileOnlineOrders()` 找出「已付款、非取消、但 POS 冇記錄」嘅線上單；`onlineFetchWarning()`、`unadoptedNotice()` 文案 |
| `src/lib/pos/online-reconcile.test.ts`（新） | 7 tests（含 001 實案、取消／未付款唔誤報） |
| `src/components/online-reconcile-banner.tsx`（新） | 警示條元件（紅色＝資料不完整、橙色＝有未入帳單 ＋ 補建按鈕） |
| `restaurant-daily-report.tsx` | 接線（「訂單明細」卡片上方） |
| `shift-page.tsx` | 接線（「線上線下合計（實收）」卡下方） |

### 補上嘅舊缺口

| 情況 | 舊行為 | 新行為 |
|---|---|---|
| Ledger 抓取 `error` | 只喺「尖峰時段」卡細字顯示 | KPI 帶下方**紅色警示** |
| Ledger `skipped`（未登入商戶） | **完全靜默** | **紅色警示**「今日線上金額未計入」 |
| `N` 張已付款單只喺 Ledger、POS 冇單 | **從來冇提示** | **橙色警示** ＋ 取餐碼清單 ＋ 金額 ＋ 補建按鈕 |

### 流量影響 ── **零新請求**

全部輸入由**已經抓到**嘅 `onlineOrders` / `ledgerPaidOrders` / `orders` 推導（純 `useMemo` 計算）。
冇 timer、冇 polling、冇新 API。

### 既有功能影響

- **冇警示時元件 render `null`** ⇒ 佈局、間距、KPI 格數**完全不變**（KPI 帶維持固定 5 欄）。
- 唔改任何現有計算：對數結果**唔參與**營業額／實收，純顯示。
- 交班頁原有「補推未完成狀態」按鈕**保持原樣**（呢個係另一件事：本地已 settled 但 Ledger 未 completed）。

---

## 3. P1 ── 未入帳線上單一鍵補建（還原數據）

### 改咗乜

| 檔案 | 內容 |
|---|---|
| `src/lib/ledger/ledger-pos-bridge.ts` | 新增 `adoptCompletedLedgerOrderToLocal()`；`upsertLedgerLocalOrder()` 加可選 options `forceSettled` / `skipPrint` / `updatedAtOverride`（**向後兼容，現有呼叫端零改動**） |
| `restaurant-daily-report.tsx` | 橙色警示內嘅「補建入 POS」按鈕 ＋ 結果訊息 |

### 安全閘（唔可以拆）

1. **只補** `paymentStatus === "paid"` **＋** 正規化狀態 `completed` ⇒ 未付款／未完成嘅單唔會被補上
   （否則就係向報表謊報收入）。
2. `id = ledger-<uuid>` **upsert** ⇒ 同一張 Ledger 單永遠只有一張本地單（append 會令收入雙計）。
3. `skipPrint: true` ⇒ **唔會出紙**（單已經做過，廚房唔應該再收一張）。
4. `updatedAtOverride` 用 Ledger 事件時間（**只接受過去值**）⇒ 補一張**昨日**漏單會入**昨日**，
   唔會被當成今日生意；平台單未來時間會 fallback 用 `now`。
5. 補建單自帶 `onlineOrderId` ⇒ 報表 `posOnlineIds` 會自動去重 ⇒ **Ledger 補單同 POS 單唔會雙計**。

### 流量影響 ── **只在用戶主動撳先發生**

| 動作 | 請求 |
|---|---|
| 平時（冇漏帳） | **按鈕唔會出現** ⇒ 零流量 |
| 撳一次（假設 N 張） | 每張 1 次 `get_order_detail`（Ledger RPC）＋ 1 批 outbox 上雲（`POST /api/pos/sync`） |
| 完成後 | 1 次軟刷新（**重跑既有三條 effect**，唔新增請求路徑） |

- **冇週期性請求、冇新 polling、冇新 Realtime channel。**
- `ledger-pos-bridge` 用**動態 import** ⇒ **唔加報表頁初始 bundle**（只在撳按鈕時載入）。
- 正常一日 0–1 張 ⇒ 相對現有 egress 可忽略。

### 既有功能影響

- 現有排位／快餐採納／接單路徑**完全不變**（新 options 全可選，預設行為等同舊版）。
- 補建後果：該單會出現在「線下訂單」／交班明細／對帳，並上雲 ⇒ **這是預期效果**。
- 失敗處理：逐張 try/catch，失敗計數並提示「可再撳一次重試」，**唔會中斷其他單**。

---

## 4. 驗證

| 項目 | 結果 |
|---|---|
| `tsc --noEmit` | **0 error** |
| `eslint`（9 個改動檔） | **0 error**（4 個 warning 全部係既有：`PosLocalSettings`／`debugOpen`／`Pill`） |
| `node --test "src/**/*.test.ts"` | **1474 passed / 0 fail**（含新增 13 個測試） |

新增測試：
- `src/lib/pos/ledger-online-range.test.ts`：6 tests（事故重現 + 源碼掃描守衛 3 個檔）
- `src/lib/pos/online-reconcile.test.ts`：7 tests（含 001 實案）

---

## 5. 部署後建議驗證（一次過）

1. 開「營業報表 → 今天」：001（MOP 43 · 外賣自取 · 餘額扣點）應該出現在**訂單明細**；
   同時 KPI「應收金額合計」subtitle 嘅「線上」應該包含它。
2. 同一時間睇「訂單明細」上方會出現**橙色警示**「有 1 張線上已付款單（MOP 43）POS 冇記錄」
   （因為 P2 修好只令報表**計到錢**，POS 訂單庫仍然冇該單）。
3. 撳「補建入 POS」⇒ 提示「已補建 1 張」，橙色警示消失；
   「線下訂單」／交班明細亦會見到該單。
4. 交班頁：「線上實收」金額不變（避免雙計），但下方橙色提示會消失。

> ⚠️ 若第 1 步仍然見唔到 001，代表 Ledger 抓取本身失敗（`onlineFetchInfo.status` 非 success）——
> 此時第 2 步會出**紅色**警示，可直接睇到原因（未登入／錯誤訊息）。
