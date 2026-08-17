# 30 · Salon 會員忠誠度 3 功能（推薦獎勵 / 生日彈性優惠 / 每店積分配比）

> 日期：2026-08-17
> 背景：用戶要求美容院加 3 個會員功能 → ① 推薦獎勵（客人推薦別人得積分）；② 生日彈性折扣 / 積分倍率；③ 每店積分配比（pointsPerDollar）。本文記錄設計決策、資料模型、實施落點。
> 約定：不動餐飲；salon 代碼落在 `src/app/salon/`、`src/components/salon/`、`src/lib/salon/`；積分 / 餘額 / 等級仍由 Ledger 主導，POS 端經 `mock-ledger.ts` 模擬（earn 複用 `applyMockLedgerBonus`）。

---

## 一、設計決策（經用戶確認）

用戶原話（message 9→10）三點，逐條確認如下：

### 1.1 推薦獎勵
- **時機**：被推薦人「**首次結帳**」才發（防刷分——避免推薦人反覆刷分）。
- **得分對象**：**只有推薦人得分**；被推薦人無 welcome 分。
- **設定**：商家可開關 `referralEnabled` + 自定 `referralPoints`（預設 100）。

### 1.2 生日彈性優惠
- **窗口商家自定**：當月生日（`month`）或當週生日（`week`）。
- **折扣% 與 積分倍率 各自獨立**：兩個數值分開設定，任填 0 即關閉該項。例如折扣 10% + 倍率 2 = 當月生日享 9 折且賺雙倍積分。
- **逐單可控**：結帳時命中生日窗口自動套用，店員可於本單關掉（例如客人不想用）。

### 1.3 每店積分配比
- Ledger 角度為 1 元 1 分，但各店可彈性：設定 `pointsPerDollar`（每消費多少 MOP 得 1 分），預設 1。
- 結帳賺分 = `floor(grandTotal / pointsPerDollar)`。

---

## 二、資料模型（src/lib/salon/types.ts）

### 2.1 會員優惠設定（新增 `SalonLoyaltySettings`）
```ts
SalonLoyaltySettings {
  pointsPerDollar: number        // 每消費多少 MOP 得 1 分（預設 1 = 1 元 1 分）
  referralEnabled: boolean       // 推薦獎勵開關
  referralPoints: number         // 推薦獎勵積分（發給推薦人）
  birthdayEnabled: boolean       // 生日優惠開關
  birthdayWindow: "month" | "week"   // 當月 / 當週
  birthdayDiscountPercent: number    // 生日折扣%（0 = 關閉折扣）
  birthdayPointsMultiplier: number   // 生日積分倍率（0 = 關閉多倍；1 = 不變；2 = 雙倍）
}
```
- `SalonBootstrap` 加 `loyalty?: SalonLoyaltySettings`（可選，舊店家經 storage 遷移補預設，見 §四）。

### 2.2 客戶檔案推薦欄位（`SalonCustomerProfile`）
```ts
referrerId?: string      // 推薦人客戶 id（本客戶由誰推薦）
referralRewarded?: boolean  // 推薦獎勵是否已發出（防刷分：僅首次結帳發一次）
```

### 2.3 訂單賺分 / 生日標記（`SalonPosOrder`）
```ts
pointsEarned?: number    // 本次結帳賺取積分（依 pointsPerDollar，生日窗口內乘倍率）
birthdayDiscount?: boolean  // 本次是否套用生日折扣
```

---

## 三、實施落點

### 3.1 預設 seed（src/lib/salon/mock-data.ts）
- 新增 `DEFAULT_SALON_LOYALTY`：`pointsPerDollar:1`、`referralEnabled:true`、`referralPoints:100`、`birthdayEnabled:true`、`birthdayWindow:"month"`、`birthdayDiscountPercent:10`、`birthdayPointsMultiplier:2`。
- `defaultSalonBootstrap` 加 `loyalty: DEFAULT_SALON_LOYALTY`。

### 3.2 舊店家遷移（src/lib/salon/storage.ts）
- `ensureSalonBootstrap`：讀到舊 `bootstrap`（無 `loyalty`）時，補 `DEFAULT_SALON_LOYALTY` 並寫回。不動其他設定，不需重種即可啟用 3 功能。

### 3.3 設置頁「會員優惠」tab（src/components/salon/settings.tsx）
- `TABS` 加第 6 個 tab「會員優惠」（位於套票模板之後、開發工具之前）。
- 區塊一「積分配比（每店）」：`pointsPerDollar` 數字輸入。
- 區塊二「推薦獎勵」：啟用開關 + `referralPoints` 數字（停用時 disabled）。
- 區塊三「生日優惠」：啟用開關 + 窗口 select（當月/當週）+ `birthdayDiscountPercent` + `birthdayPointsMultiplier`，各項停用時 disabled；說明「折扣% 與倍率各自獨立，填 0 = 關閉」。
- 統一走既有的 `patchLoyalty` → `patchBootstrap` → `saveSalonBootstrap`（進 sync 佇列、多終端同步），不引入新依賴。

### 3.4 結帳整合（src/components/salon/checkout.tsx）
- 模組級 helper：`isoWeek(date)`（ISO 週序）、`isBirthdayInWindow(birthday, window)`（當月比 month / 當週比 `isoWeek`）。跨年生日視為「今年」生日與今天比。
- `loyalty = loadSalonBootstrap()?.loyalty ?? DEFAULT_SALON_LOYALTY`（memo）。
- `customer`：依 `booking.customerId` 或 `booking.customerPhone` 解析客戶檔案（讀 `referrerId` / `birthday`）。
- `birthdayMatched`：窗口是否命中（未計本單開關）；`birthdayActive = birthdayMatched && birthdayApplied`（新 state `birthdayApplied`，每單預設 true，切換預約時重置）。
- `birthdayDiscountAmount`：命中且 `birthdayDiscountPercent > 0` → `round(subtotal × pct/100)`；併入 `afterDiscount`（小計減免）。
- `pointsEarned`：`floor(grandTotal / pointsPerDollar)`；命中且 `birthdayPointsMultiplier > 0` 時乘倍率；`Math.floor` 取整。
- **UI**：折扣區塊內命中窗口時顯示粉色「生日優惠」卡（當月/當週 + 折扣 + 倍率 + 套用中/已關閉開關）；結算摘要加「生日折扣 -X」行與「預計賺分 +N 分（生日 ×M）」行；結帳成功頁顯示「本單賺取 N 分」。
- **`handleSettle`**：
  1. 推薦獎勵（1c）：若 `customer.referrerId` 且 `!customer.referralRewarded` 且 `referralEnabled` 且 `referralPoints > 0` → 找 referrer 客戶 → `applyMockLedgerBonus(referrer.phone || referrer.id, { points: referralPoints })`；並把本客戶 `referralRewarded` 標 true 寫回 `saveCustomers`（防重複發分）。
  2. 消費賺分（1d）：`pointsEarned > 0 && customer` → `applyMockLedgerBonus(customer.phone || customer.id, { points: pointsEarned })`。
  3. 訂單寫 `pointsEarned` / `birthdayDiscount`。
- 依賴陣列補 `customer / loyalty / birthdayDiscountAmount / pointsEarned`。

### 3.5 客戶檔案推薦人（src/components/salon/customer-profile.tsx）
- 新增「推薦人」區塊：下拉選擇現有客戶（排除自己）作 `referrerId`，`persist` 寫回；顯示推薦人姓名 / 電話 + 是否已發獎勵（`customer.referralRewarded`）。說明「首次結帳時推薦人獲推薦積分（僅推薦人得分，防刷分）」。

### 3.6 收據（src/lib/salon/print.ts）
- `buildReceiptLines`：`order.birthdayDiscount` → 加「生日折扣 · 已享生日優惠」行；`order.pointsEarned > 0` → 加「本次賺分 +N 分」行。

---

## 四、資料流與 Ledger 接縫

```
設置頁 (loyalty) ──saveSalonBootstrap──> bootstrap.loyalty ──(結帳讀 loadSalonBootstrap)──┐
                                                                                          │
客戶檔案 (referrerId) ──saveCustomers──> SalonCustomerProfile.referrerId ─────────────────┤
                                                                                          │
結帳 handleSettle ──> 命中 -> applyMockLedgerBonus(referrer/customer, {points}) ──(mock 層)─┤
                      │           寫入客戶 ledgerPoints（本地模擬 Ledger 餘額/積分）          │
                      └──> 訂單寫 pointsEarned / birthdayDiscount ──> 收據顯示               │
                                                                                          │
真 Ledger RPC 到位後：只換 applyMockLedgerBonus 實作為呼叫 RPC，其餘 UI / 結帳邏輯不動。    │
```

- **舊店家升級**：`ensureSalonBootstrap` 自動補 `loyalty` 預設，無須重種。
- **防刷分**：`referralRewarded` 標記在首次結帳後即寫入，重複結帳不重複發。
- **生日窗口**：`month` 比 `getMonth()`；`week` 比 `isoWeek()`（ISO 週序，跨年生日視為今年生日）。

---

## 五、已知 gap / 風險

- Ledger 仍是 mock 層；推薦分 / 賺分 / 生日倍率分僅寫本地客戶檔案 `ledgerPoints`，真 RPC 接通後生效。
- 推薦獎勵依 `customer.referrerId` 解析 referrer；若預約為 walk-in 且未關聯客戶（無 `customerId`、電話不在客戶清單），則無法解析 referrer，不發分（屬預期：推薦須雙方皆為客戶）。
- 生日倍率為乘數（可填 0.5 / 1.5 等小數），`pointsEarned` 最終 `Math.floor` 取整，避免出現小數分。
- `birthdayDiscountAmount` 基於 `subtotal`（小計），與手動折扣各自獨立從 `afterDiscount` 減除；極端情況（整單折到 0）`grandTotal` 已 clamp 0，賺分亦為 0。
- 收據「本次賺分」為展示資訊，實際積分以 Ledger 為準。
- 沙盒 `tsc --noEmit` 僅餘 `src/app/layout.tsx` 的 `LayoutProps` 誤報（next build 生成之全局型別，與本輪無關）；其餘 salon 忠誠度檔案零錯誤。仍待用戶 dev box `npm run lint && npm run build` + push Vercel 驗證。

---

## 六、待 push 提醒

- 本輪 3 功能（types / mock-data / storage 遷移 / settings tab / checkout 整合 / customer-profile 推薦人 / print 收據）全部改動尚未 push。請本地 `npm run lint && npm run build` 確認無迴歸後 `git add -A && commit && push` 觸發 Vercel。
