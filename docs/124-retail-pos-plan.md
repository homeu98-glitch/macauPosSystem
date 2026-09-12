# 124 - 零售版 POS 規劃（Retail Vertical）

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-09-12（v2：商家已拍板，見 §7） |
| 狀態 | **已定案 — 可進入 Phase 0 實作**（實作清單見 §8） |
| 前置閱讀 | [`docs/113-agent-gotchas.md`](113-agent-gotchas.md)（坑總表，改動前必讀） |
| 擴充先例 | [`docs/26-beauty-salon-vertical.md`](26-beauty-salon-vertical.md)、[`docs/27`](27-salon-pos-db-integration.md)、[`docs/31`](31-salon-staff-wages-products-board.md)、[`docs/32`](32-salon-ledger-integration-requirements.md) |
| 範圍 | 在現有 `macau-pos` 基礎上新增零售業態，**沿用同一入口、同一後端、同一 storeId 體系**，不另起一套系統 |

---

## 0. 結論摘要

### 0.1 定位

`macau-pos` 已有兩個業態並存：餐飲（`/`，主 `PosApp`）與美容沙龍（`/salon/*`，獨立路由樹 + 側欄）。零售商戶層的 `AccountStore.industry` 現時只有 `"restaurant" | "salon"`（`src/lib/types.ts:23`），**擴成 `"retail"` + 新增 `/retail/*` 路由樹**即可，做法完全複製 salon 的成功先例。

**業態範圍（商家已拍板，見 §7）**：

| 業態 | 優先 | 關鍵特徵 |
| --- | --- | --- |
| **便利店** | **主力** | 高頻多件、低單價、條碼齊、要快；有煙酒（年齡限制商品） |
| **藥房** | **主力** | 條碼齊、要批次／效期、有受管制藥物（需登記）、客單中等 |
| **賣菜 / 生鮮** | 支援 | **要稱重** → 見 §2.5「條碼標籤秤」方案 |
| 服裝 | 支援 | **變體（顏色 × 尺碼）** 必需 |
| 家居 | 支援 | 大件、可能需要送貨單 |

**零售係獨立模式** —— 唔同餐飲／沙龍同機並存，`industry="retail"` 嘅終端登入即入 `/retail`，側欄只有零售功能，唔會出現桌台／廚房／出餐概念。呢個決定大幅簡化實作：**唔需要做「模式切換器」**，`/retail` 係一條完全獨立的分支。

```
統一入口（一個 Next.js app、一個 storeId、一組裝置憑證）
├── 餐飲     industry="restaurant"   /            PosApp（桌台 / 快餐 counter）
├── 沙龍     industry="salon"        /salon/*     SalonSidebar + workbench
└── 零售     industry="retail"       /retail/*    ← 本次新增（RetailSidebar + 收銀台）
```

### 0.2 最重要嘅五個判斷

1. **可重用度約 60%**。訂單狀態機、離線 outbox、即時同步、列印三端、會員 / 報表 / 交班 / 沽清，幾乎零改動可以直接用。零售真正嘅工作量集中在「**商品識別**」同「**結帳收款**」兩段。
2. **最大缺口係商品模型冇條碼**。`MenuItem`（`src/lib/types.ts:113`）、`LedgerMenuProduct`、`InvProduct` 三處都冇 `sku` / `barcode` 欄位，全 repo grep `barcode|sku` 只命中一處標籤紙文案。**冇條碼，掃碼槍就係廢鐵** —— 所以資料層係 Phase 0，冇得跳。
3. **掃碼槍唔使買住，而且要用「自動學習」配對**。掃碼槍本質係「鍵盤 wedge」（HID 輸入），實作上只係一個全域 `keydown` 緩衝 hook。**難點唔在於接，在於市面上幾百款型號嘅出廠前綴／後綴／結尾符都唔同** → 照打印機做法做型號配對（見 §2.6）。
4. **稱重唔需要藍牙，用「條碼標籤秤」可以完全繞過網頁限制**。業界標準做法係秤自己出一張 **price-embedded EAN-13 條碼標籤**（`2`/`02` + 5 位 PLU + 5 位重量或金額 + 校驗位），POS 只需當普通條碼掃 —— **零整合、零驅動、iPad 一樣用得**。呢個係本文最重要嘅發現（見 §2.5）。
5. **收據模板缺條碼行**。`ReceiptSectionId`（`src/lib/types.ts:285-334`）係固定枚舉，有 `items` / `total` / `cash_tendered` / `change_amount`，但**冇 barcode、冇拆分付款、冇積分**。擴枚舉要同步改**四個出紙端**（見 §6 紅線）。

### 0.3 可重用度總覽

| 層 | 可重用度 | 說明 |
| --- | --- | --- |
| 訂單狀態機 / 型別 | 🟢 85% | `PosOrder` 八態已夠用，只需加零售欄位 |
| 離線同步 / Outbox | 🟢 95% | store-scoped，零產業耦合 |
| 列印（三端 + 模板同步） | 🟡 70% | 引擎可直用，模板區塊要擴 |
| 會員 / Ledger | 🟢 90% | 直接可用（零售做會員積分反而係加分） |
| 交班 / 沽清 / 庫存 | 🟡 60% | 交班直用；沽清語義對零售 = 缺貨停售，可用；庫存要重做 |
| 商品 / 餐牌 | 🔴 25% | 缺 SKU / 條碼 / 單位 / 稅碼 / 稱重，**必須擴型別** |
| 收銀畫面 | 🔴 10% | `PosApp` 綁死桌台 / 快餐概念，零售要新畫面 |
| 掃碼能力 | 🔴 0% | 完全冇（現有「掃碼」= 客人掃 QR 自助點餐，唔係掃商品） |

---

## 1. 零售營運流程設計

### R0 — 開班與登入（改動：小）

| 環節 | 設計 | 串接 |
| --- | --- | --- |
| 登入 | 沿用 `AuthGuard` + 員工 PIN（`docs/123`） | `src/components/auth-guard.tsx`、`login-screen.tsx` |
| 開班 | 沿用交班頁輸入開班現金 | `src/app/shift/page.tsx`、`src/lib/shift-sync.ts` |
| 裝置 | 沿用終端憑證（`pos-device-token.ts`） | `/api/pos/state` 只認終端憑證 |

**注意**：零售要多一個「錢箱」概念。開班現金 + 中途找零支出 + 閉班差異，現有交班流程已有現金起算與對帳欄位，只需在零售報表加「現金長短」摘要。開錢箱（ESC/POS kick 指令）屬新增，放 Phase 2。

### R1 — 商品識別（改動：大，核心）

三條輸入路徑，**收斂到同一個 `addToCart(product, qty)` 入口**：

```
① 掃碼槍（HID 鍵盤） ─┐
② 條碼/SKU 直入（數字鍵盤）─┼─→ resolveBarcode(code) ─→ Product ─→ addToCart()
③ 觸控搜尋（名稱/分類/常用）─┘
```

**設計要點**

- **條碼索引**：建立 `barcode → productId` 記憶體 Map，由商品清單衍生。一個商品可多條碼（EAN-13 廠碼 + 店內自編碼），故索引係 `barcode → productId`（多對一）。
- **自編碼規則**：店內無條碼商品（散裝、餐飲轉售）用前綴區間分配，例如 `20` 開頭 = 店內自編，`21` 開頭 = 稱重。
- **命中即入車**：成功 → 購物車行數量 +1 + **圖文回饋確認**（見 §2.4）；失敗 → 響鈴 + 紅色 toast「條碼未登記」，**絕不靜默**（沿用餐飲側「狀態唔准靜默無反應」的既有口徑）。
- **搜尋排序**：完全匹配 > 前綴匹配 > 名稱包含；顯示「最近掃描」「常用商品」「分類 tab」，因為零售店員實際用最多嘅係**最近 20 件**，唔係全品項搜尋。

**串接**：新增 `src/lib/retail/barcode-index.ts`（純函式，可單測）；新增 `src/lib/retail/use-barcode-scanner.ts`（client hook）。

### R2 — 購物車建構（改動：中）

現有 `src/lib/kiosk-cart.ts` 係**純函式**購物車層（`CartLine`、`lineSignature`、`mergeCartLine`、`changeCartQty`、`computeOrderTotals`），零 runtime 依賴、有單測（`kiosk-cart.test.ts` 覆蓋簽名順序無關、規格不合併、歸零移除、稅費口徑）。**這是整個規劃最值錢嘅可重用資產**，零售直接沿用同一套函式，只係擴欄位。

**零售需要的擴充**

```ts
export type CartLine = {
  lineId: string;
  productId: string;          // ← 由 menuItemId 改名（或保留並加 alias）
  sku?: string;               // 新增
  barcode?: string;           // 新增（記錄掃入嘅條碼，出票要印）
  name: string;
  unitPrice: number;          // ← 由 price 改名，語義變「原價」
  quantity: number;
  unit?: string;              // 新增：件 / kg / 包
  weight?: number;            // 新增：稱重商品
  priceOverride?: number;     // 新增：單品改價（零售高頻！）
  lineDiscountRate?: number;  // 新增：單品 % 折
  lineDiscountAmount?: number;// 新增：單品定額折
  taxCode?: string;           // 新增：稅碼（澳門多數免稅，但保留擴充位）
  note?: string;
  printerGroup: PrinterGroup; // 保留（零售多數不用，但架構唔拆）
};
```

**合併策略**：`lineSignature` 目前 = `productId|specs|note`。零售要**把折扣同改價納入簽名** —— 否則「原價可樂」同「特價可樂」會被合併成一行，帳目就錯。但**序號商品**（手機 IMEI、電器）必須**每件獨立成行**，故簽名要加 `serialNo` 或一個 `nonMergeable` 標記。

**注意**：連掃兩次同一商品要「數量 +1」而唔係「兩行」—— 現有 `mergeCartLine` 已經係呢個行為，唔使改。

### R3 — 數量與折扣調整（改動：大）

| 操作 | 現有 | 需新增 |
| --- | --- | --- |
| 數量 +/- | ✅ `changeCartQty` | 直接輸入數量（`input-pad-modal` 可直用） |
| 掃碼 ×N | ✅ 連掃自動累加 | 批量輸入（例如「×12」一次入 12 件） |
| 單品 % 折 | ✅ `OrderItem.discountRate` | — |
| **單品定額折** | ❌ | `discountAmountFromFixed()` |
| **單品改價** | ❌ 完全冇 | 覆寫 `unitPrice`，保留 `originalUnitPrice` 供對帳 |
| 整單 % 折 | ✅ `discountAmountFromRate()` | — |
| **整單定額折 / 抹零** | 🟡 只有系統抹零 `roundingAmount` | 手動整單減額 |
| **優惠券 / 會員價** | ❌ | 依賴 Ledger 促銷（Phase 3） |
| 刪行 / 退貨 | ✅ `voided` + 退菜原因 | 零售叫「退貨」，語義同名即可 |

**關鍵缺口**：`src/lib/pos/discount.ts` **只有百分比**（`discountAmountFromRate`、`discountedUnitPrice`、`discountedItemTotal`、`orderItemDiscountTotal`），**冇定額折、冇改價函式**。零售價格戰最常見就係「$9.9 一件」「減 $5」，純 % 表達唔到。所以 discount.ts 要擴成：

```ts
// 新增（與現有函式並存，保持 % 口徑不變，避免餐飲側回歸）
discountAmountFromFixed(subtotal: number, fixed: number): number
resolveLineUnitPrice(line: CartLine): number   // priceOverride ?? discountedUnitPrice(...)
resolveOrderTotals(lines: CartLine[], rules): RetailTotals
```

**權限**：零售改價 / 大額折扣係**舞弊高風險位**，必須有閘。現有 `UserPermissions` 只有 `voidItem` / `refundOrder`（`src/lib/types.ts:4`），需加 `priceOverride`、`applyDiscount`，並設「折扣率低於 X% 或改價差額超過 Y 元需主管 PIN」閾值。機制可仿 `docs/123` 的 staff PIN 設計。

**既有約束要保留**：折扣金額 > 0 且冇填原因時**阻擋結帳**（`pos-app.tsx:3820` 現行行為）—— 零售照樣沿用，只要把文案由「菜品」改成「商品」。

### R4 — 結帳收款（改動：大，核心）

**現況**

- 結帳核心寫死喺 `pos-app.tsx`：`confirmPayment(method)` → 快餐寫 `paid`、堂食寫 `settled`（`:3837`）；`markOrderCompleted` → `settled`（`:3454`）。
- 找零已有：`cashTendered` / `changeAmount`（`:3861-3862`）。
- 付款方式係**自由文字陣列** `PosRules.paymentMethods: string[]`（`types.ts:180`），預設 `["現金","Mpay","中銀"]`（`mock-data.ts:343`）。
- **拆分付款未實作**：`allowSplitBill` 只喺 `types.ts:176` 宣告、`bootstrap-normalizer.ts:171` 讀入、`mock-data.ts:300` 設 `false` —— **全 repo 冇任何 UI / 邏輯使用**。

**零售需要的設計**

1. **付款方式結構化**：`string[]` → `PaymentMethod[]`

```ts
type PaymentMethod = {
  id: string; label: string;              // 「現金」「MPay」「澳門通」
  kind: "cash" | "card" | "ewallet" | "voucher" | "member_balance";
  requiresTendered?: boolean;             // 現金 → 要收錢、要找零
  openDrawer?: boolean;                   // 現金 → 開錢箱
  integrated?: boolean;                   // 是否接支付終端（Phase 3）
};
```

    ⚠️ 舊 `paymentMethods: string[]` 有存量門店設定，**必須寫 migration / 兼容讀取**，唔可以直接換型別。

2. **拆分 / 混合付款**（零售幾乎必需：現金 + 電子混合）。寫入 `PosOrder.splitPayments: Array<{ methodId; amount; tendered?; change? }>`，並保留現有 `paymentMethod` 作主標籤（相容舊報表）。UI 走「逐筆加、餘額歸零才可完結」。

3. **掛單 / 取單（Hold / Recall）**：零售高頻（客人回頭攞貨、試身期間）。新建 `PosOrder.holdStatus` 或獨立的挂單暫存（本地優先，唔上雲，避免污染營收）。可仿 `quick-mode-orders-bar.tsx` / `quick-local-orders-strip.tsx` 的橫向 strip UI。

4. **收入認列**：**必須沿用 `isSaleCountable(o)`**（只計 `settled` 線下 / 帶 `onlineOrderId` 嘅 `paid`）。零售唔應該另立一套口徑，否則報表口徑分叉。

### R5 — 出票（改動：中）

**現況**：模板以 `storeId` 為鍵落 DB（`print-templates-sync.ts:35 fetchStorePrintTemplates` / `:64 pushStorePrintTemplates`，表 `pos_print_templates`，API `/api/pos/print-templates`）。`ReceiptSectionId` 係固定枚舉，`items` 已有 `price` / `quantity`，小計可以拼出，**但冇條碼行**。

**零售小票要加嘅區塊**

```ts
// 新增到 ReceiptSectionId（types.ts:285）
| "item_barcode"      // 每行品項下方印條碼/SKU（退換貨靠佢）
| "split_payment"     // 拆分付款逐筆明細
| "points_earned"     // 會員積分（Ledger）
| "return_policy"     // 退換貨條款（可自訂長文，收尾）
| "exchange_of"       // 換貨單標示原單號
```

**唔需要嘅**：零售冇廚房單，所以 `printerGroup` 路由（`kitchen` / `label`）在零售場景等同關閉。但**架構唔拆** —— 因為混合業態店（餐飲 + 零售同一店）可能同一台機兩邊走。

**三端一致性（紅線）**：`EscPosTemplateSnapshot`（`types.ts:660`）係自包含快照，模板一改要同步改 **POS 預覽（`receipt-ticket-preview.tsx`）、Companion、APK、print-hub** 四個出紙端嘅 renderer。只改一邊 = 「介面預覽同實紙唔一致」（已有 `docs/70`、`docs/74`、`docs/99` 前科）。

### R6 — 退換貨（改動：中，Phase 2）

- 訂單狀態已備：`partially_refunded` / `refunded`（`types.ts:899`），**唔使新增狀態**。
- 要新增：**行級退貨**（只退部分商品，按 `OrderItem` 標記 + 數量）、**重新入庫**、**換貨單連結原單**（`exchangeOf`）。
- 線上單取消一律走 RPC `merchant_resolve_order_change`（既有硬性口徑），零售若接線上渠道照樣遵守。

---

## 2. 硬體與操作模式評估

### 2.1 方案 A — 無線掃碼槍（HID / 鍵盤 wedge）

| 面向 | 評估 |
| --- | --- |
| 速度 | ★★★★★ 每件 < 0.3 秒，連續掃唔使望螢幕 |
| 準確度 | ★★★★☆ 光學解碼，唔受螢幕反光影響；但**錯掃難察覺** |
| 學習曲線 | ★★★☆☆ 需教「對準 + 等嗶聲」，兼職流動率高時成本明顯 |
| 成本 | ★★★★★ 藍牙槍約 MOP 200–600，最平方案 |
| 整合難度 | ★★★★★ **最低** —— HID 就係鍵盤，唔使 SDK、唔使驅動 |
| 場景限制 | 商品**必須有條碼**；散裝 / 自行分裝貨要自編碼 |
| 主要風險 | 藍牙配對掉線、電量、**焦點被 input 吃掉**、多槍干擾 |

**技術實作要點（HID 輸入層）**

掃碼槍 = 「快速連續打字 + Enter 結尾」。實作係一個全域 hook：

```
keydown 序列 → 緩衝字元
  ├─ 間隔 > 80ms 或遇到 Enter/Tab → 視為一次掃描完成 → 觸發查表
  ├─ 長度 / 字元集校驗（EAN-13 = 13 位數字）→ 過濾人手亂打
  └─ 命中 → addToCart()；未命中 → 響鈴 + toast
```

必需要處理嘅坑：① 焦點（喺搜尋 input 內打字唔可以被當成掃碼 → 用時間閾值區分，唔靠 `document.activeElement`）；② 前綴 / 後綴（好多槍可配置加 `\n`、`\t` 甚至前綴字元，要喺設定頁可調）；③ **誤觸防抖**（人手打字最快 ~150ms/鍵，掃碼槍 ~5-15ms/鍵，閾值 30-50ms 可以乾淨分開）。

### 2.2 方案 B — iPad 觸控為主

| 面向 | 評估 |
| --- | --- |
| 速度 | ★★☆☆☆ 每件 2–5 秒（搜尋 + 點選 + 確認），**多件時係致命瓶頸** |
| 準確度 | ★★★★★ 有圖有名有價，掃錯一眼睇到 |
| 學習曲線 | ★★★★★ 即學即用，零配對問題 |
| 成本 | ★★☆☆☆ 一部堪用 iPad ~MOP 3,000–6,000 |
| 場景限制 | 品項少（< 500）、客單件數少（1–3 件）時體驗最好 |
| 附加價值 | 可轉身畀客人睇價、可做簽名 / 電子確認 |

**適用**：服裝、精品、家居、藥房等「低頻次、高單價、需核對」場景。
**唔適用**：便利店、超市、飲料批發等「高頻次、多件、低單價」場景 —— 逐件點會拖死收銀線。

### 2.3 方案 C — 混合（**建議採用**）

> **iPad 作為主機與操作面，藍牙掃碼槍作為輸入配件。**

分工清晰：

| 動作 | 用邊個 |
| --- | --- |
| 識別商品 | 掃碼槍（快） |
| 無條碼 / 掃唔到 | iPad 觸控搜尋（兜底） |
| 改數量 / 改價 / 折扣 | iPad 觸控（要睇清楚金額，用槍做唔到） |
| 收款 / 找零 / 掛單 | iPad 觸控（大按鈕，符合 ≥40px 觸控規範） |
| 盤點 / 收貨 | 藍牙槍 + 手機（可移動） |

**三個補償設計（關鍵）**：
1. **視覺回饋**：每次掃碼彈一個 1.5 秒的品名 + 價格 toast。呢個係方案 A 最大弱點（錯掃難察覺）的解藥。
2. **聽覺回饋**：成功「嗶」、失敗「錯誤音」。repo 已有 `src/lib/salon/sound.ts` 可借鑑。
3. **快速撤銷**：`Esc` 或 `Delete` 撤銷上一件；`Ctrl+Z` 撤銷最近 5 步。掃錯唔使入購物車慢慢搵。

**分角色部署建議**：尖峰時段兩人（一人專掃、一人專收）都比一人快；單人時就係「槍掃 + 螢幕確認 + 觸控結帳」。

### 2.4 操作模式結論與分期

**建議路線**：架構從第一天就支援 HID 掃碼槍（純前端一個 hook，成本近零），**但 Phase 1 先交付純觸控可用版本**，硬體後補。

理由：掃碼槍輸入層同觸控搜尋共用同一個 `addToCart()` 入口，先做邊個都唔會白做；但如果一開始就等硬體採購，會拖住整個專案。而且**先做觸控可以逼出「搜尋 / 分類 / 常用商品」等兜底能力**，呢啲能力喺掃碼槍壞機、掉線、無條碼商品時必須存在 —— 早做早發現。

---

### 2.5 稱重方案（賣菜 / 生鮮）— 「無線」可行性評估

**先講結論：唔好諗「把秤上數字經藍牙傳入網頁」——業界標準做法係秤自己出一張條碼標籤，POS 當普通條碼掃。**

#### 為何「無線傳重量」在網頁版行唔通

| 技術 | API | iPad Safari | Android Chrome | 桌面 Chrome | 判斷 |
| --- | --- | --- | --- | --- | --- |
| Web Bluetooth（BLE GATT） | `navigator.bluetooth` | ❌ **完全不支援** | ✅ | ✅ | 只可作 Android／桌面備選 |
| Web Serial（RS232／串口秤） | `navigator.serial` | ❌ | 🟡 部分 | ✅ | 同上 |
| WebHID | `navigator.hid` | ❌ | ✅ | ✅ | 同上 |
| USB HID 秤（模擬鍵盤） | `keydown` | ✅（要有線／OTG） | ✅ | ✅ | 可行，但唔係無線 |
| Bluefy / WebBLE 第三方瀏覽器 | 自帶藍牙棧 | ✅ | — | — | 要另裝 App、脫離 PWA，唔建議作主線 |

⚠️ **關鍵限制**：Apple 由 App Store 規則強制**所有 iOS／iPadOS 瀏覽器使用 WebKit 內核** → 連 iOS 版 Chrome／Edge 都一樣冇 Web Bluetooth。所以「靠瀏覽器直接連藍牙」呢條路在 iPad 上**永遠不成立**。要無線，一定要有個 native 進程做中間人。

#### 四層方案（由最實用到兜底）

#### W1（首選）：條碼標籤秤 / Price-embedded EAN-13

秤自己印一張不乾膠標籤，條碼內容就係 PLU + 重量或金額。POS 只當普通條碼掃 → **零整合、零驅動、iPad 直接可用**。

```
2   01234   00350   X
│   │       │       └─ 校驗位（自動計算）
│   │       └───────── 重量(克) 或 金額(分)，5 位
│   └───────────────── PLU / 商品碼，5 位（＝我們商品的 plu）
└───────────────────── 前綴 20-29 = 店內變重碼；21 = 重量碼、22 = 金額碼
```

- **重量碼**例：`21 01234 00350 X` → PLU=01234、淨重 350g → POS 用「單位價 × 0.35kg」算錢
- **金額碼**例：`02 00123 01234 C` → PLU=00123、總額 $12.34 → POS 直接取金額（唔使再乘）
- ⚠️ **各品牌出廠規則唔同**（前綴用 `2` 還是 `02`、重量用克還是公斤、有冇校驗位、位數如何分配）→ **必須做成可配置**，這正是 §2.6「型號配對」要處理嘅同一類問題
- 常見品牌：大華、頂尖、寺岡 DIGI、CAS、Mettler-Toledo（托利多）

#### W2（要無線即時讀數）：經 Companion 代理做藍牙秤

本專案**已有 Companion 代理架構**（`src/lib/print-bridge/companion.ts`）—— 佢係一個 Node／native 進程，自己做 BLE 與 serialport，瀏覽器只係用 local HTTP 問佢。**藍牙由 Companion 做，唔係瀏覽器做 → 完全繞開 Safari 限制，iPad 照用。**

- 新增 `/api/scale` 端點：Companion 訂閱 BLE GATT（或讀 serialport），把讀數 push 返網頁
- ✅ 真正「無線」、iPad 可用；✅ 架構先例已存在（`/api/usb`、`/api/bluetooth`、`/api/discover` 都係同一模式）
- ⚠️ 成本高一個量級：**每個秤型號都要做 GATT profile 適配**（service / characteristic UUID 各廠唔同）
- 適用：**收銀台現場稱重**（散裝糖果、水果區），秤同 POS 同一台機

#### W3：USB HID 秤（有線但零驅動）

秤模擬鍵盤輸出重量字串（同掃碼槍一模一樣）→ **現有 HID 輸入層直接收到，零整合**。
- ✅ 最簡單嘅「即時讀數」方案；✅ 桌面／Android OTG 可用
- ❌ 唔係無線；iPad 直插要轉接頭，供電可能不足

#### W4（永遠要有嘅兜底）：手動輸入重量

觸控數字鍵盤輸入重量（reuse `numeric-keypad.tsx` / `fixed-number-pad.tsx`），即時顯示「單價 × 重量 = 金額」。
- 秤壞、標籤爛、客人自備容器、臨時散賣 → 都要行得通
- **唔可以省略** —— 同「狀態唔准靜默」係同一個原則

#### 建議組合

| 場景 | 建議方案 |
| --- | --- |
| 賣菜／生鮮：客人自揀、秤完貼標籤去收銀 | **W1 條碼標籤秤**（一台秤幾百至千餘 MOP，零整合，最穩） |
| 收銀台現場稱重（散裝糖果、水果） | Phase 3 做 **W2 Companion 藍牙秤**；或先用 **W3 USB HID 秤** |
| 任何情況 | **W4 手動輸入**，永遠保留 |

⚠️ **W1 配套注意**：秤端商品庫同 POS 商品庫要用**同一套 PLU**，並**禁止秤端隨意改價**，否則「秤上價 ≠ POS 價」→ 收銀爭議。建議做「PLU 同步」：由 POS 導出 PLU／品名／單價 CSV → 匯入秤端。

---

### 2.6 掃碼槍型號配對（照打印機做法）

打印機匹配之所以做得到，係因為 Companion 用 node-usb 讀到 **VID/PID**（`companion.ts:553 enumerateCompanionUsbPrinters`），再對照 `USB_PRINTER_DB`（`printer-models.ts:35`）得出品牌／編碼／紙張。**掃碼槍要分兩種情形處理**：

| 情形 | 可以拎到乜 | 配對方式 |
| --- | --- | --- |
| 經 Companion／Android 原生代理（USB 或有線） | **VID/PID + 產品名** | ✅ **真型號配對**，同打印機一模一樣：新增 `SCANNER_DB`（VID/PID → 品牌 / 預設前綴後綴 / 結尾符） |
| 純瀏覽器（HID 或藍牙鍵盤） | **乜都拎唔到**（瀏覽器冇 USB descriptor API） | ⚠️ 只能**自動學習**：量度實際輸入特徵反推配置 |

#### 自動學習嚮導（「support 大部份型號」嘅關鍵）

用戶在設定頁按「開始識別」，然後**掃同一個條碼 3 次**，系統量度：

| 量度項 | 推斷出嘅配置 |
| --- | --- |
| keydown 間隔中位數 | 區分掃碼（5–15ms／鍵）vs 人手打字（~150ms／鍵）→ 定出超時閾值 |
| 結尾字元 | 有 `Enter`／`Tab`／完全冇（靠超時收尾） |
| 開頭有無固定字元 | 前綴（部分型號出廠加 `~`、`%`、`#`） |
| 字元集與長度 | 純數字／字母數字、固定 13 位（EAN-13）抑或變長 |
| 3 次結果是否一致 | 一致性驗證，避免學到雜訊 |

學到之後寫入 `ScannerProfile`（存 local settings —— ⚠️ **記得同步 `normalizePosLocalSettings` 白名單**），並提供「測試框」即時顯示解析結果。

#### 型號庫 + 三層結構（同打印機完全同構）

`SCANNER_DB` 覆蓋主流品牌（Honeywell、Zebra、Datalogic、Newland、民德 MINDEO、優庫 UROVO、商米 Sunmi 等）嘅**出廠預設前綴後綴**，命中就一鍵套用；唔命中就走自動學習。可直接 reuse 打印機側嘅設計慣例：

- **純函式 resolver**（可 `node --test` 單測、零 runtime 依賴）—— 仿 `resolveUsbMeta()`
- **型號選項產生器**（俾 UI 下拉用）—— 仿 `getLanModelOptions()`
- **命中／未命中分級**：命中型號 → 精確配置；只認得品牌 → 品牌預設並標示 `generic: true`；全唔認得 → 自動學習 —— 仿 `ResolvedUsbMeta.generic`

---



## 3. 介面改動需求

### 3.1 新增畫面

| # | 畫面 | 內容 | 優先 |
| --- | --- | --- | --- |
| I-1 | `/retail` 零售收銀台 | 三欄：左「商品識別」（搜尋 + 分類 + 常用 + 最近）、中「購物車」（行項 + 數量 + 折扣）、右「結帳總額」 | **P0** |
| I-2 | 結帳彈窗 | 大按鈕付款方式、現金找零、拆分付款、會員扣款 | **P0** |
| I-3 | 掛單列 strip | 橫向卡片列，顯示已掛單號 / 件數 / 金額 | P1 |
| I-4 | 退換貨面板 | 原單查詢、行級勾選退貨、換貨關聯 | P1 |
| I-5 | 商品管理（擴現有） | 加 SKU / 條碼 / 單位 / 稅碼 / 稱重開關 / 庫存追蹤 | **P0** |
| I-6 | 條碼標籤列印 | 由商品 → 產標籤（已有 `label` 模板類型可用） | P1 |
| I-7 | 零售報表 | 毛利、動銷排行、庫存周轉、現金長短 | P1 |
| I-8 | 掃碼槍設定頁 | 型號列表 + 自動學習嚮導 + 測試框（見 §2.6） | **P0**（自動學習）／P2（型號庫） |
| I-9 | **稱重輸入面板** | 重量輸入（觸控鍵盤）+ 單位價即時算金額 + 「皮重」預設；供 W4 兜底用 | **P0** |
| I-10 | **變體選擇器** | 商品有變體時彈出顏色 × 尺碼矩陣，選中才入車（服裝） | P1 |
| I-11 | **序號登記** | 售出時掃／輸入 IMEI 綁定到購物車行；退貨時反查 | P1 |
| I-12 | **商品批量匯入** | CSV 上傳 → 欄位對照 → 預覽差異 → 確認寫入（含 SKU / 條碼 / 變體 / 單位） | **P0** |
| I-13 | **變重條碼規則設定** | 前綴區間 / PLU 起止位 / 重量或金額 / 倍率 / 校驗位（見 §2.5 W1） | P1 |

### 3.2 現有畫面調整

| 位置 | 調整 | 優先 |
| --- | --- | --- |
| `app-sidebar.tsx:27 baseNavItems` | 依 `industry="retail"` 顯示零售導航（收銀 / 商品 / 庫存 / 報表 / 交班 / 打印） | **P0** |
| `src/app/page.tsx` | 按 `industry` 分派：餐飲 → `PosApp`、零售 → redirect `/retail` | **P0** |
| `types.ts:23 AccountStore.industry` | 加 `"retail"`，同步 `industry-config.ts` 的 `setTerminalIndustry` | **P0** |
| `device-settings.tsx` | 菜單編輯 → 加 SKU / 條碼欄位（:150 `menuDraft.menuItems`） | **P0** |
| `print-center.tsx` | 新增零售預設模板（含條碼行、拆分付款行） | P1 |
| `soldout-page.tsx` | 沽清語義對零售 = 「缺貨停售」，文案要微調 | P2 |

### 3.3 快捷鍵（零售收銀員靠鍵盤比屏幕快）

| 鍵 | 動作 |
| --- | --- |
| `F1` | 聚焦搜尋 |
| `F2` | 改數量 |
| `F3` | 折扣 / 改價（需權限） |
| `F8` / `F9` | 掛單 / 取單 |
| `F10` | 結帳 |
| `Esc` / `Delete` | 撤銷上一件 |
| `Ctrl+Z` | 撤銷最近 5 步 |
| `Enter` | 確認（掃碼槍結尾亦為 `Enter`，需區分） |

### 3.4 風格一致性約束（硬性）

- **必須沿用**現有元件：`numeric-keypad.tsx`、`fixed-number-pad.tsx`、`input-pad-modal.tsx`、`responsive-modal.tsx`、`icons.tsx`、`order-source-badge.tsx`。
- **觸控規範**：點擊目標 ≥ 40px、內容完整可見、無文字截斷、響應式多尺寸（`docs/69-touch-ux-audit.md`、`docs/73`）。
- **狀態絕不靜默**：任何操作失敗要有 toast（沿用快餐側既有口徑）。
- 色系 / 圓角 / 密度沿用 Tailwind 4 現有 token，**唔另立零售設計語言** —— 統一入口的價值在於「同一套肌肉記憶」。

---

## 4. 可重用部分盤點

### 4.1 🟢 直接重用（零改動或僅接線）

| 模組 | 路徑 | 說明 |
| --- | --- | --- |
| 離線 outbox | `src/lib/pos/queue-outbox.ts` | `coalesceKey` / `enqueueEvents` / `classifyQueueEvent` / `gcSyncQueue`，store-scoped |
| 同步主流程 | `src/lib/pos/sync-flush.ts` | `doFlush` → `POST /api/pos/sync`；`:290 resolveStoreId()` 唯一真源 |
| 對帳修復 | `src/lib/pos/sync-reconcile.ts`、`sync-reconcile-daemon.ts` | 終態分叉補推 `ORDER_UPDATED` |
| 即時訂閱 | `src/lib/pos/use-pos-realtime.ts` | 訂 `pos_orders` / `pos_print_jobs` / `pos_soldout`，`store_id=eq.<storeId>` |
| 列印 job 合併 | `src/lib/pos/print-job-merge.ts` | 同 id 保留本地派發狀態 |
| 模板落庫同步 | `src/lib/print-templates-sync.ts` | 以 `storeId` 為鍵的 DB 持久化 |
| 出票預覽引擎 | `src/components/receipt-ticket-preview.tsx` | 真實 order + 模板走 `renderEscPosLines` |
| 會員 / Ledger | `src/lib/ledger/*` | `checkout-member`、`ensure-customer`、`rewards`、`member-list` |
| 報表期間口徑 | `src/lib/ledger/report-period.ts` | Macau 日期邊界 ISO，**零售報表照用，唔另立** |
| 收入認列 | `isSaleCountable(o)` | 只計 `settled` 線下 / 帶 `onlineOrderId` 的 `paid` |
| 交班 | `src/app/shift/page.tsx`、`src/lib/shift-sync.ts` | — |
| 沽清 | `src/lib/pos/soldout.ts`、`soldout-page.tsx` | 語義 = 缺貨停售，零售可用 |
| 認證 / 守衛 | `auth-guard.tsx`、`app-error-boundary.tsx`、`use-network-online.ts` | — |
| 觸控輸入元件 | `numeric-keypad`、`fixed-number-pad`、`input-pad-modal`、`responsive-modal` | — |
| 音效 | `src/lib/salon/sound.ts` | 掃碼成功 / 失敗提示音 |

### 4.2 🟡 需擴充（改型別 / 加函式）

| 目標 | 現況 | 擴充內容 |
| --- | --- | --- |
| `src/lib/kiosk-cart.ts` | `CartLine` 無 sku/barcode/改價/定額折 | 見 §R2 型別；`lineSignature` 納入折扣與改價；新增 `nonMergeable` |
| `src/lib/pos/discount.ts` | 只有百分比 | 加 `discountAmountFromFixed`、改價解析、`resolveOrderTotals` |
| `src/lib/types.ts:113 MenuItem` | 無 sku / barcode / unit / taxCode / isWeighed / trackStock | 逐欄加，**並同步 `normalizePosLocalSettings` 白名單** |
| `src/lib/types.ts:856 OrderItem` | 無 sku / barcode / originalUnitPrice / 定額折 / weight | 同上 |
| `src/lib/types.ts:890 PosOrder` | 無 `splitPayments` / `pointsEarned` / `exchangeOf` / 掛單 | 同上 |
| `src/lib/types.ts:285 ReceiptSectionId` | 無條碼 / 拆分付款 / 積分 / 退換條款 | 加 5 個區塊，**四端 renderer 同步** |
| `src/lib/types.ts:180 PosRules.paymentMethods` | `string[]` | → `PaymentMethod[]`，**必寫 migration 兼容舊設定** |
| `src/lib/types.ts:176 allowSplitBill` | 已宣告但**全 repo 未實作** | 補實作（或直接由 `splitPayments` 取代） |
| `src/lib/types.ts:23 AccountStore.industry` | 只有 `restaurant` / `salon` | 加 `"retail"` |
| `src/lib/types.ts:4 UserPermissions` | 只有 `voidItem` / `refundOrder` | 加 `priceOverride` / `applyDiscount` / `returnOrder` |
| `src/components/device-settings.tsx` | 菜單欄位無 SKU / 條碼 | 加欄位 + 掃碼槍輸入支援 |
| `src/components/print-center.tsx` | 無零售模板 | 加零售預設模板 |
| 庫存 | `inventory-products.ts` 的 `InvProduct` 無 sku/barcode；`inventory/page.tsx` 實為**進貨成本 OCR 追蹤**，非可售庫存 | 需擴為「可售 SKU 庫存 + 銷售扣減」 |

### 4.3 🔴 需新建

| 模組 | 建議路徑 | 說明 |
| --- | --- | --- |
| 掃碼輸入層 | `src/lib/retail/use-barcode-scanner.ts` | 全域 `keydown` 緩衝 + 超時收尾 + 誤觸過濾 |
| 條碼索引 | `src/lib/retail/barcode-index.ts` | 純函式，可單測（零 runtime 依賴） |
| 零售購物車 hook | `src/lib/retail/use-retail-cart.ts` | 包 `kiosk-cart.ts` 純函式 + 本地持久化 |
| 零售收銀台 | `src/app/retail/page.tsx` + `src/components/retail/checkout-counter.tsx` | — |
| 零售側欄 | `src/components/retail/retail-sidebar.tsx` | 仿 `salon/salon-sidebar.tsx` |
| 掛單 / 取單 | `src/lib/retail/hold-orders.ts` | 本地優先，唔上雲 |
| 拆分付款 | `src/lib/retail/split-payment.ts` | 純函式（餘額計算可單測） |
| 條碼標籤列印 | 擴 `label` 模板 | — |
| 零售報表 | `src/app/retail/reports/page.tsx` | 毛利 / 動銷 / 周轉 |

---

## 5. 分期路線圖

### Phase 0 — 地基（必須先行，其他全部依賴）

> 📋 **詳細實作清單（型別 diff + 逐檔清單）見 §8。**

- [ ] `RetailProduct` / `RetailVariant` / `OrderItem` / `PosOrder` 加零售欄位，**同步 `normalizePosLocalSettings` 白名單**
- [ ] `PaymentMethod` 結構化 + `normalizePaymentMethods()` 兼容讀舊 `string[]`
- [ ] `AccountStore.industry` 加 `"retail"` + `/retail` 路由骨架 + 側欄
- [ ] `barcode-index.ts` + `weighed-barcode.ts` + `scanner-profiles.ts`（全部純函式 + 單測）
- [ ] `use-barcode-scanner.ts` 輸入層 + **自動學習嚮導**
- [ ] `device-settings.tsx` 商品編輯加 SKU／多條碼／PLU／單位／稱重／序號／變體
- [ ] **CSV 批量匯入**（含欄位對照與差異預覽）

**出口標準**：可以喺設定頁為一件商品填條碼 + 批量匯入；掃碼槍掃到 → console 出正確商品；
掃變重條碼 → 正確解析 PLU + 重量。**此時畫面仲未做**。

### Phase 1 — 零售收銀 MVP（可交付營運）

- [ ] `/retail` 三欄收銀台（觸控搜尋 + 分類 + 最近 / 常用）
- [ ] 購物車行操作：數量、刪行、單品 % 折、**定額折、改價**、**稱重行**
- [ ] **變體選擇器**（顏色 × 尺碼）+ **序號登記**
- [ ] 折扣 / 改價權限閘（staff PIN）+ `unitPriceOriginal` 審計
- [ ] 結帳：現金（找零）+ 單一電子付款
- [ ] 小票出紙（**含條碼行**）+ 模板落庫
- [ ] **即時扣庫存 + 低庫存告警**（D3）
- [ ] 掛單 / 取單、快捷鍵

**出口標準**：一筆現金零售單可以由掃碼 → 結帳 → 扣庫存 → 出紙，離線斷網亦不丟單。

### Phase 2 — 完整零售能力

- [ ] 拆分付款（現金 + 電子混合）
- [ ] 退換貨（行級 + 重新入庫 + 換貨關聯 + 序號反查）
- [ ] 會員 / 積分（Ledger）
- [ ] 條碼標籤列印（貨架價籤 / 吊牌）
- [ ] 年齡限制商品確認（便利店煙酒）
- [ ] 零售報表（毛利 / 動銷 / 周轉 / 現金長短）
- [ ] 開錢箱
- [ ] **變重條碼規則設定頁**（配合 W1 條碼標籤秤）

### Phase 3 — 進階

- [ ] **藥房**：批次 / 效期追蹤（先到期先出）、受管制藥物登記
- [ ] 藍牙秤（W2，經 Companion 代理 `/api/scale`）或 USB HID 秤（W3）
- [ ] 秤端 PLU 同步（POS 導出 → 秤匯入）
- [ ] 支付終端整合（`PaymentMethod.integrated`）
- [ ] 多店價格策略 / 促銷引擎 / 優惠券

---

## 6. 紅線與實作注意（沿用 `docs/113`）

> 以下每一條都係本專案**已經踩過**嘅坑，零售版照樣會中招。

| # | 紅線 | 後果 |
| --- | --- | --- |
| 1 | `normalizePosLocalSettings` 係**白名單重建** | 加欄唔同步白名單 → 新設定**靜靜被剷走** |
| 2 | 建單 / 接單後必須 `appendPrintJobsWithSync()`；`RelayTransport.send()` 係 no-op | 淨用 `savePrintJobs()` = **零出紙 + 零紅標** |
| 3 | 出紙「改咗代碼但行為不變」 | = 出紙程式冇 rebuild / 冇擰 `versionCode`（**4 份**：print-relay APK、print hub、print-agent-android、desktop-companion） |
| 4 | 收入認列只認 `isSaleCountable(o)` | 零售另立口徑 → 報表分叉 |
| 5 | store 隔離 strict `o.storeId === merchantId` | 缺失一律唔拉；零售多店要特別驗 |
| 6 | LWW 只可用 `mergeTimestamp()` | 用 `orderTimestamp()` → 已結帳狀態閃回 |
| 7 | 日期一律 Macau 邊界 ISO（`report-period.ts`） | 跨日營業額算錯 |
| 8 | 雲端讀到 = 唯一可信源；雲端空 + 成功 = 空狀態，**唔 fallback 本機** | 本機舊資料復活 |
| 9 | 報表 KPI 固定 `grid-cols-5`；合併 grid 必須刪中間 `</div>` | JSX 仍平衡 → `next build` **捉唔到** |
| 10 | 快餐 `paid` / `ready` 係**單向閘** | 若零售借用快餐流程，會被舊 snapshot 降級 |
| 11 | 測試：`node --test` **無參數**；import 用相對路徑 + `.ts`（`@/` 會 ERR_MODULE_NOT_FOUND）；utility 模組唔好用 `test-` 前綴；**純模組必須零 runtime 依賴** | 測試跑唔起 |
| 12 | `next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 且**喺沙箱外**跑 | build 失敗 |
| 13 | `git` 一律 `CODEBUDDY_SAFE_DELETE_ENABLED=0 git …` | 倉庫受損 |

**零售特有風險**：

- **改價 / 折扣舞弊**：必須有 PIN 閘 + 折扣原因強制填寫 + 審計記錄（`discountNote` 機制已有，擴到改價）。
- **購物車合併簽名**：折扣 / 改價未納入 `lineSignature` → 帳目錯（見 §R2）。
- **掃碼槍焦點衝突**：全域 keydown 會同搜尋輸入框搶輸入，必須用時間閾值區分，唔可以靠 `activeElement`。
- **舊 `paymentMethods: string[]` 兼容**：直接換型別會令存量門店付款方式消失。

---

## 7. 決策定案（2026-09-12 商家拍板）

| # | 問題 | 商家決定 | 架構含義 |
| --- | --- | --- | --- |
| D1 | 零售業態 | **主力：便利店 + 藥房**；賣菜要**稱重**；**序號（IMEI）同變體（顏色 × 尺碼）都要有** | 商品模型要同時支援「變體矩陣」「序號追蹤」「稱重」三種形態 → 見 §8.1 |
| D2 | 混合業態同機？ | **唔係。零售就係零售。** | `/retail` 完全獨立分支，**唔需要模式切換器**，登入即入 |
| D3 | 庫存 | **要即時扣減** | 庫存由「進貨成本追蹤」升級為「可售 SKU 庫存 + 銷售扣減」→ 拉到 Phase 1 |
| D4 | 條碼 | **都有，要批量匯入** | Phase 0 要做 CSV 匯入 + 條碼欄位（含多條碼） |
| D5 | 掃碼槍 | **冇現成，要支援大部分型號** | 型號庫 + 自動學習嚮導 → §2.6 |
| D6 | 稱重 | 要，但擔心網頁版限制 | **用條碼標籤秤（W1）繞開**，唔靠藍牙 → §2.5 |

### 7.1 由決定衍生嘅需求（要寫入商品模型）

| 來源 | 衍生需求 | 落點 |
| --- | --- | --- |
| 便利店 | **年齡限制商品**（煙、酒）→ 掃到即彈年齡確認 | `RetailProduct.minAge` |
| 藥房 | **受管制藥物登記**（處方藥／簿冊） | `RetailProduct.requiresRecord` + 售出登記（Phase 2） |
| 藥房 | **批次 / 效期追蹤**（先到期先出） | `batchNo` / `expiryDate`（Phase 2，模型先預留位） |
| 服裝 | **變體 = 顏色 × 尺碼**，每個組合有獨立條碼／庫存 | `RetailProduct.variants[]` |
| 電器 / 手機 | **序號（IMEI）售出時綁定**，退貨反查 | `OrderItem.serialNo` + `RetailProduct.isSerialized` |
| 賣菜 | **稱重**（PLU + 重量／金額） | `RetailProduct.plu` / `isWeighed` + `WeighedBarcodeRule` |
| 全部 | **即時扣庫存** | `RetailProduct.stockQty` / `trackStock` + 售出扣減 |

### 7.2 商品模型嘅三層結構（結論）

```
SPU（RetailProduct）— 「純棉圓領T恤」
  └── Variant（顏色 × 尺碼）— 「黑 / L」，各自有 barcode + sku + stockQty
        └── Serial（序號 / IMEI）— 只有 isSerialized=true 才需要，售出時綁定到訂單行
```

**稱重商品唔行變體**（`isWeighed=true` 直接掛 PLU），因為秤端只認 PLU。

---

## 8. Phase 0 實作清單（資料層地基）

> 出口標準見 §8.4。**Phase 0 唔做任何收銀畫面** —— 只交付「型別 + 純函式 + 設定頁欄位 + 掃碼解析」，令 Phase 1 可以純粹做 UI。

### 8.1 型別擴充（全部集中喺 `src/lib/types.ts`）

**新建 `RetailProduct`（建議新開型別，唔改 `MenuItem`，避免影響餐飲側）**

```ts
export interface RetailProduct {
  id: string;
  storeId?: string;
  name: string;                 // SPU 名：「純棉圓領T恤」
  categoryId: string;
  barcode?: string;             // 主條碼（EAN-13 / UPC）；有變體時可空
  extraBarcodes?: string[];     // 一商品可多條碼（廠碼 + 自編碼 + 舊包裝碼）
  plu?: string;                 // 店內 PLU（條碼秤 / 手動輸入用；稱重商品必填，5 位）
  sku?: string;
  price: number;                // 售價（MOP）
  originalPrice?: number;
  cost?: number;                // 成本（毛利報表）
  unit: string;                 // 件 / kg / 包 / 盒
  taxCode?: string;
  trackStock: boolean;          // 是否扣庫存（D3=要）
  stockQty?: number;
  reorderLevel?: number;
  isWeighed?: boolean;          // 稱重商品（賣菜）
  isSerialized?: boolean;       // 序號商品（IMEI）
  minAge?: number;              // 年齡限制（煙酒）
  requiresRecord?: boolean;     // 藥房：受管制 / 需登記
  variants?: RetailVariant[];   // 有值 = 本體係 SPU，唔可直接賣
  image?: string;
  isActive?: boolean;
}

export interface RetailVariant {
  id: string;
  label: string;                        // 顯示用：「黑 / L」
  attributes: Record<string, string>;   // { 顏色: "黑", 尺碼: "L" }
  barcode?: string;
  sku?: string;
  price?: number;                       // 缺省繼承 SPU
  stockQty?: number;
}
```

**`OrderItem` 追加（餐飲留空即完全不受影響）**

```ts
sku?: string;
barcode?: string;             // 實際掃入嘅條碼（出票要印，退換貨靠佢）
plu?: string;
variantId?: string;
variantLabel?: string;        // 「黑 / L」
serialNo?: string;            // 序號 / IMEI
weight?: number;              // 稱重商品淨重（kg）
unitPriceOriginal?: number;   // 🔴 改價前單價 —— 舞弊審計必需
```

**`PosOrder` 追加**

```ts
splitPayments?: Array<{
  methodId: string; label: string; amount: number;
  tendered?: number; change?: number;
}>;
pointsEarned?: number;
pointsBalanceAfter?: number;
exchangeOf?: string;          // 換貨單 → 原單 id
serialNos?: string[];         // 便於查詢
```

**`ReceiptSectionId` 追加 5 個區塊**（⚠️ 四端 renderer 要同步，見 §6 紅線 3）

```ts
| "item_barcode"      // 每行品項下方印條碼 / SKU
| "split_payment"     // 拆分付款逐筆明細
| "points_earned"     // 會員積分
| "return_policy"     // 退換貨條款
| "exchange_of"       // 換貨單標示原單號
```

**付款方式結構化（⚠️ 必寫兼容）**

```ts
export interface PaymentMethod {
  id: string;
  label: string;                                      // 「現金」「MPay」「澳門通」
  kind: "cash" | "card" | "ewallet" | "voucher" | "member_balance" | "other";
  requiresTendered?: boolean;                         // 現金 → 收錢、找零
  openDrawer?: boolean;                               // 現金 → 開錢箱
  integrated?: boolean;                               // 是否接支付終端（Phase 3）
}

// PosRules.paymentMethods 由 string[] 改為 Array<string | PaymentMethod>
// 並新增純函式正規化（舊存量的 string 自動轉 { kind: "other" }）
export function normalizePaymentMethods(raw: unknown): PaymentMethod[]
```

**掃碼槍 / 稱重規則（新設定型別）**

```ts
export interface ScannerProfile {
  id: string;
  name: string;
  prefix?: string;                    // 出廠前綴（部分型號有 ~ % #）
  suffix?: "enter" | "tab" | "none";
  timeoutMs: number;                  // 預設 50（掃碼 5-15ms/鍵 vs 人手 ~150ms）
  minLength?: number;
  maxLength?: number;
  charset?: "digits" | "alnum";
  source: "model-db" | "auto-learn" | "manual";
}

export interface WeighedBarcodeRule {
  prefixes: string[];                 // ["21","22","20"] 或 ["2"]
  pluStart: number;
  pluLength: number;
  payloadLength: number;
  payloadKind: "weight_g" | "weight_kg" | "price_cents" | "price";
  divisor: number;                    // 1000 / 100 / 1
  hasCheckDigit: boolean;
}
```

**業態與權限**

```ts
// AccountStore.industry
industry?: "restaurant" | "salon" | "retail";

// UserPermissions 追加
priceOverride?: boolean;
applyDiscount?: boolean;
returnOrder?: boolean;
```

**`CartLine` 擴充** → 見 §R2（加 `sku`/`barcode`/`plu`/`unit`/`weight`/`priceOverride`/`lineDiscountRate`/`lineDiscountAmount`/`variantId`/`serialNo`/`nonMergeable`）

⚠️ **加任何欄位都要同步 `normalizePosLocalSettings` 白名單**（`bootstrap-normalizer.ts`）—— 呢個係白名單重建，唔加就**靜靜剷走**（§6 紅線 1）。

### 8.2 新增檔案（全部純函式先行，可 `node --test`）

| 檔案 | 內容 | 性質 |
| --- | --- | --- |
| `src/lib/retail/barcode-index.ts` | `buildBarcodeIndex(products)`、`resolveScannedCode(raw, profile, weighedRule)` → `ScannedHit` | 🟢 純函式 |
| `src/lib/retail/barcode-index.test.ts` | 索引、多條碼、變體條碼、變重碼分派 | — |
| `src/lib/retail/scanner-profiles.ts` | `SCANNER_DB`（VID/PID → 品牌／前綴後綴）、`resolveScannerMeta()`、`getScannerModelOptions()`、**`learnProfile(samples)`** | 🟢 純函式，仿 `printer-models.ts` |
| `src/lib/retail/scanner-profiles.test.ts` | 🔴 **自動學習演算法單測（最重要）** | — |
| `src/lib/retail/weighed-barcode.ts` | `parseWeighedBarcode(code, rule)` → `{ plu, weight?, price? }` | 🟢 純函式 |
| `src/lib/retail/weighed-barcode.test.ts` | 各品牌規則（`2` vs `02`、克 vs 千克、有無校驗位） | — |
| `src/lib/retail/retail-cart.ts` | 包 `kiosk-cart.ts` 純函式 + 零售專屬（改價、稱重行、變體行） | 🟢 純函式 |
| `src/lib/retail/split-payment.ts` | 拆分付款餘額計算、找零 | 🟢 純函式 |
| `src/lib/retail/stock.ts` | 售出扣減、退貨回補、低庫存判斷 | 🟢 純函式 |
| `src/lib/retail/hold-orders.ts` | 掛單 / 取單（本地優先，唔上雲） | 純函式 + storage |
| `src/lib/retail/csv-import.ts` | CSV 解析 + 欄位對照 + 差異預覽（**手寫 parser，唔加外部依賴**） | 🟢 純函式 |
| `src/lib/retail/use-barcode-scanner.ts` | 全域 `keydown` 緩衝 hook（由 `ScannerProfile` 參數化） | React hook |
| `src/lib/retail/use-retail-cart.ts` | 購物車 hook + localStorage 持久化 | React hook |
| `src/components/retail/retail-sidebar.tsx` | 零售側欄（仿 `salon/salon-sidebar.tsx`） | UI |
| `src/components/retail/checkout-counter.tsx` | 三欄收銀台 | UI |
| `src/components/retail/weight-pad.tsx` | 稱重輸入面板（W4 兜底） | UI |
| `src/components/retail/variant-picker.tsx` | 顏色 × 尺碼矩陣 | UI |
| `src/components/retail/scanner-settings.tsx` | 型號庫 + 自動學習嚮導 + 測試框 | UI |
| `src/app/retail/page.tsx`（+ `layout.tsx`） | 路由骨架 | — |

### 8.3 要改嘅現有檔案

| 檔案 | 改動 | 風險 |
| --- | --- | --- |
| `src/lib/types.ts` | §8.1 全部 | 溫和 |
| `src/lib/kiosk-cart.ts` | `CartLine` 擴欄、`lineSignature` 納入折扣／改價、`nonMergeable` | 🔴 **餐飲側共用** → 改完必跑全測試 |
| `src/lib/pos/discount.ts` | 加定額折 + 改價解析（保留 % 函式原樣） | 溫和 |
| `src/lib/bootstrap-normalizer.ts` | `normalizePosLocalSettings` 白名單加 `scannerProfiles` / `weighedBarcodeRules` / `retailSettings` / `paymentMethods` 新格式 | 🔴 唔加就靜靜剷走 |
| `src/lib/pos/pos-order-mapper.ts` **＋** `src/lib/pos-order-row.ts` | 帶出新欄位（`splitPayments` / `serialNos` / `weight`） | 🔴 **兩個 mapper 都要改**（一個服務 `/api/pos/state`、一個服務 realtime） |
| `src/app/api/pos/sync/route.ts` | 新欄位寫入 | 溫和 |
| `src/components/device-settings.tsx` | 商品編輯加 SKU／條碼／額外條碼／PLU／單位／稱重／序號／變體 | 中 |
| `src/components/app-sidebar.tsx` | 依 `industry` 條件渲染導航 | 溫和 |
| `src/app/page.tsx` | `industry="retail"` → redirect `/retail` | 溫和 |
| `src/lib/print-templates-sync.ts` + 四端 renderer | 新增 5 個收據區塊 | 🔴 四端要同步、要擰 `versionCode` |

### 8.4 Phase 0 出口標準

1. 設定頁可為商品填 SKU + 主條碼 + **多條碼** + PLU + 單位 + 稱重／序號／變體開關
2. **批量匯入 CSV** 跑得通（含欄位對照與差異預覽）
3. **掃碼槍自動學習嚮導**跑得通：掃同一條碼 3 次 → 學出 profile → 測試框顯示正確解析
4. 掃一件真實商品條碼 → console 出正確商品（**此時畫面未做**）
5. 掃一個變重條碼（例 `21 01234 00350 5`）→ 正確解析出 PLU + 350g
6. 所有新純函式都有 `node --test` 單測；`npm run typecheck` + `npm run test` 全綠
7. **餐飲側零回歸**（`kiosk-cart.ts` 改動唔影響現有 199 個測試）


---

## 附錄 A — 關鍵代碼事實（供實作時直接查）

| 事實 | 位置 |
| --- | --- |
| 純函式購物車（**最值錢的可重用資產**） | `src/lib/kiosk-cart.ts:13,28,40,50,73` + `kiosk-cart.test.ts` |
| 訂單型別真源 | `src/lib/types.ts:856`（`OrderItem`）、`:890`（`PosOrder`） |
| 訂單狀態 8 值 | `types.ts:899` `draft \| sent_to_kitchen \| paid \| settled \| reopened \| cancelled \| partially_refunded \| refunded` |
| 商品型別（**無條碼**） | `src/lib/types.ts:113`（`MenuItem`）、`ledger/menu.ts:20`、`inventory-products.ts:5` |
| 收據區塊枚舉（**無條碼行**） | `src/lib/types.ts:285-334` |
| 折扣（**只支援百分比**） | `src/lib/pos/discount.ts:14,20,26,31,43` |
| 結帳核心 | `src/components/pos-app.tsx:3796`（`confirmPayment`）`:3837`（寫狀態）`:3454`（`markOrderCompleted`）`:3861-3862`（找零） |
| 折扣必填原因 | `pos-app.tsx:3820` |
| 拆分付款未實作 | `types.ts:176`、`bootstrap-normalizer.ts:171`、`mock-data.ts:300` |
| 列印模板落庫 | `src/lib/print-templates-sync.ts:35,64`、表 `pos_print_templates` |
| 模板快照自包含 | `src/lib/types.ts:660`（`EscPosTemplateSnapshot`） |
| 導航現況 | `src/components/app-sidebar.tsx:27-45` |
| 業態枚舉 | `src/lib/types.ts:23`、`src/lib/salon/industry-config.ts:19` |
| **打印機型號配對範本** | `src/lib/print-bridge/printer-models.ts:35`（`USB_PRINTER_DB`）、`:189`（`resolveUsbMeta`）、`:257`（`getLanModelOptions`） |
| **Companion USB 枚舉（掃碼槍／秤配對參照）** | `src/lib/print-bridge/companion.ts:553`（`/api/usb`）、`:583`（`/api/printers`）、`:628`（`/api/bluetooth`）、`:532`（`/api/discover`） |
| ⚠️ **Web Bluetooth 不支援 iPad** | Safari / iOS / iPadOS 任何版本皆無（Apple 強制全部 iOS 瀏覽器用 WebKit）→ 稱重靠條碼標籤秤（§2.5 W1） |
| 坑總表 | `docs/113-agent-gotchas.md` |
