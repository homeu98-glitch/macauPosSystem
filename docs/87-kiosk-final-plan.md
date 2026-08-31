# 87 · 自助點餐機（Kiosk）最終方案

> 日期：2026-08-31
> 狀態：**已確認規格，待開工**（本輪仍為計劃，未改任何代碼）
> 取代：`docs/86-kiosk-self-order-v2-scope.md`（八項範圍盤點）、`docs/85-kiosk-self-order-plan.md`（v1）
> 範圍：Kiosk 自助點餐機 ＋ 店內掃碼自點（`/order`、`/menu`），走 `pos_orders`、**無** `onlineOrderId`
> 唔包：Ledger 會員通線上訂單（外賣／自取已有 `onlineOrderSettings.autoAccept`）

---

## 0 · 規格對照表

| # | 你嘅確認 | 我嘅理解 | 落地設計 |
|---|---|---|---|
| 1 | 先做 Android + PC，iPad 暫緩；重用現有 EXE / APK；商家喺設定切換 kiosk mode；適配既有硬件 | Kiosk 唔係新專案，係**同一個 Vercel 站嘅一種裝置模式** | 見 §1 |
| 2 | 同一 Vercel 專案、同一 DB；共用邏輯與元件；Ledger 沿用現有方案 | 唔拆部署、唔拆 DB；**唔新增 server route、唔新增 RPC** | 見 §1.3 |
| 3 | 新增一個獨立嘅「自助點餐機模版」 | `PrintTemplates` 加第四個槽位 `kiosk` | 見 §2 |
| 4 | 掃碼後只將訂單內容傳去 macau-pos；商家確認後沿用「商家代客下單」流程；容許收銀端建 print job | 落單端**只寫 `pos_orders`**；**廚房單一律由收銀端建** | 見 §3 |
| 5 | 免確認，直接出單 | 開關**預設值 = 免確認**（`selfOrderConfirm: false`） | 見 §4 |
| 6 | 置於「店內線下訂單」頁原「刪除全部訂單」按鈕處，直接取代 | `local-orders-panel.tsx` L237 原位替換 | 見 §4 |
| 7 | 訂單頁、收銀台快餐單卡片、結帳畫面均需顯示 | 三處都加來源標記 | 見 §5 |
| 8 | 小票與現有小票格式完全一致，無需額外設計 | 用**同一個 `receipt` 渲染通道**，零跨 repo 改動 | 見 §2.3 |

### 需要講明嘅兩處解讀（若唔啱請即時叫停）

1. **第 5 點「免確認，直接出單」我理解為「開關嘅預設值」**，而唔係「取消開關」。
   理由：第 6 點要求開關要取代「刪除全部訂單」掣，若無開關就冇嘢好取代。
   所以：**開關存在，預設 OFF（免確認直接出單）；商家可自行開 ON（需確認）**。
2. **「商家代客下單」程式碼入面冇呢個名**，我理解為「收銀台嘅正常落單流程」
   （`upsertCurrentOrder("sent_to_kitchen")` + `buildKitchenPrintJobs()` + `buildLabelPrintJobs()`，
   見 `pos-app.tsx` L1993 / L2033）。確認動作會**複用同一組 builder**，唔重新寫一套。

---

## 1 · 平台與部署架構（規格 1、2）

### 1.1 一個站、兩種裝置模式

```
                    ┌─────────────────────────────────────┐
                    │  Vercel：macau-pos-system（同一個）  │
                    │  /        收銀台（POS）              │
                    │  /order   Kiosk（平板三欄）          │
                    │  /menu    掃碼自點（手機單欄）        │
                    │  /orders  訂單（開關喺呢度）          │
                    │  /settings 裝置設定（切 kiosk mode）  │
                    └─────────────────────────────────────┘
                                    │ 同一個 Supabase
                                    ▼
              pos_orders / pos_print_jobs / pos_bootstrap_config ...
```

**唔新增專案、唔新增部署、唔新增 DB。** Kiosk 只係多一個路由同一個裝置旗標。

### 1.2 Kiosk mode 點樣開（零改動重用現有 APK / EXE）

| 平台 | 硬件 | 打印通道 | 需要改 APK / EXE 嗎 |
|---|---|---|---|
| **Android** | 既有 Android 平板 | 既有 Print Agent APK（native bridge）→ LAN:9100 + USB + BT | ❌ **唔使** |
| **PC** | 既有 Windows 桌機 | 既有 desktop Companion（localhost HTTP）→ LAN:9100 + USB + BT | ❌ **唔使** |
| iPad | — | 暫緩（macau-pos 目前亦未支援） | — |

**點解零改動就work到**：Android APK（`MainActivity.kt:413`）載入嘅正正係
`DEFAULT_POS_URL = "https://macau-pos-system.vercel.app"`，係一個**持久化 localStorage 嘅 WebView**。
所以只要喺設定頁寫一個本機旗標，開 app 時由前端自己 redirect 就得 —— APK 唔使重新打包。

**做法**

| 檔案 | 改動 |
|---|---|
| `src/lib/storage.ts` | 新 `loadKioskMode()` / `saveKioskMode()`（key `macau-pos-kiosk-mode`），**純本機，絕不同步上 server** |
| `src/app/page.tsx`（或 `AuthGuard`） | 開機時：若 `kioskMode === true` 且已綁店（`loadKioskDeviceBinding()`）→ `router.replace("/order")` |
| `src/components/device-settings.tsx` 「掃碼點餐」tab | 新增「自助點餐機模式（Kiosk）」區塊：啟用開關、`前往點餐介面`掣、`解除綁定`掣、Kiosk 打印機設定 |
| `src/app/order/page.tsx` | 「裝置設定」彈窗（L471-492）加「退出 Kiosk 模式」（要 PIN 或長按，防客人亂撳） |

> **留意**：`kioskMode` 唔好寫落 `pos_device_configs` —— 嗰條 GET 係
> `.order("updated_at", desc).limit(1)` **冇 store filter** = 全店最新一條任何 terminal
> （同 `autoAccept` bug 同一個坑）。旗標**永遠只留本機**。

### 1.3 Ledger 對接：完全沿用現有方案（**唔新增 RPC、唔新增 server route**）

上一輪（`docs/86` §5 問題二）我提過 Kiosk 係匿名裝置、call 唔到 Ledger RPC。
商務規格第 2 點定咗「Ledger 對接直接沿用現有 macau-pos 接 Ledger 的方案」→ **方案 A**：

```
商家喺收銀台設定頁（已登入狀態）撳「啟用 Kiosk 模式」
        │
        ├─ 當刻部機已經有 loadAuthSession()（含 ledgerAccessToken / ledgerRefreshToken）
        │
        └─ 保留呢個 session 喺本機（唔清走）
                    │
                    ▼
Kiosk 之後 call lookupCustomerWallet() / applyPosDeduct() ——
同 macau-pos 收銀台一模一樣嘅 client 路徑，零新 code
```

| 檔案 | 改動 |
|---|---|
| `src/components/login-screen.tsx:80-88` | `mode === "kiosk"` 分支**唔好淨係 `saveKioskDeviceBinding()` 就走**，要同時 `saveAuthSession(session)`（現況係掉咗個 session） |
| `src/lib/kiosk-order.ts` | 會員查餘額 / 扣款直接用 `lookupCustomerWallet` / `applyPosDeduct`（同收銀台） |
| `src/app/order/page.tsx` | 落單後彈會員號彈窗（8 位澳門手機，reuse `src/lib/ledger/phone.ts`） |

**前提（`docs/integration/ledger-client-api.md:185`）**：
「所有 RPC 須在 **authenticated** session 下呼叫，權限由 `is_merchant_staff(p_merchant_id)` 或 `auth.uid()` 保證。」
→ Kiosk 持有一個**真實店員 session** 就符合要求；用 service_role 打反而唔得（`auth.uid()` = null）。

**安全建議（唔阻塞，但要寫落文檔）**：Kiosk 模式建議用**專設嘅低權限店員帳號**登入（只有 cashier 權限），
唔好用老闆帳號。`ensureLedgerSession()` 已會自動 refresh token 並寫返 storage。

**會員餘額語義**：`LedgerCustomerWallet.balanceAvos` **已經係「已付餘額 + 贈送餘額」嘅合計**
（`src/lib/ledger/member-types.ts` L40-41 有警告），**唔好再加一次 `giftBalanceAvos`**。
換算用 `avosToMop` / `mopToAvos`（avos = 分）。

---

## 2 · 模版設計（規格 3、8）

### 2.1 第四個槽位 `PrintTemplates.kiosk`

```ts
// src/lib/types.ts
export interface PrintTemplates {
  receipt: ReceiptTemplate;
  label: LabelTemplate;
  kitchen: KitchenTemplate;
  kiosk: ReceiptTemplate;      // ← 新增：自助點餐機模版（結構同收據，但係獨立槽位）
}
```

| 檔案 | 改動 |
|---|---|
| `src/lib/types.ts` L295-299 | `PrintTemplates` 加 `kiosk: ReceiptTemplate` |
| `src/lib/escpos-template.ts` | 新 `DEFAULT_KIOSK_TEMPLATE: ReceiptTemplate` = **`DEFAULT_RECEIPT_TEMPLATE` 嘅深拷貝**（符合規格 8「格式完全一致、無需額外設計」） |
| `src/lib/storage.ts` L253-269 `normalizePosLocalSettings()` | 加 `kiosk` 嘅 merge（同 `receipt` 一式一樣，`DEFAULT_KIOSK_TEMPLATE` 做底） |
| `src/lib/mock-data.ts` L424-470 | 加 `printTemplates.kiosk` 預設值 |
| `src/components/print-center.tsx` | 第 4 個分頁「自助點餐機模版」（見 §2.2） |

### 2.2 打印頁加第四個分頁

`src/components/print-center.tsx` 要改嘅位：

| 行 | 改動 |
|---|---|
| L41 | `TemplateKindState` union 加 `"kiosk"` |
| L43-47 | `SECTION_META` 加 `kiosk: RECEIPT_SECTION_META`（共用收據嘅區塊中繼資料，唔使新設計） |
| L118 | `activeTab` union 加 `"kiosk-template"` |
| L126-129 | `selectedSection` 加 `kiosk: "store_name"` |
| L273 `buildPreviewLines` | 加 kiosk 分支 |
| L374 `renderDesigner` | 加 kiosk 分支（tab 掣 + 標題「自助點餐機模版」） |
| `readTemplate` / `applyTemplate` / `patchBlock` / `moveSection` / `setFooter` | 加 `"kiosk"` case（全部照 `receipt` 抄） |

### 2.3 渲染：`kind` 保持 `"receipt"` → **零跨 repo 改動**（規格 8 嘅關鍵）

```ts
const template = buildSnapshot("receipt", kioskTemplate);   // ← kind 係 "receipt"，唔係 "kiosk"
```

`PrintTemplateKind` union **唔加 `"kiosk"`**。原因：

- `src/lib/escpos-render.ts` L11-15 `TITLE` ：`receipt → "＊＊＊ 收據 ＊＊＊"`
- `companion-server.mjs` L347-349：同一套判斷
- print-agent-android `EscPosRenderer.kt`：同一套

→ 若 `kind = "kiosk"`，三個 repo 全部 fall through 去 `""`（無抬頭），**格式就唔一致**。
→ `kind = "receipt"` 的話，三個 repo **原封不動**就印到一張同收據一模一樣嘅單。

**結論：自助點餐機小票 = 用 `kiosk` 模版內容 + `receipt` 渲染通道 → 格式完全一致，APK / EXE / Companion 統統唔使改。**

> 代價／限制（已知，接受）：現有收據嘅 item line 只印「品名 + 數量」，**總計**印喺 `total` 區塊。
> 所以自助點餐機小票會印：門店名、單號、類型／桌台、菜品明細（名 + 數量 + 規格 + 備註）、**總計**、付款方式、全單備註、頁尾。
> **逐項單價唔會印**（`PrintItemLine` 冇價格欄位，改佢要動三個 repo + 重新打包 Companion / APK）。
> 若日後要逐項單價，作為**獨立後續任務**做（`PrintItemLine` 加 optional `unitPrice`／`amount`，
> 向後兼容，舊 Companion / APK 忽略未知欄位唔會爆）。

---

## 3 · 下單流程（規格 4、5）

### 3.1 職責切分（**廚房單一律由收銀端建** —— 呢條根治雙重打印）

| 端 | 職責 | 建立嘅 print job |
|---|---|---|
| **Kiosk / 掃碼落單端** | 只寫 `pos_orders`（`status` 由開關決定）+ `source` 標記 | **顧客小票**（Kiosk 本機打印機；掃碼單冇本地機 → 由收銀端補） |
| **收銀端（macau-pos）** | realtime 收到新單 → 確認（視開關）→ **代客下單**流程 | **廚房單**（沿用現有 `buildKitchenPrintJobs`）+ **標籤單** + **掃碼單嘅顧客小票** |

咁做嘅好處：
- **冇雙重打印**（收銀端係廚房單嘅唯一建立者）
- **Kiosk 只需要一部機**（印顧客小票），廚房機繼續用商家既有嘅分區打印機
- **掃碼單同 Kiosk 單行為完全一致**（顧客小票都係同一個 `kiosk` 模版）
- 符合規格 4「同時容許由收銀端建立 print job」

### 3.2 免確認（**預設**）

```
客人落單（Kiosk 或掃碼）
   │
   ├─ buildKioskOrder() → status: "sent_to_kitchen"（唔再係 draft）
   ├─ source: "kiosk" | "scan"
   ├─ POST /api/pos/sync（ORDER_CREATED）
   │
   ├─ Kiosk：本機建「顧客小票」print job → Kiosk 打印機出紙
   │  掃碼：唔建（客人部機冇打印機）
   │
   └─ 收銀端 realtime 收到 →
        ├─ buildKitchenPrintJobs()  → 廚房單（沿用現有 kitchen 模版）
        ├─ buildLabelPrintJobs()    → 杯標籤（沿用現有 label 模版）
        └─ 若 source === "scan" → buildKioskReceiptPrintJobs() 補顧客小票
```

### 3.3 需確認（商家開咗開關）

```
客人落單 → status: "draft"
   │
   └─ 收銀端「訂單」頁出現「待確認」單
        │
        ├─ 店員撳「確認」
        │     └─ 【複用現有商家代客下單流程】
        │          upsert 訂單 → status: "sent_to_kitchen"
        │          + buildKitchenPrintJobs() / buildLabelPrintJobs()
        │
        └─ 或撳「拒絕」→ status: "cancelled"
```

**呢個路徑會抽成一條共用函數**，放 `src/lib/pos-orders.ts`：

```ts
export function confirmSelfOrder(orderId: string): { ok: boolean; error?: string }
// 1. loadOrders() 搵單
// 2. buildKitchenPrintJobs() + buildLabelPrintJobs()（同 pos-app.tsx L2033 一模一樣）
// 3. status → sent_to_kitchen + sentToKitchenAt
// 4. saveOrders + saveQueue(ORDER_UPDATED) + appendPrintJobs()
```

### 3.4 要改嘅檔案

| 檔案 | 改動 |
|---|---|
| `src/lib/use-kiosk-order.ts` L377 | **移除** `buildKioskKitchenPrintJobs()` 呼叫（廚房單改由收銀端建） |
| `src/lib/kiosk-order.ts` L166-188 | `buildKioskKitchenPrintJobs()` 標記 deprecated 或刪除；新增 `buildKioskReceiptPrintJobs()` |
| `src/lib/print-jobs.ts` L48-82 | `buildReceiptPrintJobs()` 加 optional opts：`{ templateKind?: "receipt" \| "kiosk"; printers?: DevicePrinterConfig[] }`（**共用同一個 builder**，唔另寫一套） |
| `src/components/pos-app.tsx` `onOrderUpsert` L692-705 | realtime 收到 `source` 係 `kiosk` / `scan` 嘅新單 → 建廚房單 + 標籤單 +（scan 先建）顧客小票；**用 `order.id` 去重防重印** |
| `src/lib/pos-orders.ts` | 新 `confirmSelfOrder()`（共用落單邏輯） |
| `src/components/local-orders-panel.tsx` | draft 單顯示「確認 / 拒絕」掣 |

---

## 4 · 開關與按鈕（規格 5、6）

### 4.1 設定項改名 + 真源搬到 DB

| 檔案 | 改動 |
|---|---|
| `src/lib/types.ts` L339 | `kioskKitchenMode: "auto" \| "dine_in_confirm"` → **`selfOrderConfirm: boolean`**（`false` = 免確認，**預設 `false`** 符合規格 5） |
| `src/lib/storage.ts` L288-289 | 改名 + 舊值 migration（`dine_in_confirm` → `true`，`auto` → `false`） |
| `src/lib/mock-data.ts` L485 | 預設 `selfOrderConfirm: false` |

### 4.2 按鈕位置：原位取代（規格 6）

`src/components/local-orders-panel.tsx`：

| 行 | 改動 |
|---|---|
| L235-243 | 「刪除全部訂單」掣 → 換成 **「自助點餐單需確認」開關**（inline toggle，唔係彈窗） |
| L453-487 | 「確認刪除全部」modal 同 `confirmDeleteAllOpen` / `deletingAll` / `handleDeleteAllOrders` **註解封存**（唔刪，留還原說明） |
| L457 | `title="刪除全部訂單"` 同上封存 |

開關外觀建議（同頁其他 `STATUS_TABS` 風格一致）：

```tsx
<button
  type="button"
  className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
    selfOrderConfirm ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
  }`}
  onClick={() => setSelfOrderConfirm(!selfOrderConfirm)}
>
  自助點餐單需確認：{selfOrderConfirm ? "開" : "關"}
</button>
```

### 4.3 真源：按 `store_id` 落 DB（Kiosk 落單時讀一次）

規格 2 講明同一個 DB，所以開關值要落 DB 畀 Kiosk 讀（Kiosk 讀自己 localStorage 係死 code，見 `docs/86` P0 #4）。

| 做法 | 評價 |
|---|---|
| `pos_kiosk_settings`（按 `store_id` 主鍵，新表） | ✅ **推薦**（`docs/85` §2.1 已設計） |
| `pos_bootstrap_config` 加一個欄位 | ✅ 都可以，少一張表 |
| `pos_device_configs` | ❌ **絕對唔好**：GET 冇 store filter = 全店最新一條任何 terminal |

Kiosk **落單時 GET 一次**就夠，**唔使 polling**。

> ⚠️ `src/components/device-settings.tsx` L461-463 `syncConfig()` 會 POST 成份 `localSettings` 上 server。
> 要確保 `selfOrderConfirm` **唔好**跟住上去（同 `onlineOrderSettings.autoAccept` 嗰個 bug 一樣嘅坑）。

---

## 5 · 訂單來源標記（規格 7）

### 5.1 鎖快餐（`docs/86` §1.5a 仍然有效）

| 檔案 | 改動 |
|---|---|
| `src/lib/use-kiosk-order.ts` L264 | `mode` 硬寫 `"quick"`，唔理 `tableId` |
| `src/lib/use-kiosk-order.ts` L266-271 | `tableName` 一律「自取」；`quickType` 鎖 `"pickup"`，**唔提供外賣** |
| `src/lib/use-kiosk-order.ts` L341 | 落單號碼 kind 一律 `pickup` |
| `src/lib/kiosk-order.ts` L81-163 | dine_in 分支（`draft` + `dine_in_confirm`）變死路 → 封存 |
| `src/lib/use-kiosk-order.ts` L384-387 | 落單後唔保留本枱單（**唔畀加單**） |

> 鎖嘅係 **Kiosk / 掃碼端**。收銀台開枱堂食落單**唔受影響**。

### 5.2 新欄位 `source`

```ts
// src/lib/types.ts，PosOrder（L373 附近）
source?: "pos" | "kiosk" | "scan";
```

| 層 | 檔案 | 改動 |
|---|---|---|
| DB | `supabase/migrations/0015_pos_self_order.sql` | `ALTER TABLE pos_orders ADD COLUMN source text NOT NULL DEFAULT 'pos';` + index |
| 同步 | `src/app/api/pos/sync/route.ts` L45-70 | ORDER_CREATED / ORDER_UPDATED 加寫 `source: order.source ?? "pos"` |
| 映射 | `src/lib/pos/pos-order-mapper.ts` L4-52 | `PosOrderRow` + `mapPosOrderRow()` 加 `source` |
| 寫入 | `src/lib/kiosk-order.ts` `buildKioskOrder()` | 加 `source` 參數：Kiosk 設備 → `"kiosk"`；掃碼連結 → `"scan"` |
| 寫入 | `src/components/pos-app.tsx` 落單路徑 | 一律 `"pos"` |

### 5.3 三處顯示（規格 7）

`src/lib/pos-order-filters.ts` 新增（同 `getOrderStatusBadge` 一樣嘅 token 結構）：

```ts
export function getOrderSourceBadge(order: PosOrder): OrderStatusBadge | null {
  if (order.source === "kiosk") return { label: "自助點餐機", bgClass: "bg-blue-50",   textClass: "text-blue-700",   dotClass: "bg-blue-500" };
  if (order.source === "scan")  return { label: "掃碼自點",   bgClass: "bg-cyan-50",   textClass: "text-cyan-700",   dotClass: "bg-cyan-500" };
  return null;   // "pos" 唔顯示（收銀台自己落嘅單唔使標記）
}
```

| 顯示位置 | 檔案 |
|---|---|
| ① 訂單頁（店內線下訂單列表） | `src/components/local-orders-panel.tsx` 訂單卡片，放狀態 badge 隔離 |
| ② 收銀台快餐單卡片 | `src/components/pos-app.tsx` 快餐未完成單卡片（`filterQuickActionBarOrders`） |
| ③ 結帳畫面 | `src/components/pos-app.tsx` 結帳 panel 訂單標題位 |

---

## 6 · 其他必須做嘅嘢

### 6.1 打印份數固定 1（原先需求 8，規格冇推翻）

| 檔案 | 改動 |
|---|---|
| `src/lib/types.ts` `PrintJob` L450-472 | 加 `copies?: number` |
| `src/lib/print-bridge/dispatch.ts` L117 | `const copies = job.copies ?? Math.max(1, Math.floor(printer.copies ?? 1));` |
| `src/lib/kiosk-order.ts` 顧客小票 builder | 一律帶 `copies: 1` |
| Kiosk 打印機設定 UI | **唔顯示**「打印份數」欄位，儲存時寫死 `copies: 1` |

> ⚠️ `printer.copies` 係**跟打印機**唔係跟訂單。若廚房機設咗 2 份，
> 淨係喺 Kiosk UI 隱藏份數欄位係唔夠嘅 —— 一定要喺 **job 層面**固定。

### 6.2 Kiosk 打印機：沿用現有方案（規格 1「適配既有硬件」）

| 檔案 | 改動 |
|---|---|
| `src/lib/kiosk-order.ts`（或新 `kiosk-printer.ts`） | `loadKioskPrinterConfig()` / `saveKioskPrinterConfig()`（key `macau-pos-kiosk-printer`，本機 localStorage） |
| `src/app/order/page.tsx` L471-492 | 「裝置設定」彈窗加「自助點餐機打印機」區塊，**直接 reuse `PrinterWizardModal`**（`printer-wizard-modal.tsx:39`，LAN 用 `probeLan`、USB 用 `enumerateCompanionUsbPrinters`，已經支援晒）+ `PrinterCardV2` |
| `src/lib/print-bridge/hub.ts` `resolveJobPrinter()` | printers 來源改為 `[...loadDeviceConfig().printers, ...loadKioskPrinters()]`（非 Kiosk 機回 `[]` → **零行為改變**） |

### 6.3 自取流程：放寬「可取餐」閘門

`src/lib/quick-order-fulfillment.ts:33`：

```ts
if (!target || target.tableId !== "counter" || target.status !== "paid") return null;
```

「未付款就唔准標記可取餐」→ 同「先出餐後付款」衝突，快餐單會**卡死喺「製作中」**。

| 檔案 | 改動 |
|---|---|
| `src/lib/quick-order-fulfillment.ts` `updateQuickFulfillmentInStore()` | 閘門放寬為接受 `draft` / `sent_to_kitchen` / `paid`（保留 `tableId === "counter"` 同終態單過濾） |
| `src/components/local-orders-panel.tsx` `QuickOrderActions` L54-80 | 顯示條件改為「非終態 且 `fulfillmentStatus !== "ready"`」 |
| `src/lib/pos-order-filters.ts` `matchesLocalOrderPanelTab()` / `getOrderStatusBadge()` | 同步放寬 |

---

## 7 · DB migration（新檔案 `supabase/migrations/0015_pos_self_order.sql`）

```sql
-- 1. 訂單來源（規格 7）
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pos';
CREATE INDEX IF NOT EXISTS idx_pos_orders_source ON pos_orders (store_id, source);

-- 2. print job 模板快照 / 靜態內容 / 打印機綁定
--    （收銀端建嘅 job 同步去第二部機時要靠呢三欄保住內容，否則兩邊印出嚟唔一致）
ALTER TABLE pos_print_jobs ADD COLUMN IF NOT EXISTS template   jsonb;
ALTER TABLE pos_print_jobs ADD COLUMN IF NOT EXISTS content    jsonb;
ALTER TABLE pos_print_jobs ADD COLUMN IF NOT EXISTS printer_id text;

-- 3. 自助點餐設定（按店；開關「自助點餐單需確認」嘅真源，規格 5、6）
CREATE TABLE IF NOT EXISTS pos_kiosk_settings (
  store_id           text PRIMARY KEY,
  self_order_confirm boolean NOT NULL DEFAULT false,   -- false = 免確認直接出單（預設）
  updated_at         timestamptz NOT NULL DEFAULT now()
);
```

配套：`src/app/api/pos/sync/route.ts` L93-111 `PRINT_JOB_CREATED` 補寫 `template` / `content` / `printer_id`；
`src/lib/pos/pos-order-mapper.ts` L58-101 `mapPosPrintJobRow()` 回讀時映射返。

---

## 8 · 判斷邏輯總表（確保 Kiosk / POS 兩端一致）

| 場景 | 判斷 | 結果 |
|---|---|---|
| 呢部機係咪 Kiosk | `loadKioskMode() === true` 且 `loadKioskDeviceBinding()` 有值 | 開機 redirect `/order`；`resolveJobPrinter` 會睇埋 Kiosk 打印機 |
| 落單模式 | Kiosk / 掃碼一律 `mode = "quick"`、`quickType = "pickup"` | `tableId = "counter"`、`tableName = "自取"` |
| 落單號碼 | `POST /api/pos/sequence` kind 一律 `pickup` | 同店共用 `next_daily_sequence` |
| 訂單來源 | Kiosk（有 binding）→ `"kiosk"`；掃碼（有 `?store=` / `?tableId=`）→ `"scan"`；收銀台 → `"pos"` | 寫入 `pos_orders.source` |
| 需要確認？ | 讀 `pos_kiosk_settings.self_order_confirm`（按 `store_id`），**落單時 GET 一次** | `false`（預設）→ `sent_to_kitchen`；`true` → `draft` |
| 廚房單邊個建 | **永遠係收銀端**（realtime 收到新單，或確認嗰刻） | 用 `order.id` 去重，防重印 |
| 顧客小票邊個建 | Kiosk 單 → Kiosk 本機打印機；掃碼單 → 收銀端打印機 | 兩邊都用 `PrintTemplates.kiosk` |
| 顧客小票點渲染 | `buildSnapshot("receipt", kioskTemplate)` —— **kind 保持 `"receipt"`** | 三個 repo 零改動，格式同收據 100% 一致 |
| 打印份數 | `job.copies ?? printer.copies ?? 1`；自助點餐 job 一律帶 `copies: 1` | 永遠 1 張 |
| 可取餐 | `tableId === "counter"` 且非終態（**放寬後唔再要求 `paid`**） | 容許「先出餐後付款」 |
| 會員扣款 | `balanceAvos >= mopToAvos(total)` → `applyPosDeduct` + `paid`；否則 → 提示去收銀台，單維持 `sent_to_kitchen` | 沿用現有 client 路徑，Kiosk 持有店員 session |

---

## 9 · 要一併修嘅 P0（唔係新功能）

| # | 問題 | 位置 | 後果 |
|---|---|---|---|
| 1 | 廚房單**未確認就印咗** | `use-kiosk-order.ts:377` 無條件建 job + `PrintFlushWorker` 2.5 秒 tick | 開關形同虛設 |
| 2 | 雙重打印 | Kiosk 建一次 + 收銀台 `pos-app.tsx:2033` 再建一次（新 uuid） | 廚房出兩份單 → 由 §3.1 職責切分根治 |
| 3 | print job 同步甩內容 | `pos_print_jobs` 欠 `template` / `content` / `printer_id`；`/api/pos/sync` L93-111 只寫 11 欄 | 兩端印出嚟唔一致 |
| 4 | 開關係死 code | `kioskKitchenMode` 由 Kiosk 自己 localStorage 讀，冇設定 UI，永遠 `"auto"` | §4.3 搬到 DB 解決 |
| 5 | 未付款唔准標記可取餐 | `quick-order-fulfillment.ts:33` | §6.3 放寬 |
| 6 | `pos_device_configs` GET 冇 store filter | `/api/pos/device-config` `.order(updated_at desc).limit(1)` | 全店最新一條任何 terminal —— kioskMode 同開關都唔可以擺呢度 |
| 7 | Kiosk 掉咗 Ledger session | `login-screen.tsx:80-88` kiosk 分支只寫 binding | 會員扣款做唔到 → §1.3 保留 session |

---

## 10 · 分階段計劃

| Phase | 內容 | 依賴 |
|---|---|---|
| **1** | DB migration（`source` / print job 三欄 / `pos_kiosk_settings`）+ 型別（`source`、`PrintJob.copies`、`PrintTemplates.kiosk`、`selfOrderConfirm`）+ mapper + sync route | — |
| **2** | 模版：`DEFAULT_KIOSK_TEMPLATE` + storage normalize + mock-data + 打印頁第四個分頁 | 1 |
| **3** | Kiosk mode 基建：`loadKioskMode` + 設定頁區塊 + 開機 redirect + 保留 Ledger session | 1 |
| **4** | 鎖快餐 + `source` 寫入 + 三處 badge（規格 7） | 1 |
| **5** | 職責切分：移除 Kiosk 端廚房單、收銀端 realtime 建單（去重）、`confirmSelfOrder()` | 1、4 |
| **6** | 開關：原位取代「刪除全部訂單」掣 + 真源搬 DB + 確認／拒絕 UI（規格 5、6） | 1、5 |
| **7** | Kiosk 打印機：設定 UI（reuse `PrinterWizardModal`）+ `resolveJobPrinter` 擴充 + 顧客小票 builder | 1、2 |
| **8** | 份數固定 1（`PrintJob.copies`）+ 放寬「可取餐」閘門 | 1 |
| **9** | 會員號彈窗 + 查餘額 + 扣款（沿用現有 Ledger client 路徑） | 3 |
| **10** | 實機驗證：Android APK（LAN + USB）／PC Companion，對照「設計 == 預覽 == 出紙」 | 7 |

**跨 repo 改動：無**（規格 1、2、8 三條夾埋，令 APK / Companion / print-agent-android 全部唔使改）。

---

## 11 · 風險與注意

| 風險 | 說明 | 處理 |
|---|---|---|
| Kiosk 持有店員 session | refresh token 留喺 Kiosk 機嘅 localStorage | 用**專設低權限 cashier 帳號**；`ensureLedgerSession()` 自動 refresh；退出 Kiosk 模式要 PIN |
| 開關真源 | 若照舊讀本機 localStorage，Kiosk 永遠讀到預設值（死 code 重演） | 落 `pos_kiosk_settings` 按 `store_id`；**唔好**用 `pos_device_configs` |
| 逐項單價印唔到 | `PrintItemLine` 冇價格欄位 | 已知限制，接受；列為獨立後續任務（需改三個 repo + 重新打包） |
| 收銀端唔在線 | 廚房單由收銀端建，收銀端熄機就冇廚房單 | 收銀端恢復後要補建（realtime backfill 已有機制，要加「未出過廚房單」標記） |
| 客人亂撳退出 Kiosk 模式 | `/order` 設定彈窗若直接掂到 | 退出要 PIN 或長按 3 秒 |
| `syncConfig()` 把開關寫上 server | 成份 `localSettings` POST 上去 | 要剝走 `selfOrderConfirm`（同 `autoAccept` bug 同款） |
