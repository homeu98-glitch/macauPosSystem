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

**打印機角色（已有，但要擴）**：`PrinterRole = "zone" | "receipt" | "label"`（`types.ts:83`）。
零售用 `receipt`（收據機）、`label`（標籤機），`zone` 停用。

🔴 **零售要新增「一機兩用」角色** —— 部分國產機（佳博 GP-2270T、GP-3120TUC）支援「標籤 + 小票」雙用，
一部機可以同時擔任兩個角色。`PrinterRole` 係**單值 union** → 要改成**角色集合**（`roles: PrinterRole[]`）
或加 `"receipt+label"` 值。**這是零售專屬需求，餐飲側不受影響**（餐飲冇機同時做兩件事）。

**多台打印機（商家確認要）**：完全沿用餐飲既有打印機設定機制（`docs/82` Meituan 式 Wizard）——
可以加任意多台、每台獨立揀角色、獨立測試列印。零售**唔另做設定介面**。

**型號庫（國產為主）**：國產品牌佔大多數（佳博 Gprinter、漢印 HPRT、芯燁 Xprinter、得力 Deli、
快麥 KuaiMai、啟銳 Qirui、容大 Rongta、立象 Argox、台半 TSC…）。
`USB_PRINTER_DB`（`printer-models.ts:35`）現時只有 Gprinter / Xprinter / Rongta / TSC / Zebra 等少數 →
**要補齊國產型號**。
⚠️ **VID/PID 必須由實機枚舉收集，唔可以靠猜** —— 國產品牌常見「同一品牌多個 VID」「白牌機共用 VID」。
設計上要保住既有嘅三層 fallback：命中型號 → 精確配置；只認得品牌 → 品牌預設並標 `generic: true`；
**全唔認得 → 通用 ESC/POS 預設（照印得到）** + 提供「回報型號」入口。

**⚠️ 標籤模板：現有 `LabelSectionId` 係「飲品杯貼」，零售要新區塊集**

`LabelSectionId`（`types.ts:335-348`）現時係 `header | item_name | temperature | cup_type | sugar | ice | sugar_tag | ice_tag | addons | specs | item_note | order_no | footer` —— **全部係奶茶／咖啡杯貼概念，零售一個都用唔到**（冇價錢、冇條碼、冇原價）。

好消息：`LABEL_PAPER_PRESETS`（`types.ts:483-492`）**已經預留零售紙張**：
`50x30` → 「零售價籤、商品標示」（28 字／行）、`58x40` → 「收銀機標準價籤」（32 字／行）、`40x30` → 「細標籤 / 條碼」。

所以零售要新增 **`RetailLabelSectionId`**（獨立模板槽位，唔改動飲品標籤）：

```ts
// 零售標籤新區塊集（types.ts 新增）
| "store_name"        // 門店名
| "item_name"         // 商品名
| "variant"           // 變體（黑 / L）      ← 服裝必需
| "price"             // 售價（大字）        ← 零售核心
| "original_price"    // 原價（刪除線）
| "barcode"           // 條碼（含自編碼）    ← 零售核心
| "sku"               // SKU
| "plu"               // PLU（稱重商品）
| "unit_price"        // 單位價（$ / kg）
| "net_weight"        // 淨重
| "packed_date"       // 包裝日期
| "expiry_date"       // 有效日期（生鮮 / 藥房）
| "batch_no"          // 批次（藥房）
| "footer";
```

**四種零售標籤用途**（同一模板可切換，見確認稿 ⑧）：

| 標籤 | 紙張 | 用途 |
| --- | --- | --- |
| **價籤** | 50×30 / 58×40 | 貼貨架，顯示商品名 + 售價 + 原價 + 條碼 |
| **商品標籤** | 50×30 | 貼商品上，顯示變體 + SKU + 條碼 |
| **稱重標籤** | 40×30 | 秤壞時嘅備用（正常由條碼標籤秤自己出） |
| **自編碼標籤** | 40×30 | 無廠碼散裝商品補一個「2」開頭可掃條碼 |

**批量打印（新能力）**：現有標籤打印係 `buildLabelPrintJobs(order)` —— **跟訂單逐件商品出**（`print-center.tsx:1062`）。零售需要**由商品清單反向批量打印**：商品頁多選 → 每件 N 張 → 入打印佇列；改價後一鍵重印受影響價籤。呢個係新增入口，唔影響現有訂單出標籤路徑。

**三端一致性（紅線）**：`EscPosTemplateSnapshot`（`types.ts:660`）係自包含快照，模板一改要同步改 **POS 預覽（`receipt-ticket-preview.tsx`）、Companion、APK、print-hub** 四個出紙端嘅 renderer。只改一邊 = 「介面預覽同實紙唔一致」（已有 `docs/70`、`docs/74`、`docs/99` 前科）。加 `RetailLabelSectionId` = 四端都要加對應 renderer 分支。

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

> ⚠️ **2026-09-12 商家已拍板：稱重標籤統一由 POS 標籤機印。**
> 所以下面嘅 W1 由「首選」降為**兼容路徑**（客人已貼秤標籤時照樣掃得到），
> 真正嘅首選變成 **W3（USB HID 收銀秤）＋ POS 印標籤**。
> **好處：唔需要買貴嘅「條碼標籤秤」，一台普通電子秤就夠。** 秤只需要出重量，價錢一律由 POS 算。

#### W1（兼容路徑）：條碼標籤秤 / Price-embedded EAN-13

秤自己印一張不乾膠標籤，條碼內容就係 PLU + 重量或金額。POS 只當普通條碼掃 → **零整合、零驅動、iPad 直接可用**。

```
2   01234   00350   X
│   │       │       └─ 校驗位（自動計算）
│   │       └───────── 重量(克) 或 金額(分)，5 位
│   └───────────────── PLU / 商品碼，5 位（＝我們商品的 plu）
└───────────────────── 前綴 20-29 = 店內變重碼；21 = 重量碼、22 = 金額碼
```

**仍然要支援嘅理由**：已經用開條碼標籤秤嘅商戶（超市、大型生鮮）唔應該因為升級 POS 而報廢設備；
另外藥房／生鮮若有分店自行秤重，標籤照樣掃得到。

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

#### 建議組合（2026-09-12 拍板後）

| 場景 | 建議方案 |
| --- | --- |
| **重量點入 POS** | **W3 USB HID 收銀秤**（首選 —— 插上就用、零驅動、零配對） |
| **標籤（所有情況）** | **統一由 POS 標籤機印** ← 商家拍板 |
| 秤壞 / 客人自備容器 | **W4 手動輸入**，永遠保留 |
| 客人已貼秤標籤 | W1 掃變重條碼照樣解析（兼容，非必需） |
| 想無線 | W2 經 Companion 代理（Phase 3） |

**成本結論**：因為標籤由 POS 印，**唔需要買「條碼標籤秤」**（嗰種機貴，因為內建打印機）。
一台普通電子秤（USB HID 即可）就夠 —— 秤只出重量，價錢一律由 POS 算。

⚠️ **W1 兼容配套**：若商戶仍用條碼標籤秤，秤端商品庫同 POS 要用**同一套 PLU**，
並禁止秤端隨意改價，否則「秤上價 ≠ POS 價」→ 收銀爭議。
（採用「POS 統一印標籤」就**冇呢個問題** —— 秤端根本唔使入商品庫。）

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
| `src/lib/types.ts:335 LabelSectionId` | **係飲品杯貼**（temperature / cup_type / sugar / ice），零售一個都用唔到 | 新增 **`RetailLabelSectionId`** 獨立區塊集（價籤 / 商品標籤 / 稱重 / 自編碼）—— 見 §R5 |
| `src/lib/types.ts:483 LABEL_PAPER_PRESETS` | ✅ **已預留零售紙張**（50×30 價籤、58×40 標準價籤、40×30 細標籤） | 加「**自訂寬 × 高**」選項（商家自己填 mm，系統自動算 columns） |
| `PrinterRole`（`types.ts:83`） | 單值 `zone \| receipt \| label` | 擴成**角色集合**以支援「一機兩用」 |
| `src/lib/types.ts:83 PrinterRole` | ✅ 已有 `zone \| receipt \| label` | 零售用 `receipt` + `label`，唔使改 |
| `buildLabelPrintJobs()`（`print-center.tsx:1062`） | 只跟訂單逐件出標籤 | 新增「由商品清單批量打印價籤」入口 |
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
| D6 | 稱重 | 要，但擔心網頁版限制 | 重量用 **USB HID 秤 / 手動輸入**；**標籤統一由 POS 印** → §2.5 |
| D7 | 標籤機品牌 | **國產比較多** | 型號庫要補齊國產（佳博／漢印／芯燁／得力／快麥／啟銳…）+ 保住通用 ESC/POS fallback → §R5 |
| D8 | 價籤尺寸 | **兩種都加，讓商家自己選，並可自訂** | 加 `CustomLabelPaper`（自訂寬 × 高）→ §8.1 |
| D9 | 打印機數量 | **多台**，走跟餐飲一樣嘅設定 | 沿用既有打印機設定機制；另加「一機兩用」角色 → §R5 |

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

**新增 `RetailLabelSectionId`**（零售標籤獨立區塊集，⚠️ 四端 renderer 同樣要同步）

```ts
| "store_name" | "item_name" | "variant" | "price" | "original_price"
| "barcode" | "sku" | "plu" | "unit_price" | "net_weight"
| "packed_date" | "expiry_date" | "batch_no" | "footer";
```
四種用途（同一模板可切換）：**價籤**（貨架）/ **商品標籤**（貼商品）/ **稱重標籤**（統一由 POS 印）/ **自編碼標籤**（無廠碼散裝商品補「2」開頭可掃條碼）。

**自訂標籤紙 + 打印機角色集合（2026-09-12 商家要求「都可以自訂」）**

```ts
/** 自訂標籤紙：商家自己填 mm；columns 由系統算（唔畀手填，免出紙歪） */
export interface CustomLabelPaper {
  id: string;        // "custom-<時間戳>" ⚠️ 唔可以顯示畀用戶，一律顯示 label
  label: string;     // 商家自己打嘅名，例如「自家價籤」
  widthMm: number;
  heightMm: number;
  columns: number;   // floor((widthMm − 8) / 1.5) — 同 LABEL_PAPER_PRESETS 同一公式
}

/** 打印機角色：單值 → 集合，以支援「一機兩用」 */
// PrinterConfig.role: PrinterRole   →   roles: PrinterRole[]
export type PrinterRole = "zone" | "receipt" | "label";
// 「標籤 + 小票」雙用 = roles: ["receipt", "label"]
```

⚠️ 舊設定係**單值** `role` → **必寫遷移**：`role: "receipt"` → `roles: ["receipt"]`。
同 `paymentMethods` 一樣，唔可以硬換型別（存量門店設定會消失）。

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
| `src/lib/retail/label-jobs.ts` | 由商品清單組裝標籤 PrintJob（批量、每件 N 張、重印） | 🟢 純函式 |
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
| `src/components/print-center.tsx` | 新增「零售標籤」模板槽位（`RetailLabelSectionId`）+ 批量價籤打印入口 | 🔴 四端要同步 |
| `src/lib/print-templates-sync.ts` + 四端 renderer | 新增 5 個收據區塊 **＋ 整個零售標籤區塊集** | 🔴 四端要同步、要擰 `versionCode` |

### 8.4 Phase 0 出口標準

1. 設定頁可為商品填 SKU + 主條碼 + **多條碼** + PLU + 單位 + 稱重／序號／變體開關
2. **批量匯入 CSV** 跑得通（含欄位對照與差異預覽）
3. **掃碼槍自動學習嚮導**跑得通：掃同一條碼 3 次 → 學出 profile → 測試框顯示正確解析
4. 掃一件真實商品條碼 → console 出正確商品（**此時畫面未做**）
5. 掃一個變重條碼（例 `21 01234 00350 5`）→ 正確解析出 PLU + 350g
6. 所有新純函式都有 `node --test` 單測；`npm run typecheck` + `npm run test` 全綠
7. **餐飲側零回歸**（`kiosk-cart.ts` 改動唔影響現有 199 個測試）


---

## 9. Phase 0 實作記錄（2026-09-12）

### 9.1 完成狀態

**全部 7 個純函式核心模組 + 型別層 + 設定白名單已完成並通過驗證。**

| 驗證項 | 結果 |
| --- | --- |
| `npm run test`（= `node --test`） | **410 pass / 0 fail**（開工前基線 220 → 新增 **190** 個測試） |
| `tsc --noEmit` | **0 error** |
| `eslint`（新檔 + 改動檔） | **0 error / 0 warning** |
| 餐飲側回歸 | ✅ 零影響（220 個既有測試全部照過） |

⚠️ 本機 `npm` 經 git-bash 跑唔到（`/usr/bin/env: bash: No such file or directory`），
要直接呼叫：`node_modules/typescript/bin/tsc`、`node --test`、`node_modules/eslint/bin/eslint.js`。
另外 git-bash **冇 coreutils**（`ls` / `grep` / `sed` / `head` / `tail` 全部 command not found）→ 一律用 `node -e` 或專用工具。

### 9.2 新增檔案（10 個模組 + 8 個測試）

全部係**零 runtime 依賴純函式**（只有 `retail-cart.ts` 刻意重用 `../pos/discount.ts`，
佢本身亦係零 runtime 依賴），所以全部可以 `node --test` 直接載入：

| 模組 | 測試數 | 職責 |
| --- | --- | --- |
| `src/lib/retail/types.ts` | — | 零售型別（`RetailProduct` / `RetailVariant` / `ScannerProfile` / `WeighedBarcodeRule` / `RetailPaymentMethod` / `CustomLabelPaper` / `SplitPaymentEntry`）+ 純 helper |
| `weighed-barcode.ts` | 16 | 變重碼解析（2/02 前綴、PLU 位、重量/金額、校驗位、長前綴優先） |
| `barcode-index.ts` | 20 | 條碼索引（一商品多條碼、變體條碼、**撞碼要報衝突**）、掃碼解析（變重碼優先） |
| `scanner-profiles.ts` | 29 | 型號庫（VID = 公司級；未確認嘅留空）+ `learnProfile()` 自動學習 |
| `retail-cart.ts` | 28 | 購物車（改價 / 定額折 / 稱重 / 變體 / 序號）、金額單一真源、權限閘判斷 |
| `split-payment.ts` | 22 | 付款方式兼容轉換、拆分付款餘額 / 找零 / 完成驗證 |
| `stock.ts` | 19 | 即時扣減（**稱重扣 kg 唔係扣 1**）、退貨回補、低庫存 |
| `printer-roles.ts` | 7 | 角色集合（「一機兩用」）+ 舊單值 `role` 兼容推導 |
| `csv-import.ts` | 24 | 手寫 CSV parser、中文表頭對照、逐行驗證、差異預覽 |
| `barcode-scanner-core.ts` | 17 | 鍵盤緩衝狀態機（用**時間**分辨掃碼 / 人手打字） |
| `use-barcode-scanner.ts` | — | React hook（只做接線；判斷邏輯全部喺 core） |

### 9.3 改動嘅現有檔案（全部「純新增」，零語義改動）

| 檔案 | 改動 |
| --- | --- |
| `src/lib/types.ts` | `AccountStore.industry` 加 `"retail"`；`UserPermissions` 加 `priceOverride` / `applyDiscount` / `returnOrder`；`OrderItem` 加 8 個零售欄；`PosOrder` 加 5 個零售欄；`PosRules` 加選填 `retailPaymentMethods`；`DevicePrinterConfig` 加選填 `roles`；`PosLocalSettings` 加 6 個**必填**零售欄 |
| `src/lib/storage.ts` | `normalizePosLocalSettings` 白名單加 6 欄（**紅線**：漏咗就 reload 被剷走） |
| `src/lib/mock-data.ts` | `defaultPosLocalSettings` 補齊 6 個新欄嘅預設值 |

🔴 **`PosLocalSettings` 嘅新欄刻意宣告做「必填」** —— 咁樣 tsc 會逼你同時改
`normalizePosLocalSettings` 同 `defaultPosLocalSettings`，唔可以靠記性。
實測有效：加完之後 tsc 即刻指出兩處要補（`mock-data.ts:323`、`storage.ts:302`）。

### 9.4 三個刻意嘅技術決定（同原計劃唔同）

**① 收據 / 標籤區塊**（`ReceiptSectionId` +5、`RetailLabelSectionId`）**延後到打印子階段。**
（2026-09-13 已完成收據部分 → 見 §11。）

原因：加區塊要**同時**改三處先唔會出事 —— `RECEIPT_SECTION_META`（設計介面顯示）、
`RECEIPT_BLOCK_DEFAULTS`（`Record<>` 必填）、`buildReceiptContent`（內容）。
若漏咗 `BLOCK_DEFAULTS`，`ensureReceiptSections()` 補唔到 → 商家喺設計頁見到一個
「撳咗冇反應」嘅開關 —— 而 `docs/113` 明文禁止製造死開關
（前科：`kitchen` 嘅 `server` / `customer_count`）。

> 🔴 **【重要修正 2026-09-13】原本喺度寫「必須四端 renderer 同步 + 擰 `versionCode`」，係過度保守。**
> 實際睇過五個 renderer（POS `escpos-render.ts` ＋ 四端）之後確認：
> **加「靜態文字區塊」完全唔需要改下游**，因為 `PrintJob.content` 係
> `Record<sectionId, string>` —— **自描述**，renderer 一律做同一件事：
> ```
> content[block.id] ?: continue    // 有值就照印，冇值就跳過
> ```
> 五個 renderer 都係呢個形狀（已逐一核對：`escpos-render.ts:301`、
> `companion-server.mjs:594`、`print hub / print-agent-android / print-relay` 嘅 `EscPosRenderer.kt`）。
> **所以「加區塊」同「四端同步」係兩件事，唔應該混為一談：**
>
> | 加嘅嘢 | 要改下游？ | 要擰 `versionCode`？ |
> | --- | --- | --- |
> | **靜態文字區塊**（`content[id]` 有值就印） | ❌ 唔使 | ❌ 唔使 |
> | **逐項資料**（`PrintJob.items[]` 加欄位，例如逐項條碼） | ✅ 四端都要改 | ✅ 要 |
> | **改區塊語義**（例如新 `divider` 行為） | ✅ 四端都要改 | ✅ 要 |
>
> 呢個修正令零售收據由「要開一輪跨 repo 工程」變成「一個 repo 內嘅小改動」。

**② `types.ts` 一律用「加選填欄位」而唔改既有欄位型別。**

- `PosRules.paymentMethods` **保持 `string[]` 唔動**，另加選填 `retailPaymentMethods?: RetailPaymentMethod[]`
  （有值優先）。原本計劃係改成 `Array<string | RetailPaymentMethod>`，但咁樣會令
  `pos-app.tsx:6412` 等既有 `paymentMethods.map(...)` 直接型別爆掉，風險唔值得。
- `DevicePrinterConfig.role` 保持單值，另加選填 `roles?: PrinterRole[]`，
  由 `printerRolesOf()` 兼容推導 → **舊設定完全唔使遷移**。
- `PosLocalSettings.paymentMethods` 同理保留。

**③ 零售型別獨立放 `src/lib/retail/types.ts`，唔塞入 `lib/types.ts`。**

零售型別係全新、零遺留依賴；塞入 `types.ts`（已 1000+ 行）只會增加誤改既有
union / `Record<>` 嘅風險（一改就四端出紙要跟）。**需要改既有結構**嘅欄位
（`OrderItem` / `PosOrder` / `PosLocalSettings`）就仍然寫喺 `lib/types.ts`。

### 9.5 實作過程捉到嘅 5 個真 bug（全部有回歸測試鎖住）

| # | Bug | 後果 | 捉到方法 |
| --- | --- | --- | --- |
| 1 | `addRetailLine` 只檢查「新加入嘅行」可否合併，**冇檢查已存在嘅行** | 已綁序號嘅行被合併 → 一物一碼失效 | 單測 |
| 2 | 同上，已存在嘅**稱重行**被同簽名新行合併 | 兩件實物變一行 | 單測（補測） |
| 3 | 緩衝狀態機嘅間隔檢查用 `lastAt > 0` | 第一鍵時間戳係 0 時，之後每一鍵都跳過間隔檢查 → **人手打字被當成掃碼** | 單測 |
| 4 | `maxLength` 用**含前綴**嘅長度比 | 有 `~` 前綴嘅槍永遠多一位 → 13 位條碼被誤判「太長」 | 單測 |
| 5 | `use-barcode-scanner` 喺 render 期間寫 `cbRef.current` | React 19 `react-hooks/refs` 報 error | eslint |

另外修咗 3 個**我自己寫錯嘅測試斷言**（唔係實作錯）：
`weight_kg` + `divisor:1` 嘅語義（整數公斤）、`parseMoney("-$5")` 應回 `-5`（範圍驗證係 caller 責任）、
`toHexId("0X0416")` 大小寫契約。**測試錯同實作錯要分清楚，唔可以為咗過測試而改實作。**

### 9.6 下一步（Phase 1）

1. **`/retail` 路由骨架** + 側欄（依 `industry === "retail"` 條件渲染）
2. **商品編輯頁**（`device-settings.tsx`）：SKU / 多條碼 / PLU / 單位 / 稱重 / 序號 / 變體矩陣
3. **收銀台三欄 UI**（`use-barcode-scanner` + `retail-cart` + `split-payment` 接上去）
4. **零售商品持久化**：目前**未決定**存邊（localStorage 會令 `localSettings` 寫入膨脹，
   而寫入失敗係已知靜默風險）→ 建議獨立 store key，唔好塞入 `PosLocalSettings`
5. 打印子階段（收據 5 區塊 + 零售標籤區塊集 + 四端 renderer + 擰 `versionCode`）

---

## 10. Phase 1 實作記錄（2026-09-12 · 收銀台可跑）

### 10.1 完成內容

| 層 | 檔案 | 內容 |
| --- | --- | --- |
| 持久化 | `src/lib/storage.ts` | 新增 `retailProducts` store-scoped key（`macau-pos/stores/{storeId}/retail-products`）+ `loadRetailProducts` / `saveRetailProducts` / `getRetailProductsKey` |
| 純函式 | `src/lib/retail/catalog-ops.ts`（24 測） | 商品查詢 / 新增 / 更新 / 停售 / 刪除 / 改庫存、搜尋（**完全匹配優先**）、排序、CSV 匯入套用、統計 |
| 結帳 | `src/lib/retail/retail-orders.ts` | `settleRetailOrder()`：扣庫存 → 落單（`settled`）→ 入 outbox → 通知 flush |
| 路由 | `src/app/retail/{layout,page}.tsx`、`products/page.tsx` | `/retail`（收銀台）、`/retail/products`（商品管理） |
| 元件 | `src/components/retail/{retail-sidebar,retail-counter,retail-products}.tsx` | 側欄、三欄收銀台、商品管理 + CSV 匯入 |

**驗證**：

| 項 | 結果 |
| --- | --- |
| `tsc --noEmit` | **0 error** |
| `eslint`（新檔 + 改動檔） | **0 error / 0 warning** |
| `node --test` | **434 pass / 0 fail**（Phase 0 完結時 410 → 新增 24） |
| `next build` | ✅ **成功**（Compiled 67s、TypeScript 64s、**73/73 靜態頁**；`/retail` 同 `/retail/products` 兩個新路由都出到） |

⚠️ **未做 runtime 驗證**：`/retail` 喺 `AuthGuard` 後面，未登入會跳去 `/login`，
所以自動截圖驗證需要先 seed 一個登入 session。**建議商家自己開一次**（`npm run dev` → 登入 → `/retail`）。

### 10.2 三個關鍵實作決定

**① 零售商品唔放 `PosLocalSettings`，用獨立 store key。**
理由：商品可能幾千件，塞入設定會令 `savePosLocalSettings` 膨脹；而設定寫入失敗係已知靜默風險
（docs/71 P1-A），唔應該同商品資料互相拖累。獨立 key = 同 orders / printJobs 同級待遇。

**② 結帳狀態一律 `settled`，唔用 `paid`。**
`paid` 係快餐 counter 專用（單向閘，docs/113）。零售係「一手交錢一手交貨」即時完成 →
必須 `settled`，否則 `isSaleCountable()` 唔會計入營業額。

**③ 結帳次序：先扣庫存並寫入商品主檔，再落單。**
若庫存寫入失敗（quota / 私隱模式），**照樣落單但大聲 `console.error`** ——
唔可以因為庫存寫唔入而食咗客人張單（錢已經收咗）。超賣（`shortfall > 0`）另外 `console.warn`
並喺 toast 講明，唔靜默。

### 10.3 秤標籤「金額碼」反推重量（新增細節）

變重條碼有兩種：**重量碼**（有 kg）同**金額碼**（只有總額）。
若係金額碼又唔知重量，庫存就扣唔到 kg。解法：**金額 ÷ 商品單價 = 重量**（`weightKg = price / unitPrice`），
令兩種碼都扣得到 kg。單價係 0 時唔可以反推 → 退化成「改價成秤上金額」並用 toast 講明。

### 10.4 ⚠️ 刻意未做：出票（打印）

**零售單目前唔會自動出收據。** 原因同 §9.4 ①一樣：零售收據要新區塊
（品項條碼 / 拆分付款明細 / 會員積分 / 退換貨條款），而加區塊必須**四端 renderer 同步** +
擰 `versionCode`；只加一半會變「撳咗冇反應」嘅死開關（docs/113 明文禁止）。
`settleRetailOrder()` 尾段已留 `TODO` 位置（`appendPrintJobsWithSync(buildReceiptPrintJobs(order))`）。

**標籤打印**同理（`RetailLabelSectionId`）。

### 10.5 已知限制（唔係 bug，係未做）

- 側欄只有「收銀台 / 商品」——**刻意唔連去未起好嘅頁**（死連結比少個入口更差）
- 冇「掛單 / 取單」（`hold-orders.ts` 仍係 Phase 2）
- 冇退換貨（Phase 2）
- 商品**未上雲**：目前只落本機 `retail-products` key；`pos_products` 表 + 跨裝置同步要另一輪工作
  （**注意**：跨裝置餐牌同步失效係本專案已知問題，見 docs/92、docs/113）
- `retailApprovalRules`（改價 / 折扣授權閾值）目前只**顯示**，未接 PIN 閘

### 10.6 下一步

1. **出票子階段**（最高優先，商家最關心）：收據 5 區塊 + 零售標籤區塊集 + 四端 renderer + 擰 `versionCode`
2. 商品上雲（`pos_products`）+ 跨裝置同步
3. PIN 權限閘接上 `retailApprovalRules`
4. 掛單 / 取單、退換貨
5. 庫存 / 報表 / 交班頁加入側欄

---

## 11. 打印子階段（2026-09-13 · 零售收據可以真正出紙）

### 11.1 關鍵發現（先講，因為佢改變咗整個工作量評估）

**五個 renderer 全部都係「查表式」**：`content[block.id]` 有值就照印、冇值就跳過。
逐一核對結果：

| Renderer | 位置 | 寫法 |
| --- | --- | --- |
| POS 預覽 / 出紙 | `src/lib/escpos-render.ts:263-301` | `if (!b.visible) continue` → `divider`/`items`/`qr_code` 特例 → `if (!text) continue` |
| Companion | `desktop-companion/companion-server.mjs:594` | `const text = content[b.id]; if (!text) continue;` |
| print hub | `app/.../EscPosRenderer.kt:457` | `val text = content[b.id] ?: continue` |
| print-agent-android | `app/.../EscPosRenderer.kt:546` | `val text = content[b.id] ?: continue` |
| print-relay | `app/.../EscPosRenderer.kt:458` | `val text = content[b.id] ?: continue` |

→ **加「靜態文字區塊」零跨 repo 改動、零 `versionCode`**。只有
`items[]` 逐項資料 / 改區塊語義才需要四端同步（見 §9.4 ① 嘅修正表）。

### 11.2 完成內容

| 檔案 | 改動 |
| --- | --- |
| `src/lib/types.ts` | `ReceiptSectionId` += `split_payment` / `points_earned` / `exchange_of` / `return_policy`；`ReceiptTemplate.returnPolicyText?` |
| `src/lib/escpos-template.ts` | 4 個 `RECEIPT_SECTION_META` 項目、4 個 `RECEIPT_BLOCK_DEFAULTS`、`DEFAULT_RECEIPT_TEMPLATE.order` 插入 4 個 id、`buildReceiptContent` 接上新 builder |
| `src/lib/retail/receipt-retail-blocks.ts`（**新**，18 測） | 四個區塊嘅格式化（多行 / 空值抑制 / 金額格式）—— 純函式，可測 |
| `src/lib/storage.ts` | `normalizePosLocalSettings` 白名單加 `receipt.returnPolicyText`（🔴 同 `qrUrl` 同一個坑） |
| `src/lib/mock-data.ts` | 兩個模板 literal 補 4 個區塊 + `order` 陣列 |
| `src/lib/print-jobs.ts` | 傳 `returnPolicyText` 落 `buildReceiptContent` |
| `src/lib/preview-fixtures.ts` | 預覽範例單補 `splitPayments` / `pointsEarned` / `pointsBalanceAfter` / `exchangeOf`（令設計頁睇得到） |
| `src/components/print-center.tsx` | 「退換貨條款」textarea（模板層級，收據 / 自助機各自設定） |
| `src/lib/retail/retail-orders.ts` | **接上出票**：`appendPrintJobsWithSync(buildReceiptPrintJobs(order, bootstrap))` |

### 11.3 三個要點

**① 出票一定要用 `appendPrintJobsWithSync()`。**
佢一次過做「持久化 + 入 outbox（產生 `PRINT_JOB_CREATED`）」。淨叫 `savePrintJobs()`
＝ 零出紙 ＋ 零紅標（docs/113 明文列出嘅坑）。

**② 出票失敗唔可以影響落單。**
錢已經收咗、單已經入 outbox，所以出票全部包 `try/catch`，出錯只大聲報。
`SettleRetailOrderResult` 回 `printJobCount` / `printWarning`，收銀台 toast 會講明
「收據 1 張」或者「⚠️ 未出票：冇啟用嘅收據機（role=receipt）」——
**歷史上出票靜默失敗就係咁被掩住咗**，所以一定要出聲。

**③ 空內容 = 區塊自動消失（加區塊唔會影響現有商戶）。**
四個區塊預設 `visible: true`，但餐飲單冇 `splitPayments` / `pointsEarned` /
`exchangeOf` / `returnPolicyText` → content 空 → renderer 跳過。
**唔可以**預設 `false`，否則零售商戶要自己去設計頁逐個撳開，容易以為功能冇做。

### 11.4 設計介面嘅一個實務細節

`print-center.tsx` 內建 dev 守衛 `assertPreviewCoverage()`：逐個區塊檢查預覽 content
有冇非空值，冇就喺 console 警告「請喺 `preview-fixtures.ts` 補返範例值，
否則商家喺設計頁永遠睇唔到呢啲區塊」。**呢個守衛正好指引咗我該改邊度** ——
所以 `preview-fixtures.ts` 補咗零售範例值。

但 `return_policy` 例外：佢係**商家自己打嘅文字**，刻意**唔用示例 fallback**
（同 `storeTel` / `qrUrl` 唔同 —— 嗰兩個係系統提供嘅值，用示例無害）。
若清空之後預覽仲顯示一句範例，商家會以為「清唔走」，同「預覽 == 出紙」嘅契約矛盾。
所以照傳真實值 + 加入 `assertPreviewCoverage` 嘅 `skip` 集（連原因註釋）。

### 11.5 驗證

| 項 | 結果 |
| --- | --- |
| `tsc --noEmit` | **0 error** |
| `node --test` | **452 pass / 0 fail**（§10 完結時 434 → 新增 18） |
| `eslint`（新檔 + 改動檔） | 0 error（`print-center.tsx` 嘅 16 個 error 係**既有基線**，喺我未改動嘅行號） |
| 五個 renderer 逐一核對 | ✅ 全部 `content[block.id]` 查表式 |
| `next build` | ✅ **成功**（Compiled 36.8s、TypeScript 54s、**73/73 靜態頁**） |

⚠️ **仍未做 runtime / 實紙驗證**：`/retail` 喺 `AuthGuard` 後面（要登入），
而「真實出紙」需要接上 Companion / APK 同實體打印機。
**建議商家實測一次**：登入 → `/retail` → 落一單 → 確認收據印出四個新區塊
（拆分付款明細 / 會員積分 / 換貨原單號 / 退換貨條款）。
出票若靜默失敗，收銀台 toast 會顯示「⚠️ 未出票：<原因>」，唔會靜靜食咗。

### 11.6 ⚠️ 未做：零售專屬標籤（價籤 / 商品標籤）

呢個**真正**需要四端同步，原因唔係「加區塊」，而係：

1. `PrintTemplateKind = "receipt" | "label" | "kitchen" | "shift"`（`types.ts`）——
   零售標籤要用新 `kind`（或共用 `label`），而 **renderer 有 `when (kind)` 分支**。
2. 零售標籤嘅內容（售價大字 / 原價刪除線 / 條碼圖）唔係純文字行，
   而 `label` 通道嘅內容係 per-item 由 `buildLabelContent()` 出 —— 需要新嘅
   `RetailLabelSectionId` + `buildRetailLabelContent()` + 四端 label 分支。
3. 底層仲要決定：價籤係按**商品**印（唔係按訂單行），即 `PrintJob` 要接受
   「唔屬於任何訂單」嘅 job（目前 `orderId` 係必填）→ 呢個係**合約改動**，要三思。

**下一步建議**：先做「由商品批量印價籤」嘅 POS 側（含 `orderId` 放寬為可選嘅合約決定），
確認四端都認得先擰 `versionCode`。

---

## 12. 零售價籤 / 商品標籤（2026-09-13）

### 12.1 🔑 核心決定：合成 `orderId`，唔改 `PrintJob` 合約

價籤係**按商品**印、唔屬於任何訂單。直覺做法係將 `PrintJob.orderId` 改成可選 ——
但嗰個係**合約改動**：四端 renderer、server `pos_print_jobs` 表、
打印中心都假設佢有值，改咗要四端同步 + 擰 `versionCode` + 可能撞 DB 約束。

**實際做法：合成 id `retail-label:<productId>`。**
- 行返**完全既有**嘅管道（outbox → 雲端 → 中繼 APK claim 出紙）→ **零跨 repo 改動**
- `orderNo` 放商品名 → 打印記錄列表照樣顯示「印咗邊件貨嘅價籤」
- **代價（要知）**：打印中心嘅「重打整單」（按 order 反查）搵唔到價籤；
  但打印記錄係按 job 顯示，**逐張重打完全正常** —— 對價籤嚟講足夠。
- 同一件商品印多次 → 多個 job 共用同一個合成 orderId，但 job id 各自 `uid()` → 唔會互相覆蓋。

### 12.2 完成內容

| 檔案 | 改動 |
| --- | --- |
| `src/lib/types.ts` | `RetailLabelSectionId`（9 個 id）、`RetailLabelTemplate`、`PrintTemplates.retailLabel?`（**選填** → 舊商戶零遷移） |
| `src/lib/escpos-template.ts` | `RETAIL_LABEL_SECTION_META`、`RETAIL_LABEL_BLOCK_DEFAULTS`、`DEFAULT_RETAIL_LABEL_TEMPLATE`、`normalizeRetailLabelTemplate()`；`buildSnapshot` / `withLabelFixedSizes` 放寬型別 |
| 🆕 `src/lib/retail/retail-label-content.ts`（15 測） | 價籤內容建構 + **CJK 闊度摺行**（`wrapToWidth` / `displayWidth`） |
| `src/lib/print-jobs.ts` | `buildRetailLabelPrintJobs(products, opts)` |
| `src/lib/storage.ts` | 白名單加 `printTemplates.retailLabel` |
| 🆕 `src/components/retail/retail-label-print.tsx` | 「印價籤」介面（揀商品 / 份數 / 即時預覽 / 出票） |
| `src/components/retail/retail-products.tsx` | 商品頁加「印價籤」入口 |

### 12.3 三個實作要點

**① `buildSnapshot()` 嘅 kind 一定係 `"label"`，唔可以係 `"retailLabel"`。**
三端 renderer 嘅 `when (kind)` 只認 `receipt` / `label` / `kitchen`，傳新 kind 會 fall through
→ 冇咗標籤嘅走紙 / 字型處理。**同 `kiosk` 槽位要傳 `"receipt"` 係同一個道理**
（`PrintTemplates.kiosk` 註釋已經寫過）。

**② `withLabelFixedSizes()` 放寬做 `Record<string, …>` —— 而且安全。**
佢內部係 `if (blocks[id] && def)`，只會鎖**已存在**嘅 id，**唔會注入**缺失嘅 id
→ 傳零售模板入去唔會無啦啦多 13 個餐飲區塊。
副作用（好嘅）：零售價籤嘅字型**唔會被鎖**，商家可以自己校大字 —— 價籤正需要呢個。

**③ 摺行一定要用「顯示闊度」，唔可以用 `length`。**
「維他檸檬茶 250ml」係 12 個 code point，但顯示闊度係 **18**（6 個中文字 ×2 + 6 個半角）。
按 `length` 摺 → 一行塞爆 → 打印機再自動摺一次 → 版面走樣。
`wrapToWidth()` 逐個 code point 累加闊度，超出上限就摺，並喺超出 `maxLines` 時補 `…`。

### 12.4 ⚠️ 刻意未做

**① 條碼圖（Code128 → 點陣）。**
需要 POS 端寫 Code128 encoder ＋ 四端 raster 輸出（同 QR 嗰套 `job.qr` 一樣要 POS 預先編碼）。
呢一輪**只印條碼數字 + PLU**：貨架價籤主要係畀人睇價，收銀係掃**商品本身**嘅條碼 ——
所以數字對店員核對已經夠用，唔值得為咗靚而開一輪跨 repo 工程。

**② 價籤模板嘅設計介面（print-center 第七個分頁）。**
`RETAIL_LABEL_SECTION_META` 已經齊，但 `print-center.tsx` 係 1500+ 行、
而且帶住 16 個**既有** lint error。加分頁要動 `snapshotKindOf` / `readTemplate` /
`SECTION_META` / `assertPreviewCoverage` 幾處 —— 為咗唔喺同一輪混入高風險改動，
刻意留返下一輪。**目前用 `DEFAULT_RETAIL_LABEL_TEMPLATE`（售價最大字、商品名次之）**，
預設已經啱用；`footerText` 亦暫時只能由資料層改。

### 12.5 驗證

| 項 | 結果 |
| --- | --- |
| `tsc --noEmit` | **0 error** |
| `node --test` | **477 pass / 0 fail**（§11 完結時 462 → 新增 15） |
| `eslint`（新檔 + 改動檔） | **0 error / 0 warning** |
| `next build` | ✅ **成功**（EXIT=0、Compiled 2.7s、TypeScript 2.5s、**75/75 靜態頁**；`/retail` 同 `/retail/products` 都出到） |

⚠️ **仍未做 runtime / 實紙驗證**：價籤要接上 `role === "label"` 嘅實體標籤機。
**建議商家實測**：商品頁 → 「印價籤」→ 揀商品 → 睇右邊即時預覽（應該見到
店名 / 商品名 / 大字售價 / 單位 / 條碼數字）→ 撳「印價籤」。
若一部標籤機都冇配置，介面頂部會**事先警告**，撳落去亦會明確講
「冇啟用嘅標籤機（role=label）→ 未出紙」—— 唔會靜默。

---

## 13. Phase 2 主線（2026-09-13 · 退換貨 + 掛單/取單 + 精靈 + 秤重 + 庫存頁）

商家指令：「1 2 3 全部做」→ 一次過清空上輪列嘅三個選項。

### 13.1 完成內容

| 子項 | 新增檔案 | 規模 |
| --- | --- | --- |
| ④ 掃碼槍自動學習精靈 | `components/retail/scanner-wizard.tsx`、`components/retail/retail-settings.tsx`、`app/retail/settings/page.tsx` | 兩步嚮導（收 3 個樣本 → 驗證）+ 設定頁（現用 profile / 付款方式 / 授權門檻） |
| ⑤ 手動秤重面板 | `lib/retail/manual-scale.ts`（+測試 26）、改 `retail-counter.tsx` `WeightPad` | 皮重預設 chips、實時金額、皮重 > 毛重 / 太輕出聲 |
| ⑨ 庫存頁 | `lib/retail/inventory-ops.ts`（+測試 32）、`components/retail/retail-inventory.tsx`、`app/retail/inventory/page.tsx` | 雙 Tab（要補貨 / 全部）、盤點草稿、一鍵補貨、匯出盤點表 |
| ⑩ 退換貨 | `lib/retail/returns.ts`（+測試 54）、`lib/retail/return-service.ts`、`components/retail/retail-returns.tsx`、`app/retail/returns/page.tsx` | 單號/序號/條碼反查 → 行級退 → 退款 + 回補庫存 + 出退款單 |
| ⑪ 掛單/取單 | `lib/retail/hold-orders.ts`（+測試 23）、改 `storage.ts`、`retail-counter.tsx` | F8 掛單 / F9 取最新、掛單 strip、隔日自動清過期 |

側欄由 2 項 → **5 項**（收銀台 / 商品 / 庫存 / 退換 / 設定）。

### 13.2 五個關鍵實作決定

**① 退換貨另立模組，唔重用餐飲退菜。**
餐飲退菜係「整項退、唔退款流程、唔回補庫存」（出咗廚房就係成本）；零售相反 ——
要真金白銀退款、要回補庫存、要按拆分付款比例分攤。硬塞入同一套會兩邊都壞。

**② 退款金額一律用「原單實收」口徑，唔可以用牌價。**
`lineNetOfItem()` 重算當時實際計價（改價 `price` 已係實際價 → 再乘 `discountRate`）。
**打過折 / 改過價嘅單唔會退多錢**（有專門單測鎖住：$199 打 8 折 → 只退 $159.20）。

**③ 全退判定用「剩餘可退金額」，唔用「剩餘件數」。**
稱重行嘅「剩餘」係 kg（1.5kg 退 0.5kg → 剩 1kg ≠ 0），但按件數睇
「soldQty 1 − returnedQty 1 = 0」會被誤判成全退 → 單被標成 `refunded`、
之後客人再退嗰 1kg 就冇得退。金額口徑天然處理「按比例退」，亦同客人實付對得上。

**④ 退款單走「收據通道」，用「全單備註」承載金額。**
收據模板嘅 `refund` 區塊係**交班單專用**；零售又冇 zone 打印機（`buildKitchenPrintJobs()`
會零出紙）。所以砌一個「退款視圖 order」（items = 退貨行、`orderNote` = 退款方式逐筆 + 合計 +
原單號）餵 `buildReceiptPrintJobs()` → **零模板改動、零四端改動**。
單號用 `原單號-退N`（同一單退兩次唔會印出兩個一樣嘅單號）。

**⑤ 掛單序號由 label 反推，唔用 `length + 1`。**
`nextHoldSeq()` 由現有 label 反推 max + 1 —— 用 `length + 1` 嘅話，刪咗中間一張
（例如刪咗「掛-02」剩「掛-01」「掛-03」）再掛新單就會**重號**。

### 13.3 實作過程捉到嘅 3 個真 bug（全部有回歸測試鎖住）

| # | 症狀 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | 冇 id 嘅兩行會撞同一個 key → 退 A 行當成退咗 B 行 | `["","","","0.00"].join("::")` = `"::::::0.00"`（**唔係空字串**），靠「拼出嚟係唔係空」判斷兜底會失效 | `returnItemKey()` 改為**逐個識別欄位檢查**，三個全空才用 `idx-${index}` |
| 2 | 稱重行退一半，單被標成 `refunded` | 全退判定用「剩餘件數」（稱重行 1 − 1 = 0） | 改用「剩餘可退金額」累加比對 |
| 3 | 部分退貨 + 拆分付款，各筆退款加總 ≠ 總退款 | 逐筆 `round2` 會產生 $0.01 尾差 | `splitRefundByMethod()` **尾差補落最後一筆** |

### 13.4 唔應該回補庫存嘅情形

現實：客人退嘅貨**未必入得返貨架**（過期 / 破損 / 已拆封 / 生鮮）。
`shouldRestock(reason)` 用關鍵字寬鬆比對（過期 / 破損 / 已開封 / 報廢 / 生鮮…）→
**照退款但唔回補庫存**，並喺介面明確講「貨品唔會回補庫存」。
唔做嘅話庫存會虛高，之後盤點又要再改一次。

### 13.5 ⚠️ 刻意未做

- **換貨唔係一頁搞掂**：換貨 = 退貨 + 開新單。新單要經 `settleRetailOrder()`
  行正常結帳路徑（扣庫存 / 落單 / outbox / 出票一步都唔可以少），
  所以只提供 `planExchange()` 計差額，實際操作係「退貨 → 返收銀台開新單」。
- **退款冇接支付終端**：`refundByMethod` 只係**記帳**（邊個方式退幾多），
  冇呼叫任何刷卡機 / 掃碼退款 API（澳門多數零售走人手退款，要接就要逐間支付商傾）。
- **序號退貨唔會自動解綁**：退完 `serialNos` 仍留喺原單（做歷史紀錄），
  冇另立「已退序號」黑名單 —— 同一序號可以再開新單賣（現實：維修後再售）。

### 13.6 驗證

| 項 | 結果 |
| --- | --- |
| `tsc --noEmit` | **0 error**（本檔相關；同 repo 另有平行 session 改緊 `local-orders-panel.tsx` / `orders-hub.tsx`，與零售無關） |
| `node --test src/lib/retail/*.test.ts` | **382 pass / 0 fail**（上輪 328 → 新增 54：`returns.test.ts`） |
| `eslint`（新檔 + 改動檔） | **0 error / 0 warning** |
| `next build` | 見下方 |

---

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
