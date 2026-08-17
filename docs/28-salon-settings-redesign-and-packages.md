# 28 · Salon 設置頁重構 + 美容院 Package 玩法

> 日期：2026-08-14
> 背景：用戶對現有 salon 設置頁 4 點不滿 → 本文給出重構方案 + package 玩法調研與分期計劃。
> 約定：不動餐飲；salon 代碼落在 `src/app/salon/`、`src/components/salon/`、`src/lib/salon/`；離線優先（localStorage 熱路徑、DB 雲鏡像）不變。

---

## 一、開發工具為何「按了沒反應」（用戶第 3 點）

**現狀**
`src/components/salon/settings.tsx` 的「開發工具」section 只有一個按鈕「重置 salon 本地資料」，其 handler：

```ts
const handleReset = useCallback(() => {
  if (typeof window === "undefined") return;
  const ok = window.confirm("確定重置 ... 此動作不可復原。");
  if (!ok) return;
  resetSalonStorage();
  window.location.reload();
}, []);
```

**根因**
本 POS 是 PWA，安裝到主畫面後以 **standalone 模式**運行。主流瀏覽器（iOS Safari / Android Chrome / 部分桌面 PWA）在此模式下會**抑制原生 `window.confirm / alert / prompt`**——要麼不彈窗、要麼直接回傳 `false`。結果：`window.confirm` 被吞掉，`ok` 為 false，函數直接 `return`，畫面毫無反應。這不是邏輯錯誤，是「用了 PWA 不支援的 API」。

**修法（納入本次重構）**
- 棄用 `window.confirm`，改為**組內二段確認 / in-app Modal**：
  - 點「重置本地資料」→ 按鈕原地變成「確定重置？／取消」紅色確認態，2 秒內再點一次才執行；或彈出 salon 自己的確認 Modal。
  - 同步把「開發工具」區講清楚：含「重置本地資料」「重種預設 seed」「檢視 sync 佇列狀態」三項，並標註「僅供開發測試」。

---

## 二、設置頁 sub-tab 拆分 + 全 CRUD（用戶第 1、2 點）

### 2.1 現狀問題
- 全部擠在單頁 grid，項目一多很難找。
- 服務類目 / 員工：只能 toggle 啟用/停用，**不能新增、編輯、刪除**。
- 服務項目 / 房型椅 / 列印分區：純展示，完全不能改。
- 用戶要求：「全部都能夠新增、刪除、停用」。

### 2.2 新設計：sub-tab 結構

頂部一排 tab（行動版可橫向滑動，與 `salon-sidebar` 風格一致），每個 tab 一個管理區：

| Tab | 內容 | 可操作 |
|---|---|---|
| **店家資料** | 店名、貨幣（read-only 由 bootstrap）、日曆格距、定金開關、預設時長 | 編輯店名 / 數值 |
| **服務類目** | 臉部/身體/SPA/美甲/美睫… | 新增 / 編輯（名稱、列印分區、排序、色標）/ 啟用停用 / **刪除**（刪前檢查是否被服務項目引用，有則警示） |
| **服務項目** | 各項服務 | 新增 / 編輯（名稱、所屬類目、價格、時長、工位類型、備註）/ 啟用停用 / 刪除 |
| **員工** | 療師/助理/接待 | 新增 / 編輯（姓名、nickname、角色、可服務類目白名單、電話）/ 在職離職 / 刪除 |
| **場地（房型椅）** | 椅/床/房/洗護台 | 新增 / 編輯（名稱、類型、容量、位置）/ 啟用停用 / 刪除 |
| **列印分區** | 來自裝置 print-bridge | 啟用停用（裝置層級，只 toggle，不在此新增/刪除） |
| **開發工具** | 重置 / 重種 seed / sync 狀態 | 見第一節（in-app 確認） |

### 2.3 通用 CRUD 模式（降低實作成本）
- 每個 tab 內有「**＋ 新增**」按鈕 → 打開 **drawer / modal 表單**（同一個可複用 `SalonFormModal` 組件，欄位由傳入 config 決定）。
- 每行右側三顆操作：啟用/停用 toggle（switch 樣式）、✎ 編輯、🗑 刪除（刪除走 in-app 確認）。
- 所有變更統一走既有 `patchBootstrap(...)` → `saveSalonBootstrap(next)`（寫入 `bootstrap` + 各陣列鍵），**完全沿用現有 sync seam**，改完即自動進 sync 佇列、重連上雲。不引入新依賴、不動餐飲。

### 2.4 技術落點
- 改 `src/components/salon/settings.tsx`：加 `activeTab` state + tab 列 + 各 tab 渲染 + `SalonFormModal`。
- 新增 `src/components/salon/settings/*` 小組件（或直接內聯）處理表單欄位，保持單檔可讀。
- 不新增路由（仍是 `/salon/settings`），tab 用 state 切換即可；若日後項目暴增再考慮 `/salon/settings/[tab]`。

---

## 三、美容院 Package 玩法調研 + 讓商家最輕鬆的方案（用戶第 4 點）

### 3.1 市面上美容院常見「玩法」清單
（澳門 / 香港 / 内地通用，按「是否已被 Ledger 覆蓋」分類）

| 玩法 | 說明 | 現有覆蓋 |
|---|---|---|
| **次卡 / 療程卡** | 固定項目 N 次（如 10 次面部 $6800）、通用次卡、期限次卡（N 次 + X 月內用完） | 尚未（salon 本地概念） |
| **套票 / 組合包** | 用戶舉例：`$6800` = 10 次面部 + 送 2 次肩頸 + 送 1 支精華 + 存 500 積分 | 尚未（次數額度部分） |
| **儲值卡** | 充值送贈金（儲 $5000 送 $1000），餘額消費任意項 | Ledger 餘額 |
| **會員等級 / 年費** | 年費會籍享折扣、專屬價、生日禮 | Ledger tier |
| **積分** | 消費累積，抵現 / 換項目 / 換產品 | Ledger 積分 |
| **定金 / 預約金** | 線上預約鎖定金額，到店抵扣 | Ledger 定金 |
| **生日 / 節慶 / 轉介** | 生日月雙倍積分、介紹好友雙方獎勵 | 部分（積分層） |
| **月費 / 訂閱** | 月費制，每月 N 次 | 可後續 |

**關鍵洞察**：用戶舉的 `$6800` 例子 = 「付款一次 → 拿到一張卡」，卡裡含兩類東西：
1. **次數額度**（哪些服務、各幾次）—— 這是 salon 自己的概念，Ledger 不會記「10 次面部」。
2. **贈送儲值 / 贈送積分** —— 這兩樣 Ledger 已經有（餘額、積分）。

→ 所以「最輕鬆」的架構是：**次數額度留在 salon 本地，儲值/積分/定金委託 Ledger**。

### 3.2 讓商家操作最輕鬆的資料模型

**套票模板（後台建立一次，可重複賣）**
```ts
SalonPackageTemplate {
  id: string
  name: string                 // 例：「面部 10 次豪華套票」
  price: number                // 6800
  validityDays: number         // 180（期限次卡）
  items: { serviceItemId: string; sessions: number }[]  // 10 次面部 + 2 次肩頸
  bonusPoints: number          // 贈送 500 積分（→ Ledger）
  bonusBalance: number         // 可選贈送儲值（→ Ledger）
  active: boolean
}
```

**客戶持有的套票卡（購買後生成）**
```ts
SalonCustomerPackage {
  id: string
  customerId: string
  templateId: string
  purchasedAt: string
  expiresAt?: string
  remaining: { serviceItemId: string; sessionsLeft: number }[]  // 視覺化剩餘
  status: "active" | "used_up" | "expired"
}
```

### 3.3 商家最輕鬆的操作流（建議 UX）
1. **後台「套票模板」**：填名稱 / 價格 / 有效期 → 明細表「+ 加一行」選服務 + 填次數（可多行）→ 填贈送積分（自動顯示「將寫入 Ledger」）→ 儲存。
2. **客戶購買**：在客戶檔案 / 結帳頁「賣套票」→ 選模板 → 扣款（現金/卡/或 Ledger 餘額）→ 自動生成「客戶套票卡」，剩餘次數即時顯示。
3. **結帳抵扣**：偵測客戶持有套票 → 一鍵「用套票抵扣」自動扣對應項目次數；不夠的次數才走現金/Ledger。贈送積分購買當下即寫入 Ledger。
4. **報表 / 提醒**：套票銷售額、使用率、即將到期客戶清單（催銷）。

### 3.4 分期建議（本次先 plan，確認後再實施）
- **P1（輕量，可本期）**：套票模板 CRUD（本地）+ 客戶套票卡購買/顯示。新增 `salon_package_templates` / `salon_customer_packages` 表 + 對應 `/api/salon/*` 路徑（沿用既有 mirror 模式）。
- **P2**：結帳 `checkout` 接入「套票抵扣」一步。
- **P3**：報表 + 即將到期提醒。
- 儲值 / 積分 / 定金：直接接 Ledger，**不重複造輪**。

---

## 四、建議的實施順序與確認事項

1. **必做（本次）**：第一節開發工具修法 + 第二節設置頁 sub-tab 重構 + 全 CRUD。風險低、閉環清晰、沿用既有 sync。
2. **先 plan（本次只出方案）**：第三節 package 玩法，待你確認範圍與是否納入本期再開工。
3. **待你確認**：
   - 設置頁 7 個 tab 的分法是否認同（或可合併，例如「場地」併入「服務管理」）？
   - package 是否要一起落地（P1），還是本期只做設置重構？
   - 列印分區是否維持「只啟用停用」（因來自裝置 config，不在 salon bootstrap）？

---

## 五、實施紀錄（2026-08-14）

用戶經 AskUserQuestion 確認：**設置重構 + 開發工具修復（package 維持 plan 不實作）**、**5 個 tab（場地併入服務管理、列印分區併入開發工具）**、**列印分區也要新增/刪除**。

### 5.1 已落地
- `src/components/salon/settings.tsx` 重寫為 5 個 sub-tab + 通用 `CrudSection`/`FormModal`/`ConfirmModal`。每 tab 支援新增 / 編輯 / 啟用停用 / 刪除；列印分區經 `saveDeviceConfig` 寫回裝置 config（含新增/刪除）；開發工具棄用 `window.confirm` 改 in-app `ConfirmModal`（重置 / 重種預設服務資料 / sync 佇列檢視）。
- `src/lib/salon/storage.ts` 加 `reseedSalonConfig()`：只重種類目/項目/員工/場地，保留預約/訂單/客戶。
- 類目刪除加 `canDelete` 防護（被服務項目引用時警示）。

### 5.2 已知 gap（follow-up）
- ~~`saveSalonBootstrap` 目前**未 enqueue 到 sync 佇列**（POS DB 整合時只 enqueue bookings/orders/printJobs/customers）。故類目/項目/員工/場地改動只落本地、未上雲 `salon_bootstrap_config` 表，多終端設定不同步。~~
  **→ 已於 2026-08-17 接通**：`saveSalonBootstrap` 改 enqueue `entity:"bootstrap"` → `idb.ts` 加 `eventTypeForEntity` 映射 `BOOTSTRAP_UPDATED` → `sync/route.ts` 加 `upsertBootstrap()` 寫 `salon_bootstrap_config`（onConflict:store_id）。多終端設定現可同步。（同輪亦修好 `sync/route.ts` 4 個 `'supabase' is possibly 'null'` 編譯錯。）

### 5.3 驗證
- 沙盒 EPERM 跑不到 `npm run build`；改動靠逐檔覆審。用戶須 dev box `npm run lint && npm run build` 確認無迴歸後 `git add -A && commit && push` 觸發 Vercel 重建。

### 5.4 P1 美容院 Package 玩法（2026-08-14 實施）

依 §3.4 落實 P1：**套票模板 CRUD（本地）+ 客戶套票卡購買/顯示**。次數額度留 salon 本地，儲值/積分/定金委託 Ledger（P2 才寫入）。

**資料模型（src/lib/salon/types.ts）**
- `SalonPackageTemplate`：id/name/price/validityDays/items:[{serviceItemId,sessions}]/bonusPoints/bonusBalance/note/active/createdAt/updatedAt
- `SalonCustomerPackage`：id/customerId/templateId/templateName/price/purchasedAt/expiresAt?/remaining:[{serviceItemId,sessionsLeft}]/status/paymentMethod?
- 同步事件：`PACKAGE_TEMPLATE_UPDATED` / `CUSTOMER_PACKAGE_UPDATED`

**落地檔案**
- `src/lib/salon/types.ts`：新增上述型別 + `SALON_STORAGE_KEYS.packageTemplates` / `customerPackages`
- `src/lib/salon/idb.ts`：sync 佇列 entity union 加 `packageTemplates` / `customerPackages` + `eventTypeForEntity` 映射（沿用既有 mirror 模式，flush 時整個陣列上雲）
- `src/lib/salon/storage.ts`：load/save 套票模板與客戶套票卡；`ensureSalonBootstrap` 首次種入 `defaultSalonPackageTemplates`；`resetSalonStorage` 清套票鍵；`hydrateSalonFromPosDb` 拉取套票
- `src/lib/salon/mock-data.ts`：`defaultSalonPackageTemplates`（2 個示範：面部 10 次豪華套票 $6800 / 凝膠美甲 5 次 $1500）
- `supabase/migrations/0006_salon_packages.sql`：`salon_package_templates` + `salon_customer_packages` 兩表 + RLS + seed（示範模板）
- `src/app/api/salon/state/route.ts`：GET 一併拉 `packageTemplates` / `customerPackages`（含 mock 空陣）
- `src/app/api/salon/sync/route.ts`：`upsertPackageTemplate` / `upsertCustomerPackage` + 兩事件分支
- `src/components/salon/package-templates.tsx`（NEW）：套票模板管理 UI，含嵌套「服務明細」編輯器（加/刪行：服務 + 次數）、啟用停用、刪除（in-app 確認）
- `src/components/salon/settings.tsx`：設置頁加第 6 個 tab「套票模板」（render `PackageTemplatesTab`）
- `src/components/salon/customer-profile.tsx`：客戶檔案加「套票卡」section（顯示剩餘次數 + 狀態徽章 使用中/已過期/已用完）+ 「賣套票」modal（選模板 → 選付款方式 → 生成客戶套票卡）

**P1 範圍外（待後續）**
- P2：結帳 `checkout` 接入「套票抵扣」一步（扣對應項目次數；不夠才走現金/Ledger）+ 購買當下贈送積分/儲值寫入 Ledger
- P3：報表 + 即將到期提醒
- 真扣款/贈送寫入 Ledger 留 seam（本輪購買僅記錄付款方式，不實際扣 Ledger）

**已知 gap / 風險**
- 客戶套票卡的「已用完 / 已過期」狀態目前僅在客戶檔案 UI 推算顯示；抵扣後 `status` 欄位更新（used_up）留 P2 結帳時寫入。
- 多終端套票卡同步已通（customerPackages 經 sync 佇列上雲 salon_customer_packages）。
- 仍需用戶 dev box `npm run lint && npm run build` + push Vercel 驗證（沙盒 EPERM 跑不到 build）。

### 5.5 待 push 提醒
- 本次 P1 改動 + 上輪兩處 build 修復（`sync/route.ts` NonNullable、`settings.tsx` `??`/`||` 括號）均尚未 push。請本地驗證後一併 commit + push。
