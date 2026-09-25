# 152 · 庫存 UI 對齊確認稿（2026-09-26）

> 前情：2026-09-25 交付咗庫存五項 UX 優化，商家睇完實際介面問
> **「為什麼 UI 跟你畫的差那麼遠?」**。
> 覆核方法：用 `tools/mockup-canvas-fit.cjs --shots` 把確認稿逐個畫面重新 render 成 PNG，
> 左確認稿／右實作逐對比 → 產出 `docs/mockups/inventory-ui-diff-2026-09-25.html`。
> 結論：**主頁同收據 modal 其實忠實**，落差集中喺「庫存・設置」＋幾樣畫咗但未做嘅細節。
>
> 商家拍板（2026-09-26）：
> - **「設置頁要彈窗」** ← 明確否決改成全頁
> - **「改吧其他都，按照你的次序」** ← 照下面 4 項次序做

---

## 一、覆核結論（三類）

| 畫面 | 判定 | 落差 |
|---|---|---|
| ① 庫存主頁 | 忠實 | 付款方式 chips 實作列**主檔全部 9 款**（確認稿只列有資料嘅）；確認稿底部有 footnote ＋「前往設置 →」，實作冇；實作**多**一段「庫存表」 |
| ② 新增收據 modal | 大致忠實 | chip 化 ✔、歷史品項快選 ✔；**未做**：日期 chips、數量 stepper |
| ③ 庫存・設置 | 🔴 落差最大 | 全頁→彈窗（商家要留彈窗）；4 chips→2 tab；雙 panel 並排→單 panel；無 ⠿ 排序、無「用過 N 次」、無「保存」 |

---

## 二、今次改咗乜（照商家指定嘅次序）

### 1. 設置頁對齊確認稿（**保持彈窗**）

`src/components/inventory/inventory-settings-panel.tsx` 重寫：

- **4 個 chips**：供應商／品類／庫存品／支付方式顯示。
  係**多選**（唔係單選 tab），因為確認稿畫嘅係「供應商 ＋ 品類兩個 panel 同時並排」。
  **最少要開一個**（全部關咗個彈窗會一片空白）。
- **兩個 panel 並排**：`grid md:grid-cols-2`，彈窗加闊到 `max-w-5xl`。
- **庫存品 panel** 直接掛現成 `InventoryTable`（`embedded` 模式隱藏重複標題），
  **零重寫**。連帶加咗 `onMutated` callback 解決「兩個 instance 唔同步」問題（見 §三）。
- **支付方式顯示 panel 係唯讀**：只列 `code / 顯示名 / 範圍 / 啟用`＋一段說明
  「主檔由 expenseRecorder 後台統一管理，POS 只可以讀」。**冇任何寫入路徑**
  （守衛 `payment-methods` 唔可以出現喺面板原始碼）。
- **唔加「保存」按鈕**（同確認稿唔同，刻意）：呢個面板每一項都**即時寫入**，冇 pending state。
  加「保存」會令商家以為「唔撳就唔生效」→ 反而製造資料遺失。改用「完成」＋標題寫明「改動即時儲存」。
- **「用過 N 次」**：新 `GET /api/inventory/master-usage`（見 §三）。

### 2. 「用過 N 次」（零 SQL）

新 `src/app/api/inventory/master-usage/route.ts`：

- 由 expenseRecorder `receipts` 取 `.select("merchant_id", { count: "exact" })`，**只一個窄欄位**，
  server 端聚合成 `{ supplierUsage: { merchantId: n } }`。
- `SCAN_LIMIT = 1500`：PostgREST 冇 GROUP BY，唯一做法係拉返再數；
  超上限就回 `capped: true`，UI 講明「依最近 1500 張統計（本店共 N 張）」，**唔扮成總數**。
- **lazy**：只喺「設置 → 供應商」panel 開住嘅時候先叫一次。
  唔可以混入主頁載入路徑 —— 本專案 egress 係痛點（見 DETAIL §G）。
- 🔴 **唔拉 `raw_ocr_data`**：嗰個 jsonb 每行可以幾 KB，1500 行就係 MB 級。
  品類行顯示嘅係說明文案（「收據／庫存品共用」）而唔係次數，所以唔需要。

### 3. 拖 ⠿ 排序（零 SQL，存 PosLocalSettings）

- 新 `src/lib/inventory-order.ts`——**零 import 純函式**
  （本專案 `npm test` 係 `node --test`，**唔認 `@/` alias**；所以可測邏輯一定要獨立成零 import 檔）。
  - `reorderByStored(list, order, keyOf)`：**唔喺 order 入面嘅（新建立）排最後**，
    新供應商一定撳完新增就見到，唔會因為排序設定而失蹤。
  - `moveWithin(list, from, to)`：`from` 越界＝唔動；`to` 越界＝夾到最尾。
  - `orderKeys` / `sanitizeKeyList`：儲存側同讀取側**用同一支轉換**，避免存讀唔一致嘅漂移。
- `PosLocalSettings` 加 `invSupplierOrder` / `invCategoryOrder`（**存名，唔存 id**
  —— 供應商刪咗再建就換 id，用 id 做 key 排序會靜靜失效）。
- 🔴 **一定要加落 `normalizePosLocalSettings()` 白名單**（`storage.ts` 逐欄重建，
  漏咗就係「拖完一 reload / 雲端同步彈返字母序」）。守衛測試已加。
- 拖拽用 **pointer events**（mouse ＋ 觸屏同一套）＋ 把手 `touch-action:none`
  （否則手指拖動會被當成捲動），`setPointerCapture` 令手指移出把手都收得到 move/up。
- **收據 modal 嘅供應商下拉／品類 chips 都跟同一份次序**，唔係設置排好但開單時又變返原本次序。
- 改名／刪品類時同步更新 order（否則舊名變孤兒，改完名會「跳去最後」）。

### 4. 收據 modal：日期 chips ＋ 數量 stepper

- **日期改 chips**：今天／昨天／「選日期…」。原生日曆**收起**直到撳「選日期…」
  （觸屏揀日曆要兩步，而九成單都係今天）。
  `isQuickDate` 判斷而唔係硬比較：非今天/昨天時第三個 chip 直接顯示日期本身。
- 🔴 `yesterdayStr()` 用本地 `setDate(-1)` ＋ `en-CA`，**唔可以** `Date.now() - 86400000` 再
  `toISOString()`（UTC ⇒ 澳門凌晨 0–8 點會算錯一日）。
- **數量 stepper（− 數量 ＋）**：仍然可以直接打字（連續落單更快），stepper 補觸屏；
  下限 0、保留三位小數（食材按 kg 落 0.5／1.25 常見）。
  空白當 0 而唔係 1（撳「＋」應該 0→1）。
- 🔴 數量軌由 `5rem` 加闊到 `10rem`：仍然係 **grid 固定軌**，唔可以用 flex
  （`w-full` 會壓過 `w-<number>` ⇒ 品名欄被壓到 0 寬，2026-09-25 中過）。

### 5. 主頁：付款方式 chips 只顯示有資料 ＋ 底部 footnote

- chips 分兩組：`withData`（有資料，按筆數 desc）＋ `zero`（主檔有但當前 0 筆，默認收埋，
  用「＋N 個未用過」展開）。
- 🔴 **唔可以真係 filter 走零筆數**：呢個正是 2026-09-25 嘅原 bug
  ——「月結 0 張 ⇒ chip 完全唔出現 ⇒ 商家以為系統冇月結」。
  所以零筆數嘅**唔刪、只收埋**，一撳展開。
- 🔴 **當前已選中嘅 key 唔准收埋**：否則「撳完月結再收埋」會出現
  「篩選中但冇 chip 顯示」＝用戶以為篩選失效（實際上表已經被過濾）。
- 底部加確認稿嘅 footnote 條（虛線）＋「前往設置 →」直接入口。

---

## 三、過程中捉到／防到嘅問題

1. **兩個 `InventoryTable` instance 唔同步**（新問題，今次引入 庫存品 panel 時發現）：
   主頁同「設置 → 庫存品」係兩個 component instance，各自一份 `products` state。
   喺設置刪咗一件，主頁唔會知 ⇒ 閂咗彈窗仲見到「已刪」嘅貨。
   解法：`InventoryTable` 加 `onMutated`，主頁用 `key={productsVersion}` 強制換 instance 重載
   （比喺兩個 instance 之間做狀態同步簡單可靠）。守衛已加，且斷言 `onMutated?.()` 出現 **4 次**
   （從收據同步／刪除／新增編輯／盤點四個寫入點）。
2. **`patchLocalSettings()` 統一入口**：所有局部更新一律
   `normalizePosLocalSettings({ ...loadPosLocalSettings(), ...patch })` 再存。
   直接 `savePosLocalSettings({ invCategories })` 會靜靜剷走其餘欄位（打印模板、樓層…）。
3. **守衛測試自己嘅假紅**：`aria-label={`第 ${i+1} 項`}` 呢個寬鬆 regex 會把 stepper 嘅
   「數量減一／加一」都數埋（3 → 5）。收窄到逐個欄名精確比對。
4. **`.w-full` cascade 地雷**：新增 stepper 時冇用 flex，維持 grid 固定軌（見 §二.4）。

---

## 四、驗證

| 項目 | 結果 |
|---|---|
| `tsc --noEmit` | 0 error |
| `node --test`（全套） | **1657 pass / 0 fail**（庫存守衛 61 條、排序純函式 13 條） |
| `eslint`（改動檔） | 0 error |
| `next build` | ✓（`/api/inventory/master-usage` 以 `ƒ Dynamic` 出現） |
| 真瀏覽器 render | 見 `docs/mockups/inventory-impl-2-2026-09-26/` |
| 對照頁（**改動前**） | `docs/mockups/inventory-ui-diff-2026-09-25.html` |
| 對照頁（**改動後**） | `docs/mockups/inventory-ui-diff-after-2026-09-26.html`（10 張圖 inline base64、逐項判定） |

> 🔴 兩份對照頁**唔可以混為一談**：`-2026-09-25` 貼嘅係**改動前**嘅實作截圖（落差仍在），
> `-after-2026-09-26` 才係收口後嘅狀態。交報告時要明確講係邊一份，否則等於自打嘴巴。

---

## 五、仍未做（同商家講清楚）

- **確認稿嘅「← 返回庫存」**：商家要彈窗，彈窗冇「返回上一頁」語義，所以用「完成」。
- **主頁仍然有「庫存表」section**：確認稿主頁冇畫（確認稿把庫存品放喺設置）。
  今次**冇移除**（避免功能倒退），所以主頁會同時有「庫存表」同「設置 → 庫存品」兩個入口。
  兩個入口嘅資料已用 `productsVersion` 打通。
- **商家端「結帳顯示哪幾款」**仍未收口到支付方式主檔（沿用 `PosLocalSettings.paymentMethods`）。
- `receipt_items.user_id` 仍然唔喺任何 SQL 檔（靠人手 ALTER）⇒ 建議補 migration。
