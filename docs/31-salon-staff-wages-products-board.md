# 31 · Salon 員工工錢 / 級別 / 員工管理 / 賣產品 / 檔案號碼 / 看板入工作台 / 打印入設置

> 日期：2026-08-17
> 背景：用戶要求美容院再加 7 個功能 → ① 工錢（每服務細項對各職位設工錢）；② 員工管理頁（工作記錄 / booking / 工錢 / commission + 狀態 / shift / 放假操作）；③ 員工級別（高級工錢較高）；④ 賣產品（每產品指定 commission rate，賣時指明員工 + 客人，雙介面顯示，左 bar 加 tab）；⑤ 客戶檔案號碼（free text）；⑥ 預約看板放進工作台 + 跳頁按鈕 + 移除左 bar 看板項；⑦ 打印放進設置。
> 本文記錄經用戶確認的設計決策（4 個岔路口全選推薦項）、資料模型、實施落點。待用戶確認後按 Feature 順序落碼。
> 約定：不動餐飲；代碼落 `src/app/salon/`、`src/components/salon/`、`src/lib/salon/`；員工 label-only 不登入 POS；離線優先沿用 localStorage 熱路徑 + IndexedDB 鏡像 + sync 佇列（storage.ts 的 `SALON_MIRROR_KEYS = Object.values(SALON_STORAGE_KEYS)` 自動涵蓋新增鍵）。

---

## 一、設計決策（經用戶確認的 4 個岔路）

### 1.1 工錢模型（F1 + F3）— **項目 × 職位基礎工錢 + 級別倍率**
- 每個服務細項（`SalonServiceItem`）存一張「職位 → 基礎工錢」表，例如 療師執行面部 $80、助理 $40。
- 每位員工有級別（`SalonStaffLevel`：`junior` / `senior` / `master`），對應倍率（預設 `junior 1.0` / `senior 1.3` / `master 1.6`，可於設置編輯）。
- **該次工錢 = `服務項目.wages[執行員工職位] × 級別倍率`**（取整）。無該職位工錢 → 0。

### 1.2 產品模式（F4）— **獨立產品目錄 + 獨立賣產品流程**
- 新增 `SalonProduct` 目錄（name / 售價 / 成本 / `commissionRate%` / 分類；無庫存）。
- 獨立「賣產品」流程：揀產品 → 揀員工 → 揀客人 → 記 `SalonProductSale`（含佣金快照）。
- 客戶檔案顯示「買過嘅產品」；員工檔案顯示「賣出產品 + 佣金」。左 bar 加「產品」tab 到 `/salon/products`。
- 備註：`SalonOrderItem.kind` 早已支援 `"product"`，獨立流程暫不塞入結帳單（留 seam），以 `SalonProductSale` 為佣金唯一真源。

### 1.3 看板位置（F6）— **工作台嵌精簡日看板 + 跳完整頁按鈕**
- 工作台新增「今日預約看板（精簡）」區段：按時間排序嘅今日 booking 列表（時間 / 客人 / 服務 / 員工）+ 右上「完整看板 →」按鈕跳 `/salon/calendar`。
- 左 bar 移除「預約看板」項（空間唔夠）。完整日/週看板仍在 `/salon/calendar`。

### 1.4 員工頁深度（F2）— **詳情頁 + 狀態 / 放假 / shift 記錄**
- 員工列表 `/salon/staff` + 詳情 `/salon/staff/[id]`。
- 詳情含：profile + 狀態（在職 `active` / 放假 `on_leave` / 離職 `terminated`）+ 預約 / 服務記錄 + 工錢匯總 + 產品佣金匯總。
- 放假 = 日期區間記錄（`SalonStaffLeave`）；shift = 每日上班時段記錄（`SalonStaffShift`），log 形式，**先唔做週排班 grid**。

---

## 二、資料模型（src/lib/salon/types.ts）

### 2.1 員工級別 / 狀態（F1 / F3 / F2）
```ts
export type SalonStaffLevel = "junior" | "senior" | "master";

export type SalonStaffStatus = "active" | "on_leave" | "terminated";

export interface SalonStaff {
  id: string;
  name: string;
  nickname?: string;
  role: SalonStaffRole;
  level: SalonStaffLevel;          // 新增，預設 "junior"
  status: SalonStaffStatus;        // 新增，預設 "active"
  serviceCategoryIds: string[];
  phone?: string;
  hiredAt?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  // 舊欄位保留做遷移：active?: boolean; terminatedAt?: string;
}
```
> 遷移：`ensureSalonBootstrap` 對缺 `status` 嘅舊員工，由 `active`/`terminatedAt` 推導（`active` 有值且無 `terminatedAt` → `active`，否則 `terminated`）；缺 `level` → `junior`。新邏輯一律讀 `status` / `level`。

### 2.2 服務細項工錢（F1）
```ts
export interface SalonServiceItem {
  // …既有欄位不變…
  /** 各職位基礎工錢（MOP）。執行該項時工錢 = wages[員工職位] × 級別倍率；無該職位 → 0 */
  wages?: Partial<Record<SalonStaffRole, number>>;
}
```

### 2.3 Bootstrap 級別倍率（F3）
```ts
export interface SalonBootstrap {
  // …既有欄位不變…
  /** 員工級別對工錢倍率（預設 junior 1 / senior 1.3 / master 1.6）；設置可編輯 */
  staffLevelMultipliers?: Record<SalonStaffLevel, number>;
}
```

### 2.4 訂單項目工錢（F1，落點）
```ts
export interface SalonOrderItem {
  // …既有欄位不變…
  /** 該次服務工錢（MOP，已乘級別倍率、取整）。僅 kind:"service" 且有 staffId 時有意義 */
  wageAmount?: number;
}
```

### 2.5 產品目錄 + 銷售（F4）
```ts
export interface SalonProduct {
  id: string;
  name: string;
  category?: string;          // 分類（護膚 / 彩妝 / 髮品…），可選
  price: number;              // 售價 MOP
  cost?: number;              // 成本 MOP
  commissionRate: number;     // 佣金率 %（如 10 = 10%）
  active: boolean;
  sortOrder: number;
}

export interface SalonProductSale {
  id: string;
  productId: string;
  productName: string;
  price: number;                       // 成交價（通常 = product.price）
  commissionRate: number;             // 快照
  commissionAmount: number;           // round(price × commissionRate / 100)
  staffId: string;
  staffName: string;
  customerId?: string;
  customerName: string;
  paymentMethod?: SalonPaymentMethod; // 收錢方式
  soldAt: string;                     // ISO datetime
  note?: string;
}
```

### 2.6 員工放假 / shift 記錄（F2）
```ts
export interface SalonStaffLeave {
  id: string;
  staffId: string;
  start: string;        // ISO date (YYYY-MM-DD)
  end: string;          // ISO date
  reason?: string;
  createdAt: string;
}

export interface SalonStaffShift {
  id: string;
  staffId: string;
  date: string;         // ISO date（哪一日上班）
  start: string;        // "HH:MM"
  end: string;          // "HH:MM"
  note?: string;
  createdAt: string;
}
```

### 2.7 客戶檔案號碼（F5）
```ts
export interface SalonCustomerProfile {
  // …既有欄位不變…
  /** 檔案號碼（free text），供商家與實體文件對照 */
  fileNumber?: string;
}
```

### 2.8 儲存鍵（types.ts `SALON_STORAGE_KEYS` 新增）
```ts
products: "macau-pos-salon/products",
productSales: "macau-pos-salon/product-sales",
staffLeaves: "macau-pos-salon/staff-leaves",
staffShifts: "macau-pos-salon/staff-shifts",
```
> `SALON_MIRROR_KEYS = Object.values(SALON_STORAGE_KEYS)` 自動涵蓋，IndexedDB 鏡像 + sync 佇列照舊生效，熱路徑零改動。
> `resetSalonStorage` 同步補 `removeKey` 新鍵。

---

## 三、實施落點

### 3.1 類型與輔助（先行）
- `src/lib/salon/types.ts`：§二全部新增類型 + `SALON_STORAGE_KEYS` 新鍵。
- `src/lib/salon/salon-labels.ts`（NEW）：`SALON_STAFF_ROLE_LABELS` / `SALON_STAFF_LEVEL_LABELS` / `SALON_STAFF_STATUS_LABELS` 中文映射（role 原散落各處，集中）。
- `src/lib/salon/wages.ts`（NEW）：
  - `computeStaffWage(serviceItem, staff, bootstrap): number` → `wages?.[staff.role]` 為 null 回 0；否則 `Math.round(base × (bootstrap.staffLevelMultipliers?.[staff.level] ?? 1))`。
  - `computeOrderItemWage(item, serviceItems, staff, bootstrap)` 供 checkout 用。

### 3.2 種子與遷移（src/lib/salon/mock-data.ts + storage.ts）
- `mock-data.ts`：`buildDefaultSalonBootstrap` 員工補 `level:"junior"` + `status:"active"`；bootstrap 補 `staffLevelMultipliers: { junior:1, senior:1.3, master:1.6 }`；新增 `DEFAULT_SALON_PRODUCTS`（3–4 款示範產品，含 `commissionRate`）。
- `storage.ts` `ensureSalonBootstrap`：舊店補 `staffLevelMultipliers` 預設；舊員工補 `level`/`status`（見 §2.1 遷移）；首次啟動種 `products` 鍵（仿 `packageTemplates` 邏輯：僅當鍵為空才種入，唔覆蓋店家已建）。
- 新增 storage 讀寫（仿 `saveSalonStaff` 雙寫 bootstrap + 獨立鍵）：
  - `loadSalonProducts` / `saveSalonProducts`（雙寫 bootstrap.products）
  - `loadSalonProductSales` / `saveSalonProductSales`
  - `loadSalonStaffLeaves` / `saveSalonStaffLeaves`
  - `loadSalonStaffShifts` / `saveSalonStaffShifts`

### 3.3 F1 + F3 工錢 + 級別
- **服務細項編輯**：現有服務項目編輯表單（設置內）加「工錢」區塊 — 5 個職位各一個數字輸入（`stylist/colorist/therapist/assistant/receptionist`），寫入 `serviceItem.wages`。
- **員工級別**：員工編輯表單加「級別」下拉（`junior/senior/master`）；bootstrap 級別倍率於設置「員工」tab 編輯（`staffLevelMultipliers`）。
- **結帳計工錢**：`checkout.tsx` 組裝 order items 時，對每個 `kind:"service"` 項，`wageAmount = computeStaffWage(...)`. 訂單存 `wageAmount`。
- **收據**：`print.ts` 可按需顯示每項工錢（選用，先留字段，收據版面後續再加）。

### 3.4 F4 賣產品
- **路由**：`/salon/products`（NEW，`src/app/salon/products/page.tsx`）。
- **左 bar**：`salon-sidebar.tsx` 加 `{ href: "/salon/products", label: "產品", short: "品" }`。
- **目錄管理**：列表 + 新增 / 編輯產品（name / category / price / cost / `commissionRate` / 啟用），走 `saveSalonProducts`。
- **賣產品**：表單揀產品（帶出 price + commissionRate）→ 揀員工 → 揀客人（可留空 walk-in）→ 收錢方式 → 生成 `SalonProductSale`（`commissionAmount = round(price × commissionRate/100)`）存 `saveSalonProductSales`。
- **雙介面顯示**：
  - 客戶檔案（`customer-profile.tsx`）：新增「購買產品」區塊，列 `SalonProductSale` where `customerId === id`。
  - 員工詳情（F2 頁）：列 `SalonProductSale` where `staffId === id` + 佣金匯總。

### 3.5 F2 員工管理頁
- **路由**：`/salon/staff`（列表，NEW）+ `/salon/staff/[id]`（詳情，NEW）。
- **列表**：卡片/表格顯示 名字 / 職位 / 級別 / 狀態徽章 / 電話；點擊進詳情。
- **詳情聚合**（讀 `loadBookings` / `loadSalonOrders` / `loadSalonProductSales` / `loadSalonStaffLeaves` / `loadSalonStaffShifts`）：
  - **Profile**：名字 / 暱稱 / 職位 label / 級別 label / 狀態徽章 / 電話。
  - **狀態操作**：下拉 `active` / `on_leave` / `terminated` → `saveSalonStaff`。
  - **放假記錄**：列表 + 新增（start/end date + reason）→ `saveSalonStaffLeaves`。
  - **Shift 記錄**：列表 + 新增（date + start/end）→ `saveSalonStaffShifts`。
  - **工作記錄**：booking where `staffId===id` OR 任一 `services[].staffId===id`（日期 / 客人 / 服務）。
  - **工錢匯總**：`loadSalonOrders()` 攤平 `items` where `kind:"service" && staffId===id` → 加總 `wageAmount`（可選日期篩選）。
  - **產品佣金匯總**：`SalonProductSale` where `staffId===id` → 加總 `commissionAmount`。

### 3.6 F5 檔案號碼
- `customer-profile.tsx`：新增「檔案號碼」free text 輸入 → `persist` 寫 `fileNumber`。
- `customers` 列表（`src/app/salon/customers/page.tsx` 或對應元件）：顯示 `fileNumber` 欄位。

### 3.7 F6 預約看板入工作台
- `workbench.tsx`：KPI 與四面板之間（或取代「今日預約」面板）新增「今日預約看板（精簡）」區段：
  - 按 `startAt` 排序嘅今日 booking 列表（時間 / 客人 / 服務 / 員工），取 `todayBookings`（現有 memo 可複用）。
  - 右上「完整看板 →」按鈕 `Link` 跳 `/salon/calendar`。
- `salon-sidebar.tsx`：**移除** `{ href: "/salon/calendar", label: "預約看板", short: "約" }`。

### 3.8 F7 打印入設置
- 抽出 `src/components/salon/prints-content.tsx`（NEW）：把 `/salon/prints` 現有 UI（打印機群組 / 測試打印）搬入此元件。
- `settings.tsx`：`TABS` 加「打印」tab，渲染 `PrintsContent`。
- `/salon/prints` 頁面改為渲染同一 `PrintsContent`（保留路由，避免舊書籤壞）；或直接移除路由。
- `salon-sidebar.tsx`：**移除** `{ href: "/salon/prints", label: "打印", short: "印" }`。

---

## 四、左 bar 最終項目（移除 2 + 新增 1）

| 前 | 後 |
|---|---|
| 工作台 / 預約看板 / 快速開單 / 客戶檔案 / 報表 / 打印 / 設置（7） | 工作台 / 快速開單 / 客戶檔案 / 產品 / 報表 / 設置（6） |

- 移除：預約看板（→ 工作台內，F6）、打印（→ 設置 tab，F7）
- 新增：產品（F4）

---

## 五、資料流與 Ledger 接縫

```
設置 (staffLevelMultipliers / 服務細項.wages / 員工.level)
   └─saveSalonBootstrap─> bootstrap ─(結帳讀 loadSalonBootstrap)
                                                       │
checkout 組裝 order items ─computeStaffWage─> item.wageAmount ─> 訂單存檔
                                                       │
員工詳情頁 ─loadSalonOrders─> 加總 wageAmount（工錢匯總）─┐
                                                       │
賣產品流程 ─saveSalonProductSales(SalonProductSale)─────┤─> 員工詳情 佣金匯總
   │                                                    │     客戶檔案 購買產品
   └─commissionAmount = round(price × commissionRate/100)
```
- 工錢 / 佣金均為本地計算（MOP），暫唔上 Ledger；留 `SalonProductSale.commissionAmount` / `SalonOrderItem.wageAmount` 字段，真後端到位可匯出報表 / 對帳。
- 員工仍然 label-only，唔登入；狀態 / 放假 / shift 僅作記錄與展示，唔影響 auth。

---

## 六、實施順序（建議）

1. **類型 + 輔助 + 種子/遷移**（§3.1–3.2）：所有新類型、labels、wages helper、storage 讀寫、mock 補 `level`/`status`/`staffLevelMultipliers`/`products`。
2. **F5 檔案號碼**：最小改動，先過。
3. **F1 + F3 工錢 + 級別**：服務細項表單加 wages、員工表單加 level、設置加倍率、checkout 計 `wageAmount`。
4. **F4 賣產品**：目錄 + 賣產品流程 + 雙介面顯示 + 左 bar tab。
5. **F2 員工管理頁**：列表 + 詳情（狀態 / 放假 / shift / 工作記錄 / 工錢 / 佣金）。
6. **F6 看板入工作台** + 左 bar 移除看板。
7. **F7 打印入設置** + 左 bar 移除打印。

每步後 `tsc --noEmit` 驗證（沙盒唯一已知誤報仍是 `src/app/layout.tsx` 的 `LayoutProps`）；最終交用戶 dev box `npm run lint && npm run build` + push Vercel。

---

## 七、已知 gap / 風險

- 工錢倍率為乘數（可填 0.5 / 1.5 等小數），`computeStaffWage` 最終 `Math.round` 取整。
- 服務細項未設某職位工錢（該職位執行時 `wageAmount = 0`）屬預期；商家應於服務表單補齊。
- 產品銷售暫不併入結帳單（獨立 `SalonProductSale`），故產品收入唔入 `SalonPosOrder` 報表；如需併入，後續可於 checkout 加「加產品」或報表合計兩源。
- 員工狀態 `on_leave` / `terminated` 僅展示，唔自動擋開單 / 排班（避免過度限制），留待後續 rule。
- 放假 / shift 為 log 形式記錄，無週排班 grid；未來要做週曆可基於 `SalonStaffShift.date` 擴充。
- 舊店升級：`ensureSalonBootstrap` 自動補 `level` / `status` / `staffLevelMultipliers` / `products`，無須重種。
- 全部改動待用戶 dev box build + push；Phase 8 忠誠度 3 功能同樣未 push。
