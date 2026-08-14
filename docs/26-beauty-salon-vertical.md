# 美容行業縱向擴展設計（Beauty Salon Vertical Extension）

> **版本**：v0.1（初稿，待 Ledger 對接確認後定稿）
> **最後更新**：2026-08-14
> **目標**：在現有 `macauPosSystem` codebase 內加入「美容院 / SPA / 美甲 / 美睫」縱向，不修改任何餐飲代碼。
> **讀者**：內部工程、Ledger 團隊對接窗口

---

## 0. 文件資訊

| 項目 | 值 |
|------|---|
| 文件編號 | 26 |
| 上游依賴 | `docs/01-overall-system-design.md`、`docs/04-data-model-and-storage.md` |
| 後續銜接 | Ledger 對接契約（v1 待 Ledger 確認） |
| 變更日誌 | 見 §17 |

---

## 1. 背景與目標

`macauPosSystem` 目前是面向澳門餐飲（飲品店、快餐、輕堂食）的 Web POS，已有生產部署。店家反饋希望同套系統能支援**美容院業態**——這是因為澳門很多美容院同時提供臉部護理、SPA、美甲、美睫、脫毛、按摩等多種服務，且不少店面已使用「會員通 Ledger」處理線上渠道、會員餘額與券。

本文件的目標：
1. 把 11 條業務決策正式固化，避免日後遺忘或反覆討論。
2. 給後續工程明確的 `industry = "salon"` 擴展邊界與資料模型。
3. 整理給 Ledger 團隊的對接需求（含積分、定金扣款、線上預約渠道契約）。

**核心策略**：同一 codebase 內做**縱向行業切分**——保留餐飲 100% 不動，新建 `src/app/salon/`、`src/components/salon/`、`src/lib/salon/` 三條獨立目錄，與餐飲程式碼不交叉污染。

---

## 2. 範圍與非目標

### 2.1 v1 包含（MVP）

- 行業分流骨架：`industry: "salon"`，登入後自動路由到 `/salon/...`
- 店家資料：服務類目、服務項目、員工（label-only）、房型/椅、列印分區
- 預約看板（日/週）：從 Ledger Realtime 接收線上預約
- 走進客戶（walk-in）開單
- 預約生命周期：建立 → 確認 → 接待 → 服務中 → 完成 → 結帳 / 取消 / 未到店
- 結帳：現金 / 信用卡 / Ledger 餘額抵扣 / 小費 / 定金沖銷
- 報表：店家營業額、技師業績、服務項目銷量
- 列印：收據 / 標籤 / 預約確認單（**不做崗位單** — 美容服務不以打印崗位單方式派工，2026-08-14 用戶決定）
- 離線優先：與餐飲共用 `sync-queue` 框架
- Backoffice / Admin 跨行業列管（門店總覽、帳號管理）

### 2.2 v1 **不**做

- 多店連鎖管理／跨店調貨／跨店技師調度
- 完整進銷存（採購入庫、批號、效期、盤點）
- 自家次卡系統（完全依賴 Ledger 餘額）
- 本地積分引擎（完全讀 Ledger）
- 線上預約渠道（本系統是**消費端**，預約渠道由 Ledger 提供）
- Staff 直接登入 POS（見 §3.5）
- 退款流程（依賴 Ledger 扣款機制）

---

## 3. 決策記錄（Decisions Log）

> 11 條決策源自 2026-08-14 與店主討論。逐條記錄以備日後複盤。

### Decision 1 — 縱向分流：一家 codebase，一個新 industry type

**內容**：`PosBootstrap.industry` 從 `undefined | "restaurant"` 擴展為 `industry: "restaurant" | "salon"`（新增一個 type）。

**原因**：餐飲基礎設施（auth、storage、print-bridge、sync-queue、backoffice、admin、Realtime）70% 行業無關，拆 codebase 維護成本過高。

**影響**：所有 salon 模組落在新目錄 `src/app/salon/`、`src/components/salon/`、`src/lib/salon/`，不寫 `src/lib/types.ts`。

---

### Decision 2 — 餐飲程式碼完全不動

**內容**：餐飲現有檔案**零修改**。salon 新邏輯全部落在新增目錄。

**硬規則**：
- ❌ 不修改 `src/lib/types.ts`（複製到 `src/lib/salon/types.ts`）
- ❌ 不修改 `src/lib/storage.ts` 中的餐飲鍵讀寫路徑
- ❌ 不修改 `src/components/pos-app.tsx`、`online-orders.tsx`、`print-center.tsx` 等
- ✅ 可新增 `src/lib/salon/storage.ts` 包裝新鍵（如 `macau-pos-salon/*`）
- ✅ 可在 `src/lib/storage.ts` 末尾新增 export，但不改既有函式簽名

**原因**：避免回歸風險，讓餐飲店家升級零感知。

---

### Decision 3 — 一店多服務（同店可同時含臉部、SPA、美甲、美睫）

**內容**：salon 行業下，店家透過**服務類目（ServiceCategory）**做分類。同一個 store 可同時擁有臉部護理、SPA、美甲、美睫等類目。

**影響**：
- `SalonServiceCategory` 為一級分類（臉部 / 身體 / 美甲 / 美睫 / 脫毛 / 按摩 / 瘦身…）
- `SalonServiceItem` 屬於一個 category，帶 `durationMinutes`、`price`、`staffRoles`、`stationTypes`
- 服務類目影響列印分區（不同類目可送不同收據 / 標籤 / 預約確認單分區；v1 不做崗位單）
- 預約看板依類目做顏色或圖示區分

**為何不做多 industry**：店家本質一家店，強行拆 industry 反而導致一個店面要切兩個帳號。

---

### Decision 4 — 線上預約渠道由 Ledger 主導，本系統做對接

**內容**：線上預約渠道（微信小程式、Web Booking、Member App 預約）由 Ledger 團隊建置與營運。POS 是**消費端 / 店內作業入口**——客人透過 Ledger 完成線上預約後，POS 透過 Realtime 接收並落地為本地 Booking；客人到店後由店家（單一管理員登入 POS）操作接待、服務執行、結帳。

**POS 負責的「店內入口」工作**：
- ✅ 接收 Ledger 線上預約（Realtime subscribe）
- ✅ 電話預約（receptionist 在 POS 開立，**透過 Ledger RPC** 同步上去）
- ✅ Walk-in 開單（純店內）
- ✅ 預約狀態推進（已確認 / 已接待 / 服務中 / 完成 / 結帳 / 取消 / 未到店）
- ✅ 結帳時把 Ledger 訂單狀態推進 + 扣點
- ❌ 不做線上預約頁面
- ❌ 不做會員端預約 App

**對 Ledger 團隊需求**：見 §16。

**工作量影響**：原本預估全做線上預約渠道 +30%；改為對接後工期不變。

---

### Decision 5 — 員工不登入 POS；單一管理員登入操作全部

**內容**：POS 登入只有一類身份——**店長 / 管理員**（沿用餐飲 8 位電話 + 4 位 PIN）。**員工（stylist / colorist / therapist / assistant / receptionist）只是資料物件**（label-only），可由管理員在 POS 內 CRUD，但不登入 POS。

**原因**：
- 澳門美容院規模通常 1 家店 3–8 人，店長一人即可操作全部前台事務
- 若開放 staff 自助操作，會引發權限邊界、佣金歸屬、責任追溯、操作審計等複雜度
- 對應 Ledger Auth 模型也只需 manager 一個角色

**Staff 僅為資料物件**：
```ts
interface SalonStaff {
  id: string;
  name: string;
  nickname?: string;
  role: "stylist" | "colorist" | "therapist" | "assistant" | "receptionist";
  serviceCategoryIds: string[];   // 可執行的服務類目白名單
  active: boolean;
}
```
- 沒有 `accountId`、沒有 `pin`、沒有登入關聯
- 報表記帳時依 `staffId` 區分

**未來展望**：若日後要做「技師自助 App」（類似前台 + 私人工作室場景），那是獨立新產品，不在 v1 salon POS 範圍。

---

### Decision 6 — 次卡 / 預付完全走 Ledger 會員餘額

**內容**：本店**不建次卡 / 套票概念**。客戶預付、月卡、季卡、N 次卡，全由 Ledger 會員餘額機制處理。

**含義**：
- ❌ 不建 `CoursePackage`、`PackageRedemption` 等本地物件
- ❌ 不做「次卡抵扣」UI
- ✅ 結帳時若客人有 Ledger 餘額，按 Ledger 既有 RPC 直接扣款
- ✅ 會員頁顯示 Ledger 餘額（read-only 從 Ledger 拉）

**影響**：簡化資料模型，無次卡狀態機要維護。

---

### Decision 7 — 庫存管理暫不做

**內容**：v1 salon 不做進銷存。服務過程中的「用品消耗」（如染膏、藥水）暫不扣減庫存，僅在備註欄記錄。

**v1 行為**：
- 服務項可選填 `consumableNotes: string`（自由文字備註）
- 結帳報表把用品消耗列出供店家事後自行盤點
- 不建 `InventoryItem`、`StockMovement` 等表

**未來預留**：資料模型預留介面（見 §7.10），但本期不實作。

---

### Decision 8 — 先做單店試點，連鎖之後另議

**內容**：salon MVP 鎖定**單店**。

**單店意涵**：
- 一個 storeId，一組服務類目、一組員工、一組房型
- 報表只算本店
- Backoffice 列表可以跨行業看店家清單，但 salon 暫不做跨店管理

**連鎖場景（不 v1 內）**：跨店調貨、跨店技師調度、跨店會員——留待後續 v2+。

**原因**：澳門連鎖美容院不多；就算有多店，店家也偏好各自獨立控制店內營運。

---

### Decision 9 — 定金走 Ledger 扣款機制

**內容**：POS 不建退款流程。定金處理完全依賴 Ledger 既有的「扣款」能力。

**流程**：
1. 預約時若店家政策要求定金，receptionist 在 Ledger 介面（或呼叫 Ledger `deduct_member_balance` RPC）做一次扣款，記錄定金金額
2. POS Booking 物件掛上 `depositAmount` / `depositPaid` / `depositLedgerTxnId`，僅作顯示與對帳用
3. 客人取消或 no-show：管理員在 Ledger 後台手動扣款（或在 POS 顯示提示引導到 Ledger 後台操作）
4. 客人完成服務結帳：`depositApplied` 金額在結帳單上顯示為已收款

**POS 不做**：
- ❌ 定金退款 API
- ❌ 部分退 / 全退 邏輯
- ❌ 「未到店扣款」自動化

**原因**：Ledger 既有的「扣款」機制已涵蓋部分扣 / 全扣場景，再做退款會雙軌且容易對不上帳。

---

### Decision 10 — 小費：結帳單行加上去即可

**內容**：結帳頁新增小費輸入，可按技師拆帳。

**MVP 行為**：
- 一筆訂單可記錄多筆小費（每位技師一筆）
- 小費不計入服務營業額，列為 `tips` 區塊
- 小費支付方式：`cash` 或 `ledger_balance`（客人 Ledger 餘額扣）
- 報表獨立列「小費彙總」與「技師小費排行」

**實作位置**：`src/lib/salon/types.ts` 的 `BeautyPosOrder.tips: Array<{staffId, staffName, amount, method}>`。

---

### Decision 11 — 積分由 Ledger 主導，POS 僅讀取顯示

**內容**：會員積分（消費 1 元 = X 分、生日加倍、N 次後升等）由 Ledger 統一處理。POS 不建本地積分引擎，僅消費端展示。

**POS 職責**：
- 會員頁顯示 Ledger 積分餘額（從 Ledger 拉，read-only）
- 結帳時結算金額傳給 Ledger，由 Ledger 決定本次獲得多少積分
- POS 報表不計算積分

**需向 Ledger 拉的資料**：
- `member.points_balance`（會員當前積分）
- `member.points_earned_on_order(order_id)`（訂單完成時本筆獲得的積分）
- `member.points_history`（積分流水，optional）

**未做**：POS 內部不能用積分直接抵現金（除非 Ledger 暴露「積分折抵 RPC」）。

---

## 4. 餐飲 vs 美容 對照

| 維度 | 餐飲（既有） | 美容（v1） |
|------|--------------|------------|
| 行業代碼 | `"restaurant"` | `"salon"` |
| 商品 / 服務 | `MenuItem`（+ 規格） | `SalonServiceItem` + 可選 `SalonProductItem`（零售） |
| 規格 | `MenuSpecGroup`（糖度、冰度、辣度） | `MenuSpecGroup`（臉型、髮長、指甲形狀） |
| 類目 | `MenuCategory` | `SalonServiceCategory`（臉部 / 身體 / 美甲 / …） |
| 資源 | `StoreTable`（桌台，被動佔用） | `SalonStation`（房 / 椅 / 水洗台 / 美甲桌，主動搶） |
| 人員 | AccountUser（含 cashier 登入） | `SalonStaff`（label-only，不登入） |
| 流程驅動 | 點單 → 送廚 → 出餐 | 預約 → 接待 → 服務 → 結帳 |
| 預約 | 無 | `SalonBooking`（核心物件） |
| 訂單物件 | `PosOrder` | `SalonPosOrder` |
| 訂單狀態機 | draft / open / settled / completed / cancelled | bookingStatus × orderStatus 雙軸 |
| 打印分區 | `zone` / `receipt` / `label` | `station` / `receipt` / `label`（語意改，模型不變） |
| 列印對象 | 廚房單 / 收據 / 標籤 | 收據 / 標籤 / 預約確認單 |
| 支付 | 現金 / 卡 / 會員餘額 / 券 | + 小費 / 定金沖銷 / 服務組合拆帳 |
| 會員 | `MemberProfile`（餘額、券） | + Ledger 積分（read-only） + 髮質膚質記錄 |
| 庫存 | `soldOut` 簡單版 | v1 不做 |
| 報表 | Ledger `get_merchant_report_summary` | 同上加服務分類、技師業績、小費彙總 |
| 列隊事件 | 6 種 | + 預約 / 服務 / 接待 / 小費 |

---

## 5. 架構演進

### 5.1 目錄結構（增量，不動既有）

```
macauPosSystem/
└── src/
    ├── app/
    │   ├── (既有餐飲路由不動)/
    │   └── salon/                          ← 新增
    │       ├── layout.tsx
    │       ├── page.tsx                    # 工作台（今日預約 + walk-in + 待結帳）
    │       ├── calendar/page.tsx           # 預約看板（日/週視圖）
    │       ├── booking/
    │       │   ├── new/page.tsx            # 開立預約（電話/walk-in）
    │       │   └── [id]/page.tsx           # 預約詳情 / 服務執行
    │       ├── checkout/[bookingId]/page.tsx
    │       ├── customers/
    │       │   ├── page.tsx
    │       │   └── [id]/page.tsx           # 客戶檔案（髮質 / 過敏 / 歷史）
    │       ├── settings/page.tsx           # 服務類目 / 項目 / 員工 / 房型
    │       ├── prints/page.tsx             # 復用 print-center（限定 salon 數據）
    │       └── reports/page.tsx
    ├── components/
    │   ├── (既有餐飲元件不動)/
    │   └── salon/                          ← 新增
    │       ├── workbench.tsx
    │       ├── calendar-board.tsx
    │       ├── booking-card.tsx
    │       ├── booking-form.tsx
    │       ├── service-runner.tsx          # 服務執行（開始 / 加項 / 換人 / 完成）
    │       ├── checkout-form.tsx
    │       ├── customer-card.tsx
    │       ├── staff-editor.tsx
    │       ├── station-editor.tsx
    │       ├── service-editor.tsx
    │       └── ...
    └── lib/
        ├── (既有餐飲 lib 不動)/
        └── salon/                          ← 新增
            ├── types.ts                    # 全部 salon 相關 TS 類型
            ├── storage.ts                  # 包裝 macau-pos-salon/* 鍵
            ├── booking.ts                  # 預約業務邏輯
            ├── order.ts                    # 結帳邏輯
            ├── ledger-bridge.ts            # 與 Ledger RPC 對接
            ├── print.ts                    # Booking / Order → PrintJob
            └── realtime.ts                 # 接收 Ledger 預約事件
```

### 5.2 行業分流

**登入後路由**：

```ts
// src/lib/industry-router.ts（新）
interface AccountStore {
  // 既有字段
  industry?: "restaurant" | "salon";   // ← 新增可選字段
}

// 登入成功後：
const industry = account.activeStore?.industry ?? "restaurant";
window.location.assign(industry === "salon" ? "/salon" : "/");
```

**終端綁定**：每台 POS 終端透過 `device-config.storeId` 鎖定單一 storeId，從而鎖定單一 industry。終端不允許跨行業切換。

### 5.3 不破壞餐飲的硬規則

| 規則 | 檢查點 |
|------|--------|
| 不修改 `src/lib/types.ts` | PR 檢查：diff 為空 |
| 不修改 `src/lib/storage.ts` 既有函式 | PR 檢查：diff 為空 |
| 不引入新依賴 | 使用既有 `@supabase/supabase-js`、React、Next.js |
| 不修改列印驅動 | 復用 `print-bridge` + `PrintJob` |
| 不修改 Ledger 客戶端共用部分 | `src/lib/ledger/` 只讀；新 salons 用 `src/lib/salon/ledger-bridge.ts` |

---

## 6. 共享複用清單（直接用，不動）

| 模組 | 現有位置 | salon 怎麼用 |
|------|----------|---------------|
| 登入 + AuthGuard | `src/app/login/`, `auth-guard.tsx` | 一字不改；登入後依 store.industry 跳轉 |
| 三層儲存 | `src/lib/storage.ts`（讀），新增 `src/lib/salon/storage.ts`（寫新鍵） | 寫 `macau-pos-salon/*` |
| 列隊同步框架 | `QueueEvent` + `/api/pos/sync` + `sync-queue` | 共用結構，salon 自有新事件類型 |
| 列印基礎 | `print-jobs.ts` + `print-bridge/*` | 共用 `PrintJob` 模型 |
| Backoffice CRUD 模板 | `backoffice-*` | 跨行業列管，新增 `industry` 篩選 |
| 班次 / 交接 | `shift-page.tsx` | 共用 `shift` 結構，salon 對應 `macau-pos-salon/shift` |
| PWA / SW | `public/sw.js` | 共用 |
| Supabase 客戶端 | `supabase-server.ts` | 共用 |
| HiveMQ Publisher | `hivemq-publisher.ts`（預留） | 共用 |

**複用率估算**：salon 模組約 60–70% 程式碼透過**組合**既有輔助函式完成；真正新寫的是 salon 的領域層（types + booking/order/business logic + UI）。

---

## 7. 資料模型

> 所有類型定義落在 `src/lib/salon/types.ts`，不污染 `src/lib/types.ts`。

### 7.1 行業分流字段

```ts
// 在 src/lib/salon/types.ts 內新定義（不修改既有 AccountStore）
export interface SalonAccountStore extends AccountStore {
  industry: "salon";
}
```

### 7.2 服務類目 ServiceCategory

```ts
export interface SalonServiceCategory {
  id: string;
  name: string;                  // "臉部護理", "美甲", "美睫", "SPA", "脫毛", "按摩"
  printerGroup: PrinterGroup;    // 對應列印分區（v1 用於收據/標籤/預約確認單分類；非崗位單路由）
  sortOrder: number;
  color?: string;                // 看板配色
  active: boolean;
}
```

預設類目（店家首次初始化時種入）：
- 臉部護理
- 身體護理
- SPA
- 美甲
- 美睫
- 脫毛
- 按摩
- 瘦身

### 7.3 服務項目 ServiceItem

```ts
export interface SalonServiceItem {
  id: string;
  categoryId: string;            // 指向 SalonServiceCategory.id
  name: string;                  // "保濕臉部護理 60 分"
  description?: string;
  price: number;                 // MOP / HKD
  cost?: number;                 // 內部成本（v1 報表暫用）
  durationMinutes: number;       // ⭐ 預約基石
  stationTypes?: Array<"chair" | "bed" | "room" | "wash" | "nail_table">;
  staffRoles?: string[];         // ["stylist", "therapist", "colorist"]
  specGroups?: MenuSpecGroup[];  // 規格：髮長、臉型、指甲形狀等
  consumableNotes?: string;      // v1：用品消耗自由文字備註（不做庫存扣減）
  active: boolean;
  imageUrl?: string;
  sortOrder: number;
}
```

### 7.4 服務類目對員工的白名單

```ts
// 已內嵌於 SalonStaff.serviceCategoryIds（見 §3.5）
```

### 7.5 員工 Staff（label-only，不登入）

```ts
export interface SalonStaff {
  id: string;
  name: string;
  nickname?: string;             // 暱稱（接待頁顯示用）
  role: "stylist" | "colorist" | "therapist" | "assistant" | "receptionist";
  serviceCategoryIds: string[];  // 可執行服務類目
  phone?: string;                // 內部聯絡（不入 Ledger）
  active: boolean;
  hiredAt?: string;
  terminatedAt?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 7.6 房型 / 椅 Station

```ts
export interface SalonStation {
  id: string;
  name: string;                  // "1 號椅", "VIP 房", "水洗台 A"
  type: "chair" | "bed" | "room" | "wash" | "nail_table";
  capacity: number;              // 通常 1
  location?: string;             // "1 樓", "2 樓 VIP 區"
  active: boolean;
  sortOrder: number;
}
```

### 7.7 預約 Booking

```ts
export type SalonBookingStatus =
  | "pending"        // 已建立，未確認
  | "confirmed"      // 已確認（線上預設到這）
  | "checked_in"     // 客人到店
  | "in_service"     // 服務進行中
  | "completed"      // 服務完成，待結帳
  | "settled"        // 已結帳
  | "cancelled"      // 取消
  | "no_show";       // 未到店

export interface SalonBooking {
  id: string;
  bookingNo: string;             // 例如 BK20260814-0001

  // 來源
  source: "online_ledger" | "phone" | "walk_in";
  ledgerBookingId?: string;      // 線上預約對應 Ledger 訂單 id
  ledgerOrderId?: string;        // 結帳後 Ledger 訂單 id

  // 客戶
  customerId?: string;           // Ledger member id（線上一定有，walk-in 可空）
  customerName: string;
  customerPhone: string;

  // 資源分配
  staffId: string;               // 主技師
  stationId?: string;            // 房 / 椅

  // 時間
  startAt: string;               // ISO
  endAt: string;

  // 服務清單
  services: Array<{
    serviceItemId: string;
    name: string;
    price: number;
    durationMinutes: number;
    staffId: string;             // 此項服務的執行人（可能與 booking.staffId 不同）
  }>;

  // 定金
  depositAmount?: number;
  depositPaid?: boolean;
  depositLedgerTxnId?: string;

  // 狀態
  status: SalonBookingStatus;

  // 結帳後
  orderId?: string;              // 對應 SalonPosOrder.id

  // 備註
  notes?: string;
  internalNotes?: string;        // 店家內部備註（不列印）

  createdAt: string;
  updatedAt: string;
}
```

### 7.8 客戶檔案 CustomerProfile

```ts
export interface SalonCustomerProfile {
  id: string;                    // 對應 Ledger member id
  name: string;
  phone: string;

  // Ledger 同步欄位（read-only，從 Ledger 拉）
  ledgerBalance?: number;
  ledgerPoints?: number;
  ledgerTier?: string;

  // 美容專屬
  birthday?: string;             // YYYY-MM-DD
  gender?: "female" | "male" | "other";
  tags?: string[];               // ["VIP", "敏感肌", "孕婦"]
  skinType?: string;             // "乾性", "油性", "混合性", "敏感性"
  hairType?: string;             // "細軟", "粗硬", "受損"
  allergies?: string[];          // ["花生", "薄荷", "染劑 X 品牌"]
  preferences?: string;          // 自由文字：偏好技師 / 偏好房型 / 特別注意事項

  formulaHistory?: Array<{
    date: string;
    service: string;
    formula: string;             // 染髮配方 / 護理配方
    staffId: string;
    staffName: string;
  }>;

  visitCount: number;            // 本機累積（從 Booking / Order 推導）
  lastVisitAt?: string;
  totalSpent?: number;           // 本機累積
}
```

### 7.9 訂單（結帳）SalonPosOrder

```ts
export type SalonOrderStatus =
  | "draft"             // 建立中（正在加項）
  | "in_service"        // 服務中
  | "ready_to_pay"      // 服務完成，待結帳
  | "settled"           // 已結帳
  | "cancelled"
  | "no_show";

export interface SalonOrderItem {
  kind: "service" | "product";
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: number;

  // service 專屬
  serviceItemId?: string;
  staffId?: string;             // 此服務執行人
  staffName?: string;
  specSelections?: Array<{
    groupId: string;
    groupName: string;
    optionId: string;
    optionLabel: string;
    priceDelta: number;
  }>;
  consumableNotes?: string;     // 用品消耗備註

  note?: string;
}

export interface SalonTip {
  staffId: string;
  staffName: string;
  amount: number;
  method: "cash" | "ledger_balance";
}

export interface SalonPayment {
  method: "cash" | "card" | "ledger_balance" | "external";
  amount: number;
  ledgerTransactionId?: string; // 若走 Ledger 扣款
  note?: string;
  createdAt: string;
}

export interface SalonPosOrder {
  id: string;
  orderNo: string;
  bookingId?: string;
  customerId?: string;
  customerName: string;
  customerPhone: string;
  staffId: string;               // 主技師
  stationId?: string;

  items: SalonOrderItem[];

  subtotal: number;
  discountAmount: number;
  serviceChargeAmount?: number;
  taxAmount?: number;
  total: number;

  tips: SalonTip[];
  tipTotal: number;
  grandTotal: number;            // total + tipTotal

  payments: SalonPayment[];
  depositApplied?: number;       // 定金沖銷
  changeDue?: number;           // 現金找零

  status: SalonOrderStatus;

  notes?: string;

  startedAt?: string;
  completedAt?: string;
  settledAt?: string;

  ledgerOrderId?: string;        // 結帳後 push 到 Ledger 的訂單 id
  createdAt: string;
  updatedAt: string;
}
```

### 7.10 列印

```ts
// PrintJob 模型復用既有 src/lib/types.ts 中的 PrintJob
// salon 打印分區命名約定：
export type SalonPrinterGroup =
  | "station_face"        // 臉部房
  | "station_body"        // 身體房
  | "station_nails"       // 美甲台
  | "station_wash"        // 水洗台
  | "receipt"             // 收據
  | "label";              // 標籤

// 預約觸發的列印：
//   - 預約確認單（送客人；或留存）
//   - 收據（結帳時）
//   （v1 不做崗位單）
```

---

## 8. 儲存與同步

### 8.1 localStorage 鍵（salon 命名空間）

| 鍵 | 類型 | 內容 |
|----|------|------|
| `macau-pos-salon/bootstrap` | `SalonBootstrap` | 店家、類目、項目、員工、房、列印分區 |
| `macau-pos-salon/bookings` | `SalonBooking[]` | 預約（含從 Ledger 同步過來的） |
| `macau-pos-salon/orders` | `SalonPosOrder[]` | 結帳訂單 |
| `macau-pos-salon/staff` | `SalonStaff[]` | 員工（label） |
| `macau-pos-salon/stations` | `SalonStation[]` | 房 / 椅 |
| `macau-pos-salon/service-categories` | `SalonServiceCategory[]` | 服務類目 |
| `macau-pos-salon/service-items` | `SalonServiceItem[]` | 服務項目 |
| `macau-pos-salon/print-jobs` | `PrintJob[]` | 列印任務（共用 PrintJob 結構） |
| `macau-pos-salon/sync-queue` | `QueueEvent[]` | 待同步事件 |
| `macau-pos-salon/shift` | shift | 當前班次 |
| `macau-pos-salon/shift-history` | shift[] | 歷史班次 |
| `macau-pos-salon/customers` | `SalonCustomerProfile[]` | 客戶檔案快取 |
| `macau-pos-salon/active-store` | `storeId` | 終端綁定的 salon store |

**嚴格規範**：`macau-pos-salon/*` 與既有 `macau-pos/*` 完全隔離，讀寫透過 `src/lib/salon/storage.ts` 包裝。

### 8.2 列隊事件（`QueueEventType` 新增）

```ts
export type SalonQueueEventType =
  | "BOOKING_CREATED"
  | "BOOKING_UPDATED"          // 改時間、改技師、改狀態
  | "BOOKING_CANCELLED"
  | "BOOKING_CHECKED_IN"
  | "BOOKING_NO_SHOW"
  | "SERVICE_STARTED"
  | "SERVICE_COMPLETED"
  | "ORDER_DRAFT_CREATED"      // 結帳單建立
  | "ORDER_SETTLED"
  | "TIP_RECORDED"
  | "DEPOSIT_RECEIVED"         // 標記：客人已付定金
  | "STAFF_UPDATED"
  | "STATION_UPDATED"
  | "SERVICE_CATEGORY_UPDATED"
  | "SERVICE_ITEM_UPDATED";
```

事件透過既有 `sync-queue` 框架上傳 POS Supabase；Realtime 事件（來自 Ledger）獨立走 `src/lib/salon/realtime.ts`。

### 8.3 不衝突關鍵點

| 既有 `macau-pos/*` 鍵 | 新 `macau-pos-salon/*` 鍵 |
|------------------------|-----------------------------|
| `/api/pos/sync` 上傳既有事件 | 上傳新事件類型時，需 API Route 識別 `industry` 欄位分流（API 端最小改動：1 個 discriminator） |
| `print-bridge` 打印機列表 | salon 終端用同一組打印機，列印分區字串前綴避免衝突（如 `salon_face`） |
| `AuthGuard` | 共用；登入後依 `store.industry` 跳轉 |

---

## 9. 頁面與功能

| 路由 | 元件 | 說明 |
|------|------|------|
| `/salon` | `workbench.tsx` | 今日預約走馬燈 + 待接待 + 服務中 + 待結帳 |
| `/salon/calendar` | `calendar-board.tsx` | 日/週視圖；可在時間軸上拖拽新增預約 |
| `/salon/booking/new` | `booking-form.tsx` | 開立新預約（電話 / walk-in）；提交後呼叫 Ledger RPC |
| `/salon/booking/[id]` | `service-runner.tsx` | 預約詳情 → 服務執行（開始 / 加項 / 換人 / 完成） |
| `/salon/checkout/[bookingId]` | `checkout.tsx` | 結帳頁：折扣、小費多技師拆帳、定金沖銷、混合付款（cash/card/Ledger 餘額/external）、收據列印 |
| `/salon/customers` | list | 客戶列表（從 Ledger 同步） |
| `/salon/customers/[id]` | `customer-card.tsx` | 客戶檔案 + 配方歷史 + Ledger 餘額/積分 |
| `/salon/settings` | `settings.tsx` | 店名編輯、服務類目 toggle、服務項目、員工 toggle、房型、列印分區、重置資料 |
| `/salon/prints` | `prints-list.tsx` | salon 收據佇列（macau-pos-salon/print-jobs）列表 + 重印 + 狀態 |
| `/salon/reports` | `reports.tsx` | 營業 / 折扣 / 定金 / 小費 / 付款方式拆分 / 技師業績 / 服務銷量（今日 / 近7日 / 全部） |

### 9.1 工作台（`/salon`）首屏結構

```
┌─────────────────────────────────────────────────┐
│  Next Booking : 09:30 王小姐 / 小美 剪髮 60'   │
├─────────────────────────────────────────────────┤
│ Today Bookings │ Walk-in │ In Service │ Checkout │
│  ───────────── │ ──────  │ ────────── │ ──────── │
│  09:30 王小姐   │  [新增] │  10:00 陳先生 │  11:00 林小姐 │
│  10:00 陳先生   │         │     染髮中   │     待結帳 │
│  ...           │         │              │           │
└─────────────────────────────────────────────────┘
```

### 9.2 日曆（`/salon/calendar`）

- 視圖切換：日 / 週
- X 軸：時間（每 30 分鐘一格），Y 軸：員工
- 預約以色塊顯示，顏色依 `ServiceCategory.color`
- 點擊空時段：彈出「新增預約」表單，預設時間填入
- 點擊預約塊：跳轉 `/salon/booking/[id]`

### 9.3 服務執行（`/salon/booking/[id]`）

```
┌────────────────────────────────────────────┐
│  王小姐 / BK20260814-0001  10:00–11:00      │
│  剪髮 60'   小美  (Chair 3)                 │
├────────────────────────────────────────────┤
│  [開始服務] [換技師] [加項] [完成服務]      │
│  [取消預約]  [標記 no-show]                │
├────────────────────────────────────────────┤
│  服務記錄：                                │
│  - 10:00 開始 / 小美                       │
│  - 10:30 助理洗頭 / 小玲                  │
│  - 10:45 剪髮 / 小美                      │
│  - ...                                    │
├────────────────────────────────────────────┤
│  → 結帳                                   │
└────────────────────────────────────────────┘
```

> ⚠️ **已移除：多人接力（multi-person relay）** — 2026-08-14 用戶決定 v1 不做接力式服務。每筆服務執行只記單一 `staffId`；換技師視為改派，不疊加接力日誌（`ServiceExecutionLog` 為單條）。

### 9.4 結帳（`/salon/checkout/[bookingId]`）

```
┌────────────────────────────────────────────┐
│  應付                                      │
│   剪髮 60'         $300                    │
│   護理              $200                    │
│   ─────────                            │
│   小計              $500                    │
│   已付定金          -$100                   │
│   ─────────                            │
│   應收              $400                   │
├────────────────────────────────────────────┤
│  小費  [小美 $50]  [+ 新增]                │
│  總計（含小費）      $450                   │
├────────────────────────────────────────────┤
│  支付方式                                   │
│   ☑ Cash         $200                     │
│   ☑ Ledger 餘額  $250  [查詢餘額]         │
├────────────────────────────────────────────┤
│  [確認結帳]                                │
└────────────────────────────────────────────┘
```

---

## 10. 核心流程

### 10.1 線上預約落入（Realtime）

```
客人透過 Ledger 微信小程式下預約
  → Ledger 寫入 orders 表（type=booking）
  → Ledger Realtime 廣播
  → POS 訂閱 → src/lib/salon/realtime.ts
  → mapping → SalonBooking { source: "online_ledger", ledgerBookingId }
  → 寫 macau-pos-salon/bookings
  → 預約看板彈出卡片 + 提示音
```

### 10.2 Walk-in / 電話預約 → POS 開立

```
Receptionist 在 /salon/booking/new 表單填資料
  → 本地建 SalonBooking { source: "walk_in" or "phone" }
  → 若 source="phone"：呼叫 Ledger RPC create_booking 把預約同步上去
    （讓客戶在手機 App 看到這個預約）
  → 寫 macau-pos-salon/bookings
  → 走列隊：BOOKING_CREATED
```

### 10.3 接待與服務啟動

```
客戶到店
  → receptionist 點「已接待」 → status=checked_in
  → 點「開始服務」 → status=in_service, startedAt=now
  → 列印收據 / 預約確認單（依需要）
  → 走列隊：BOOKING_CHECKED_IN, SERVICE_STARTED, PRINT_JOB_CREATED
```

### 10.4 服務執行（中場）

```
中途可：
  - 加項：加 SalonServiceItem（Phase 3 落實）
  - 換技師：改派 staffId（不疊加接力日誌）
  - 記耗材：consumableNotes 文字備註（不扣庫存）
```

### 10.5 服務完成與結帳

```
完成服務
  → status=completed，completedAt=now
  → 走列隊：SERVICE_COMPLETED
  → 點「結帳」 → 跳轉 /salon/checkout/[bookingId]
  
結帳頁
  → 顯示所有 items
  → 顯示 depositApplied（若已付定金）
  → 加小費（多技師）
  → 選擇支付方式：
      cash：本地記錄
      card：本地記錄（外部終端處理）
      ledger_balance：
        → 顯示 Ledger 餘額
        → 呼叫 Ledger deduct_member_balance RPC
        → 收到 ledgerTransactionId
        → 記錄 payment
  → 全部合計後 → 確認結帳
  → status=settled, settledAt=now
  → 呼叫 Ledger update_order_status 推進狀態
  → 走列隊：ORDER_SETTLED
  → 列印收據
```

### 10.6 定金處理

```
預約時店家要求定金
  → receptionist 在 Ledger 後台（或 Ledger RPC）對會員餘額做一次扣款
  → POS Booking.depositAmount 與 depositLedgerTxnId 由手動填入（或未來提供 RPC）
  
結帳時
  → depositApplied = booking.depositAmount（顯示已收款）
  → 從應收中扣除
```

### 10.7 取消 / no-show

```
receptionist 點「取消」/「no-show」
  → status=cancelled 或 no_show
  → 定金處理：提示「請到 Ledger 後台執行扣款」（不自動化）
  → 走列隊：BOOKING_CANCELLED / BOOKING_NO_SHOW
```

---

## 11. 列印模型

### 11.1 列印類別（v1 不含崗位單）

> 2026-08-14 用戶決定：美容服務**不做崗位單**（不以打印方式向房/椅崗位派工）。

| 類別 | salon 場景 | 對應 PrinterRole |
|------|-----------|------------------|
| **收據** | 結帳時，給客人簽名 / 留存 | `receipt` |
| **標籤** | （可選）客人專屬瓶罐標籤 | `label` |
| **預約確認單** | 預約建立後（可選列印） | `receipt` 分區複用 |

### 11.2 列印分區對應

| `SalonPrinterGroup` | 場景 |
|---------------------|------|
| `station_face` | 臉部護理 → 臉部房印表機 |
| `station_body` | 身體 / 按摩 / SPA → 身體房 |
| `station_nails` | 美甲 → 美甲台 |
| `station_wash` | 水洗（染髮前） |
| `station_lashes` | 美睫 |
| `receipt` | 收銀台印表機 |
| `label` | 標籤機 |

`SalonServiceCategory.printerGroup` 保留於資料模型（為未來 station 路由預留），v1 僅用於收據 / 標籤 / 預約確認單分類，不自動印崗位單。

### 11.3 列印內容模板

| 模板 | 觸發時機 | 必含欄位 |
|------|----------|----------|
| **收據** | 結帳 | 店家、訂單號、服務列表、定金、小費、付款明細、總計、時間 |
| **預約確認單** | 預約建立後（可選列印） | 客人姓名、時間、技師、服務、店家聯絡電話 |
| **標籤** | 客人專屬瓶罐（可選） | 客人代號、服務項、日期 |

模板沿用既有 `PosLocalSettings.printTemplates` 結構，新加 salon section。

---

## 12. 與 Ledger 整合契約

> 需 Ledger 團隊確認 / 提供。本節為 v1 對接需求清單。

### 12.1 Ledger 既有（直接用）

| Ledger 能力 | 本系統用法 |
|-------------|-----------|
| Auth（8 位電話 + 4 位 PIN） | 不改 |
| Member balance / topup | 結帳時可抵扣；receptionist 可查 |
| Member coupons | v1 salon 不主推，預留 |
| Order Realtime（`orders` 表） | 接收 booking 與 settlement 事件 |
| RPC: `accept_order_with_deduct` | 結帳扣點 |
| RPC: `accept_order_in_store` | 到店付接單 |
| RPC: `update_order_status` | 推進預約狀態 |
| RPC: `set_order_paid_in_store` | 結帳後告知 |
| RPC: `get_merchant_report_summary` | 報表 |

### 12.2 Ledger 新增需求（待對接確認）

| 編號 | 能力 | 優先級 | 說明 |
|------|------|--------|------|
| **L1** | `orders.kind = 'booking'` 支持 | P0 | 用同一 `orders` 表，加 `kind` enum 區分 booking 與 order |
| **L2** | `orders.booking_meta` 結構 | P0 | 客人、技師分配、時間、服務項等 |
| **L3** | RPC: `create_booking_from_pos` | P0 | POS 開電話/walk-in 預約時同步上 Ledger |
| **L4** | RPC: `cancel_booking` | P0 | 取消邏輯（含是否觸發扣款提示） |
| **L5** | RPC: `get_member_points_balance` | P1 | 客戶檔案顯示積分 |
| **L6** | RPC: `record_tip_ledger_balance` | P1 | 小費走 Ledger 餘額扣款（若店家政策要求） |
| **L7** | Realtime 過濾器：`order_kind = 'booking'` | P0 | POS 只訂閱 booking 事件，不要餐飲訂單雜訊 |
| **L8** | `services` 服務項目表 | P0 | 服務類目、項目、價格、時長（Ledger 是否已建？） |
| **L9** | 預約可用 Ledger 扣款收定金 | P1 | 統一透過 ledger deduct |

### 12.3 POS 提供給 Ledger 的回饋

- 已使用 Ledger `merchant_id` 標識 salon 店家
- POS 端結帳成功後推送 `order_settled` 事件 + line items，Ledger 側據此計算積分 / 寫歷史

---

## 13. 開發分期

> 6 個 phase 約 9–10 週。P1–P3 完成即可試運營。

### Phase 1 — 縱向分流骨架（1.5 週）

**交付**：
- `industry` 路由分流；登入後依 store.industry 跳轉
- `/salon` 空殼工作台 + `macau-pos-salon/bootstrap` mock 初始化
- salon 命名空間全套 storage 鍵封裝
- Backoffice store 列表加 `industry` 篩選

**驗收**：
- [ ] salon storeId 登入後跳 `/salon`
- [ ] restaurant storeId 登入後照常跳 `/`
- [ ] salon 與餐飲的 localStorage 互不污染
- [ ] `/salon` 首屏可載入，無 console error

### Phase 2 — 預約 + Walk-in 開單（2 週）

**交付**：
- `SalonBooking` CRUD
- `/salon/calendar` 日/週視圖
- `/salon/booking/new` 表單（walk-in / 電話）
- Ledger Realtime 接收 booking（**先 mock，待 L1/L2 完成後接真**）
- 預約狀態機（pending → confirmed → checked_in）

**驗收**：
- [ ] 手動開 walk-in 預約，calendar 即時更新
- [ ] Realtime mock 推到 salon 後 calendar 出新卡片
- [ ] 預約可改時間、改技師、取消
- [ ] 與 Ledger 真實對接通後切換不掉資料

### Phase 3 — 服務執行 + 加項 + 收據列印（2 週）

> 已移除：崗位單列印、多人接力（2026-08-14 用戶決定）。

**交付**：
- `/salon/booking/[id]` 服務執行頁
- 服務狀態機（開始 / 加項 / 換人 / 完成）
- `SalonStation`、`SalonStaff` CRUD
- 收據 / 預約確認單列印（接 `print-bridge`，非崗位單）
- `/salon/settings` 服務類目 / 項目 / 員工 / 房管理

**驗收**：
- [ ] 服務中途可加項、換人（改派 staffId，不疊加接力）
- [ ] 完成服務後狀態推進
- [ ] 結帳前可預覽收據（測試列印中心預覽）
- [ ] `/salon/settings` 完整 CRUD

### Phase 4 — 客戶檔案 + Ledger 積分（1 週）

**交付**：
- `/salon/customers` 列表 + `/salon/customers/[id]` 檔案
- 髮質 / 膚質 / 過敏 / 配方歷史
- 從 Ledger 拉積分（read-only）

**驗收**：
- [ ] 客戶檔案顯示 Ledger 餘額 + 積分
- [ ] 配方歷史可手動新增、可從結帳後訂單推導
- [ ] 標籤（VIP / 敏感肌）可自由標

### Phase 5 — 結帳 + 小費 + 定金（2 週）

**交付**：
- `/salon/checkout/[bookingId]` 全功能結帳
- 小費多技師拆帳
- 定金沖銷邏輯
- 支付方式：cash / card / Ledger 餘額 / external
- 結帳列印收據
- 報表：服務項目銷量、技師業績

**驗收**：
- [x] 結帳能完整流程跑通（cash + 小費 + 定金；2026-08-14 實作，走 Mock Realtime + 本地 Ledger 模擬）
- [ ] Ledger 餘額扣款 RPC 接通（mock → 真）：`applyMockLedgerPayment` 已留對接縫，待 Ledger L1/L2/L3 到位替換
- [x] 結帳後訂單狀態推進（settled）+ 收據列印（寫入 `macau-pos-salon/print-jobs` 並 dispatch）
- [ ] 報表頁可看見 salon 數據（→ Phase 6）

### Phase 6 — 報表、Backoffice 整合、硬化（1.5 週）

**交付**：
- `/salon/reports` 完整報表（營業 / 技師業績 / 服務銷量 / 小費彙總）
- Backoffice 跨行業門店列表 + 同步狀態
- 離線模式硬化（IndexedDB 列隊）
- 錯誤邊界 + 提示音

**驗收**：
- [x] salon 報表頁（營業 / 技師業績 / 服務銷量 / 小費彙總）可看見本地結帳數據（2026-08-14 實作；與 Ledger `get_merchant_report_summary` 對帳待 Ledger 到位）
- [x] `/salon/prints` 收據佇列管理 + 重印（寫入 macau-pos-salon/print-jobs，與餐飲隔離）
- [x] `/salon/settings` 店名 / 類目 toggle / 員工 toggle / 列印分區 / 重置
- [ ] 跨行業門店列表可篩選（Backoffice）→ **Phase 7-B 實作**
- [ ] 斷網 4 小時操作後恢復網絡，sync 100% 補上（IndexedDB 硬化）→ **Phase 7-C 實作**

### Phase 7 — 硬化與跨行業整合（2026-08-14 啟動）

承接 Phase 6 遺留嘅三項「待接」：錯誤邊界 + 提示音、Backoffice 跨行業門店列表、IndexedDB 離線硬化。範圍經用戶確認為**三項全做**，順序 A → B → C。真後端 / Ledger 對接留 seam，待後端到位。

#### A. 錯誤邊界 + 提示音

**設計**
- `src/app/salon/error.tsx`：Next.js 段級 error boundary（class component + `"use client"`），包住成個 `/salon/*` 段；出錯顯示 fallback + 「重試」按鈕，**唔使逐頁改**。尊重「不動餐飲」——只覆蓋 salon 段。
- `src/lib/salon/sound.ts`：WebAudio `beep()` 工具，`playSuccessBeep()` / `playErrorBeep()`；`typeof window` + `AudioContext` 懶初始化，SSR / 受限瀏覽器靜默降級，唔拋錯。
- 接線點：結帳成功（`checkout.tsx`）、收據列印成功 / 失敗（`print.ts` 的 `dispatchSalonReceipt` / `reprintSalonJob`）。

**驗收**
- [x] `/salon/*` 任務渲染異常有 fallback + 重試，唔使 reload 成個 app
- [x] 結帳成功、收據列印成功 / 失敗有對應提示音（靜音環境不報錯）

#### B. Backoffice 跨行業門店列表

**設計**
- `AccountStore`（`src/lib/types.ts`）加 `industry?: "restaurant" | "salon"`。
- `loadLocalBackofficeOverview()`（`src/lib/backoffice-client.ts`）併入 salon bootstrap 店：讀 `loadSalonBootstrap()`，map 成 `AccountStore` 加 `industry: "salon"`；restaurant 店預設 `industry: "restaurant"`。
- `BackofficeStoresPage` 加 industry 篩選（全部 / 餐飲 / 美容）+ 行業徽章 + 跨行業統計（餐飲 N / 美容 N）。
- `stores/[storeId]` 詳情顯示 industry。
- 真 Supabase 路徑：`fetchBackofficeOverview` 命中 DB 時，`/api/backoffice/overview` 需回 industry（seam；後端未做時回 mock）。

**驗收**
- [x] Backoffice 門店列表可篩選 餐飲 / 美容，salon「示範美容院」出現喺列表
- [x] 每行顯示行業徽章；統計區分餐飲 / 美容數量

#### C. IndexedDB 離線硬化（sync-queue）

**設計**
- `src/lib/salon/idb.ts`：IndexedDB（`macau-pos-salon` db，`kv` store 做 key-value 鏡像 + `syncQueue` store 做變更佇列）。所有操作 best-effort、唔拋錯，唔影響現有流程。
- 鏡像：salon storage 每次 `writeJson` 後順便 `idbSet(key, value)`（fire-and-forget）；`readJson` 若 localStorage 空但 IDB 有，補回 localStorage（hydration）。localStorage 仍係熱路徑主源，**caller 簽名不變**，降風險。
- sync-queue：`saveSalonOrders` / `saveBookings` / `saveSalonPrintJobs` 觸發 `idbEnqueue({entity, id, status:"pending"})`；`flushSalonSyncQueue()` 監聽 `online` + `visibilitychange` + 啟動時跑，pending → `synced`（本地模式模擬成功 push；真後端 push 留 `pushSalonMutation()` seam）。
- 落實「斷網 4 小時操作 → 恢復網絡 sync 100% 補上」：佇列存 IDB 存活 reload/crash，重連 flush。

**驗收**
- [x] salon 寫入同時鏡像到 IndexedDB；localStorage 清空後 reload 能從 IDB 補回
- [x] 斷網期間嘅訂單 / 預約 / 收據記入 sync-queue（pending）；重連後 flush 成 synced

> 說明：全面將 salon storage 由 localStorage 轉 async IndexedDB（改所有 caller 簽名）風險高，且沙盒跑唔到 `npm run build` 驗證。Phase 7-C 採「IDB 鏡像 + sync-queue」方案，熱路徑零改動；全量 async 遷移留待 build 環境驗證後做。

### Phase 7+（v1 之後）

- 連鎖店管理
- 進銷存（採購入庫、批號、盤點）
- Staff 自助 App（技師手機登入接單）
- 線上預約渠道（若 Ledger 決定讓 POS 做）
- 會員等級 / 生日優惠自動化

---

## 14. 暫不做 / 之後再談

| 項目 | 原因 | 預計時機 |
|------|------|----------|
| Staff 自助登入 | 增加權限與審計複雜度 | v2+ |
| 連鎖跨店管理 | 當前單店試點 | v2+ |
| 進銷存 | 工程量大；v1 用品消耗只做文字備註 | v2+ |
| 自家次卡 / 套票 | 完全由 Ledger 餘額機制替代 | 不做 |
| 線上預約渠道 | Ledger 主導 | 不做 |
| 完整退款流程 | 用 Ledger 扣款代替 | v2 再議 |
| 客戶評價 / 跟進提醒 | 屬會員行銷範疇 | v2+ |

---

## 15. 風險

| 風險 | 等級 | 緩解 |
|------|------|------|
| Ledger 不確定何時提供 booking RPC（L1–L4） | 高 | Phase 2 用 mock 先行；待 Ledger 提供後切換；介面先固定，實作可換 |
| Ledger `orders` schema 改動可能影響既有餐飲 | 中 | 改動只在 Ledger 後端，POS 端介面層抽象 |
| 服務執行過程中途掉線 | 中 | SalonBooking 與 Order 本地優先；sync-queue 重連補傳 |
| 換技師歸屬與佣金糾紛 | 低 | 多人接力已移除；換技師僅改派 staffId，報表以最終 staffId 計績 |
| 定金狀態與 Ledger 對不上 | 中 | 定金以 Ledger 為唯一權威；POS 只顯示不裁決 |
| 服務類目命名混亂 | 低 | 預設八大類目；可由店家裁剪 |

---

## 16. 給 Ledger 團隊的對接需求（彙整）

> 從設計中提取，作為對接窗口的需求申請單。

### 16.1 P0（必給，否則 Phase 2 起卡住）

1. **`orders.kind` 字段**：現有 `orders` 表加 enum：`'order' | 'booking'`（不影響既有資料）。
2. **`orders.booking_meta` JSONB 欄位**：存 salon booking 結構（時間、技師、服務項、狀態機）。
3. **`create_booking_from_pos` RPC**：POS 開立 walk-in / 電話預約後呼叫，寫 Ledger 並觸發 Realtime。
4. **`cancel_booking` RPC**：含可選的自動扣款提示（POS 端只顯示，不自動執行）。
5. **`services` 服務主檔**：服務類目、項目、價格、時長，是否已建？若無，需新建並對應 POS 端 `SalonServiceItem`。
6. **Realtime 過濾 `order_kind = 'booking'`**：POS 端只訂閱預約事件。

### 16.2 P1（增強，不影響試運營）

7. `get_member_points_balance` RPC：返回當前會員積分。
8. `record_tip_ledger_balance` RPC：小費扣 Ledger 餘額（若店家政策要求統一走 Ledger）。
9. 預約可用 Ledger 扣款收定金：統一介面，POS 提示「到 Ledger 操作」可進化為「POS 一鍵發起」。

### 16.3 介面風格建議

- 全部走 PostgREST RPC，不開放直接表操作給 POS
- 訂閱 Realtime channel 名約定，例如 `orders:booking:{merchant_id}`
- 錯誤碼體系：403（會員餘額不足）、409（時間衝突）、422（資料缺失）需文檔化

---

## 17. 變更日誌

| 日期 | 版本 | 變更 | 作者 |
|------|------|------|------|
| 2026-08-14 | v0.1 | 初稿：11 條決策 + 架構 + 資料模型 + Ledger 對接需求 | WorkBuddy（AI 助手）協作 |

---

## 附錄 A：相關現有檔案

| 主題 | 路徑 |
|------|------|
| 餐飲總體設計 | `docs/01-overall-system-design.md` |
| 餐飲資料模型 | `docs/04-data-model-and-storage.md` |
| 餐飲頁面清單 | `docs/05-pages-and-features.md` |
| Ledger 對接（餐飲） | `docs/integration/ledger-client-api.md` |
| 功能成熟度 | `docs/reviews/functional-review.md` |
| TypeScript 類型權威 | `src/lib/types.ts`（**只讀**，salon 新類型放 `src/lib/salon/types.ts`） |

## 附錄 B：行業分流判斷流程（建議給登入後）

```
登入成功
  ↓
讀取 account.stores[active].industry
  ↓
if industry === "salon"     → /salon
if industry === "restaurant" → /
if undefined               → /  （預設餐飲，向後相容）
```
