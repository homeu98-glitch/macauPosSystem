# 86 · 線下自助點餐 v2：八項需求實作範圍確認

> ⚠️ **已被 `docs/87-kiosk-final-plan.md` 取代**（2026-08-31 用家落咗最終確認規格：
> Android + PC 重用現有 APK / EXE、同一 Vercel 專案同一 DB、新增自助點餐機模版、
> 廚房單由收銀端建、開關預設免確認、原位取代「刪除全部訂單」掣、來源標記顯示三處、
> 小票格式沿用現有收據）。本文件保留作盤點記錄。
>
> 日期：2026-08-31
> 取代：`docs/85-kiosk-self-order-plan.md`（v1 方向已被 2026-08-31 嘅八項需求修正，85 保留作歷史記錄）
> 範圍：Kiosk 自助點餐機 ＋ 店內掃碼自點（`/order`、`/menu`），**兩者都走 `pos_orders`、無 `onlineOrderId`**
> 唔包：Ledger 會員通線上訂單（外賣／自取已有 `onlineOrderSettings.autoAccept` + 手動接單層）

---

## 0 · 一句講晒

八項需求入面，**第 1、3、4 項各有一個技術／物理阻點要先拍板**，其餘（2、5、6、7、8）範圍清晰、可以直接開工。
最關鍵係：**Kiosk 部機係咩硬件**，因為瀏覽器本身冇能力直接駁 LAN:9100 或 USB 打印機。

---

## 1 · 逐項實作範圍確認

### 需求 1 — Kiosk 專屬打印機，沿用現有 macau-pos 方案（USB + LAN）

**現有基建（可以直接搬，唔使重新發明）**

| 項目 | 位置 | 狀態 |
|---|---|---|
| `DevicePrinterConfig` | `src/lib/types.ts:169-220` | ✅ 已支援 `connectionType: "lan" \| "usb" \| "bluetooth"`；LAN 有 `ipAddress` / `lanPort`，USB 有 `usbPort` / `usbVendorId` / `usbProductId` |
| `PrinterWizardModal`（三步驟設定精靈） | `src/components/printer-wizard-modal.tsx:39` | ✅ LAN 用 `probeLan()`、USB 用 `enumerateCompanionUsbPrinters()`，可直接 reuse |
| `PrinterCardV2`（已配打印機卡片） | `src/components/printer-card-v2.tsx:38` | ✅ 可 reuse |
| 派發路由 | `src/lib/print-bridge/dispatch.ts` `dispatchOneJob()` | ✅ 三級 fallback：native bridge → 桌面 Companion → Cloud Print Relay |
| `PrintFlushWorker` | `src/components/print-flush-worker.tsx`，2.5 秒 tick，掛喺 `src/app/layout.tsx:55` | ✅ 全站生效，`/order` / `/menu` 一樣會 flush |

**要改嘅檔案**

| 檔案 | 改乜 |
|---|---|
| `src/app/order/page.tsx` | 「裝置設定」彈窗（L471-492）加「自助點餐機打印機」區塊：reuse `PrinterWizardModal` + `PrinterCardV2`；加「測試打印」掣 |
| `src/lib/kiosk-order.ts`（或新開 `kiosk-printer.ts`） | 新 `loadKioskPrinterConfig()` / `saveKioskPrinterConfig()`，寫 Kiosk 本機 localStorage（新 key `macau-pos-kiosk-printer`，唔好污染收銀端 `loadDeviceConfig()`） |
| `src/lib/print-bridge/hub.ts` | `resolveJobPrinter(job)` 要識得喺 Kiosk 環境改讀 Kiosk printer config（而家只讀收銀端 `loadDeviceConfig().printers`） |

**⚠️ 物理限制（一定要先搞清楚，呢個決定晒成個第 1 + 第 4 點點做）**

瀏覽器（Chrome / Edge / Safari）**冇能力開 raw TCP socket 打 LAN:9100，亦冇 USB 權限**。
所以「LAN / USB」其實係靠**打印通道**駁出去，`dispatch.ts` 嘅三條路：

| 通道 | 邊度跑 | LAN | USB | 備註 |
|---|---|---|---|---|
| Native bridge | Android APK（`print-agent-android`） | ✅ `net/EscPosPrinter.kt` raw socket `IP:9100` | ✅ `usb/UsbPrinter.kt` + `UsbController` | 最乾淨，已實作 |
| 桌面 Companion | Windows / macOS / Linux（localhost HTTP） | ✅ LAN:9100 | ✅ `usbPort` OS spooler + node-usb | 要喺**同一部機**裝 Companion |
| Cloud Print Relay | 互聯網 → 店內 Stationary Agent | ✅ | ✅ | 備援，要額外部署 |

→ **要你答**：Kiosk 部機係咩硬件／OS？見 §5 問題一。

---

### 需求 2 — 線下自取，客人憑紙單取餐，唔使加功能

**結論：介面唔加嘢，但有一條程式閘門必須放寬，否則流程行唔通。**

`src/lib/quick-order-fulfillment.ts:33`：

```ts
if (!target || target.tableId !== "counter" || target.status !== "paid") return null;
```

即「**未付款就唔准標記可取餐**」。而需求 3 嘅流程係：

```
落單 →（可選會員扣餘額／或去收銀台俾錢）→ 出餐 → 客人憑紙單取餐 → 完成
```

如果客人揀「去收銀台付款」，單據會一路停留喺 `sent_to_kitchen`（未 `paid`），
「可取餐」掣因為呢條閘門而永遠撳唔到 → 快餐單**卡死喺「製作中」**，入唔到「待取餐」tab。

**要改**

| 檔案 | 改乜 |
|---|---|
| `src/lib/quick-order-fulfillment.ts` `updateQuickFulfillmentInStore()` | 閘門由 `status !== "paid"` 放寬為接受 `draft` / `sent_to_kitchen` / `paid`（只保留 `tableId === "counter"` 同終態單嘅過濾） |
| `src/components/local-orders-panel.tsx` `QuickOrderActions`（L54-80） | 顯示條件由 `order.status === "paid" && fulfillmentStatus !== "ready"` 改為「非終態 且 `fulfillmentStatus !== "ready"`」 |
| `src/lib/pos-order-filters.ts` `matchesLocalOrderPanelTab()` / `getOrderStatusBadge()` | 同步放寬，等未付款嘅 counter 單都可以喺「製作中 / 待取餐」tab 之間走 |

呢個**唔係新功能**，係解除「先出餐後付款」同現有「先付款後出餐」假設之間嘅衝突。

---

### 需求 3 — 落單後彈會員號彈窗，餘額夠就扣，唔夠改去收銀台

**要做嘅 UI**

| 檔案 | 改乜 |
|---|---|
| `src/app/order/page.tsx` | 落單成功後彈「輸入會員號」彈窗（8 位澳門手機號，reuse `src/lib/ledger/phone.ts` 嘅 `normalizePhone` / `isValidMacauPhone`） |
| `src/lib/kiosk-order.ts` / `use-kiosk-order.ts` | 查餘額 → 成功則 `applyPosDeduct` → 訂單寫 `paymentMethod: "member"` + `status: "paid"`；失敗／餘額不足 → 提示「請到收銀台付款」，單維持 `sent_to_kitchen` |

**⚠️ 技術阻點：Kiosk call 唔到 Ledger RPC**

1. `lookupCustomerWallet()` / `applyPosDeduct()`（`src/lib/ledger/members.ts`）係 `"use client"` 模組，
   經 `requireRpcClient()`（L20-30）→ `ensureLedgerSession()`（`src/lib/ledger/session.ts:13`）需要
   `loadAuthSession()` 有 `ledgerAccessToken` / `ledgerRefreshToken`。
2. Kiosk 係**匿名裝置**：`login-screen.tsx:81` kiosk mode 只 `saveKioskDeviceBinding()`，
   **唔寫 auth session** → Kiosk 瀏覽器根本冇 Ledger session → RPC 必定失敗。
3. 就算改做 server API 用 service_role 打 RPC 都唔得：`docs/integration/ledger-client-api.md:185` 講明
   「所有 RPC 須在 **authenticated** session 下呼叫。權限由 RPC 內 `is_merchant_staff(p_merchant_id)`
   或 `auth.uid()` 保證。」→ service_role 嘅 `auth.uid()` 係 null → `is_merchant_staff` 返 false → RPC 駁回。

**三個可行方案（要你揀，見 §5 問題二）**

| 方案 | 做法 | 優點 | 代價 |
|---|---|---|---|
| **A · Kiosk 設備綁店員帳號** | Kiosk「裝置設定」用 phone + 4 位 PIN 登入一次（`src/app/api/ledger/login` 已有），session 存本機 localStorage | 完全貼合現有合約，Ledger 唔使改 | Kiosk 機要存 refresh token；Kiosk 要當可信設備（放店內、店員先掂到） |
| **B · Ledger 新寫 kiosk 專用 RPC** | POS 加 server route 用 service_role call 新 RPC（如 `kiosk_lookup_customer_wallet` / `kiosk_apply_pos_txn`），函式內做 scope 限制 | 安全邊界最清晰，Kiosk 唔使存憑證 | 要 Ledger 同事配合新寫 RPC，排期受制於人 |
| **C · 暫緩會員自助扣款** | Kiosk 落單只出紙單，全部去收銀台付款（收銀台已有 `executeLedgerMemberCheckout`） | 最快上線，零跨 team 依賴 | 做唔到你想要嘅「會員自助扣餘額」 |

**會員餘額語義提醒**：`LedgerCustomerWallet.balanceAvos` **已經係「已付餘額 + 贈送餘額」嘅合計**
（`src/lib/ledger/member-types.ts` L40-41 有警告），**唔好再加一次 `giftBalanceAvos`**，會 double count。
金額換算用 `avosToMop` / `mopToAvos`（avos = 分）。

---

### 需求 4 — 落單後必須打印小票；掃碼下單由收銀台打印機出，模板與小票格式一致

**Kiosk（`/order`）**：落單後即時喺 Kiosk 打印機出「顧客小票」（下單編號 ＋ 品項 ＋ 價格 ＋ 合計）。

**掃碼下單（`/menu`，客人自己手機）**：客人部機冇打印機 → **由收銀台端打印機出**。

> ⚠️ 呢度同你上一次（message 2 第 3 點）講嘅「不要…改由收銀端建 print job」表面上衝突。
> 我嘅理解係：嗰句係針對**廚房單**（怕改壞現有廚房出單流程），而家第 4 點講嘅係**顧客小票**，兩者唔同。
> → **要你確認**，見 §5 問題四。

**要改嘅檔案**

| 檔案 | 改乜 |
|---|---|
| `src/lib/print-jobs.ts` | 新增 `buildKioskReceiptPrintJobs(order, printer)`，對齊現有 `buildReceiptPrintJobs`（L48-82）做法：帶 `template` 快照 + `content` + `printerId` |
| `src/lib/use-kiosk-order.ts` `placeOrder()`（L329-393） | 落單後建顧客小票 print job，`appendPrintJobs()` 落本機 |
| `src/components/pos-app.tsx` `onOrderUpsert`（L692-705） | realtime 收到 `source === "scan"` 嘅新單 → 喺收銀端建顧客小票 print job（只建一次，靠 `order.id` 去重） |

**「模板與小票格式一致」嘅兩個選擇（要你揀，見 §5 問題三）**

- (a) 沿用現有 `PrintTemplates.receipt`（收據模板）— 唔使新模板，但收據模板係「結帳收據」格式，可能有付款方式／找續等對落單當刻無意義嘅區塊
- (b) 新增 `PrintTemplates.kiosk`（message 2 提過嘅「自助點餐機模版」），Kiosk 小票同掃碼單收銀小票**共用同一個**

**⚠️ 大坑：小票要印價格，但 `PrintJob` 冇價格欄位**

```ts
// src/lib/escpos-render.ts:3
export type PrintItemLine = { name: string; quantity: number; specs?: string[]; note?: string };
```

三個 repo 嘅渲染器都淨係印 `name` + `quantity`：

| Repo | 位置 | 現況 |
|---|---|---|
| POS | `src/lib/escpos-render.ts` `renderEscPosLines()` | 冇價格 |
| desktop-companion | `companion-server.mjs:355` `` `${i + 1}. ${it.name}  ${qty}` `` | 冇價格 |
| print-agent-android | `net/EscPosRenderer.kt:249` `"${i + 1}. ${it.name}  x$qty"` | 冇價格 |

→ **要印價格，兩條路揀一條**（見 §5 問題五）：

| 路線 | 做法 | 代價 |
|---|---|---|
| **路線 1 · 改 `PrintItemLine`** | 加 `unitPrice` / `amount`；三個 repo 渲染器全部改 | 要同步改 3 個 repo + 重新打包 Companion / APK；`pos_print_jobs.items` 係 JSONB **唔使 DDL** |
| **路線 2 · 預渲染 `content`** | 落單端用 `renderEscPosLines()` 渲染好成行陣列，print job 帶 `renderedLines: EscPosLine[]`，打印端有就直出 | 唔使改 3 個 repo 渲染器；但要 `pos_print_jobs` 加 `content` 欄位 + `/api/pos/sync` 支援寫入，且 Companion / APK 要識**優先讀 `renderedLines`** |

我傾向**路線 2**：一次過解決「模板快照點樣跨 repo 一致」嘅老問題，亦係 `docs/85` 已經提出嘅方向。

---

### 需求 5 — 鎖定只做快餐，唔支援堂食；新增訂單來源欄位 + UI 標記

#### 5a · 鎖快餐

`src/lib/use-kiosk-order.ts:264`：

```ts
const mode: "dine_in" | "quick" = tableId ? "dine_in" : "quick";
```

改為**永遠 `"quick"`**，連帶：

| 檔案 | 改乜 |
|---|---|
| `src/lib/use-kiosk-order.ts:264` | `mode` 硬寫 `"quick"`，唔理 `tableId` |
| `src/lib/use-kiosk-order.ts:266-271` `tableName` | 一律「自取」；`quickType` 鎖 `"pickup"`，**唔提供外賣選項** |
| `src/lib/use-kiosk-order.ts:341` | 落單號碼 kind 一律 `pickup`（`POST /api/pos/sequence`） |
| `src/lib/kiosk-order.ts:81-163` `buildKioskOrder()` | dine_in 分支（`draft` + `dine_in_confirm`）變成死路 → 移除或標記 deprecated |
| `src/lib/use-kiosk-order.ts:384-387` | 落單後唔保留本枱單（`setTableOrder(null)`），即**唔畀加單** |

注意：鎖嘅係 **Kiosk / 掃碼端**。收銀台開枱堂食落單（`pos-app.tsx`）**唔受影響**，繼續行得通。

#### 5b · 新增來源欄位

```ts
// src/lib/types.ts，PosOrder（L373 附近）加
source?: "pos" | "kiosk" | "scan";
```

| 層 | 檔案 | 改乜 |
|---|---|---|
| DB | 新 migration `0015_pos_order_source.sql` | `ALTER TABLE pos_orders ADD COLUMN source text NOT NULL DEFAULT 'pos';` + index |
| 同步 | `src/app/api/pos/sync/route.ts` L45-70 | ORDER_CREATED / ORDER_UPDATED 加寫 `source: order.source ?? "pos"` |
| 映射 | `src/lib/pos/pos-order-mapper.ts` `PosOrderRow` + `mapPosOrderRow()`（L4-52） | 加 `source: string \| null` → `source` |
| Realtime | `src/lib/pos/use-pos-realtime.ts` | 確認 `pos_orders` realtime payload 帶新欄（依 `*`，通常自動） |
| 寫入 | `src/lib/kiosk-order.ts` `buildKioskOrder()` | 加 `source` 參數：Kiosk 設備 → `"kiosk"`；`/menu` 掃碼 → `"scan"` |
| 寫入 | `src/components/pos-app.tsx` 落單路徑 | 一律 `"pos"` |
| UI | `src/components/local-orders-panel.tsx` | 訂單卡片加來源標記 |
| UI | `src/lib/pos-order-filters.ts` | 新增 `getOrderSourceBadge(order): OrderStatusBadge`（同 `getOrderStatusBadge` 一樣嘅 token 結構） |

**建議標記樣式**

| 來源 | 文字 | 配色 |
|---|---|---|
| `kiosk` | 自助點餐機 | 藍 `bg-blue-50 text-blue-700` |
| `scan` | 掃碼自點 | 青 `bg-cyan-50 text-cyan-700` |
| `pos` | （唔顯示，或灰色「收銀」） | — |

> 顯示位置要你確認，見 §5 問題八。

---

### 需求 6 — 廚房單沿用現有模板，唔另建新嘅

**好消息：唔使新模板。但現況係「Kiosk 根本冇用緊任何模板」，要補返一輪嘢。**

`src/lib/kiosk-order.ts:166-188` `buildKioskKitchenPrintJobs()` 產生嘅 job：

```ts
{ id, orderId, orderNo, tableName, ticketType: "normal", printerGroup, printerName, items, status: "pending", createdAt }
```

**冇 `template`、冇 `content`、冇 `printerId`** → 打印端行硬編 fallback（`dispatch.ts` L36-44 有 warn），
結果：冇店名、冇時間、冇訂單類型、冇頁尾，**亦完全唔理商家喺「打印」頁設嘅字型大小**。

**要補嘅嘢**

| 檔案 | 改乜 |
|---|---|
| `src/lib/kiosk-order.ts` `buildKioskKitchenPrintJobs()` | 改用 `buildSnapshot("kitchen", template)` + `buildKitchenContent(...)`，或直接**共用 `src/lib/print-jobs.ts:95` 嘅 `buildKitchenPrintJobs()`** |
| Kiosk 攞模板 | Kiosk 而家完全冇讀 `printTemplates`（只有 `/api/pos/bootstrap` 嘅 menu / tables / rules / printerGroups）。要經 **DB level** 落（你 message 2 嘅要求）：`/api/pos/bootstrap` 加 `printTemplates`，或新開 `/api/pos/print-templates?storeId=` |
| `pos_print_jobs` | 加 3 個欄位：`template jsonb`、`content jsonb`、`printer_id text`（新 migration） |
| `src/app/api/pos/sync/route.ts` L93-111 | `PRINT_JOB_CREATED` 而家只寫 11 個欄位，要補寫 `template` / `content` / `printer_id` |
| `src/lib/pos/pos-order-mapper.ts` `mapPosPrintJobRow()`（L58-101） | 回讀時要映射返 `template` / `content` / `printerId` |

**冇呢三個欄位嘅後果**：就算 Kiosk 建咗個好靚嘅 job，一同步去收銀端／第二部機就甩晒內容，
兩邊印出嚟唔一致 —— 正正違反你「確保 kiosk 與 POS 兩端行為一致」嘅要求。

---

### 需求 7 — 訂單介面開關：堂食與快餐共用，取代「刪除全部訂單」按鈕位置，先隱藏「刪除全部訂單」

**現況位置**

`src/components/local-orders-panel.tsx` L235-243：

```tsx
<button ... onClick={() => setConfirmDeleteAllOpen(true)} disabled={filteredOrders.length === 0}>
  刪除全部訂單
</button>
```

（相關：L457 `title="刪除全部訂單"`、L481 `確認刪除全部`、L484-487 警告文字）

**要改**

| 檔案 | 改乜 |
|---|---|
| `src/components/local-orders-panel.tsx` L237 | 「刪除全部訂單」掣換成「需要確認自助點餐單」開關 |
| `src/components/local-orders-panel.tsx` L453-487 | 隱藏（唔刪除）「確認刪除全部」modal 同相關 state，留註釋講明點樣還原 |
| `src/lib/types.ts` `PosLocalSettings` L339 | `kioskKitchenMode: "auto" \| "dine_in_confirm"` → 改為 `selfOrderConfirm: boolean`（建議名；預設 `true` = 需要確認） |
| `src/lib/storage.ts` `normalizePosLocalSettings()` L288-289 | 同步改名 + migration 舊值（`dine_in_confirm` → `true`，`auto` → `false`） |
| `src/lib/mock-data.ts:485` | 預設值同步 |

**作用域**：堂食（收銀台開枱）＋ 快餐（Kiosk / 掃碼 / 收銀台 counter）**共用一粒開關**。
外賣（Ledger 線上訂單）**唔受影響**，繼續用 `onlineOrderSettings.autoAccept`。

**⚠️ 真源問題（一定要解決，否則會重演 autoAccept 嗰個 bug）**

現況 `kioskKitchenMode` 係由 **Kiosk 自己嘅 localStorage** 讀：

```ts
// src/lib/use-kiosk-order.ts:161
const kitchenMode = loadPosLocalSettings().kioskKitchenMode;
```

而 Kiosk 從來冇人改過呢個設定 → 永遠係 `"auto"` → **開關係死 code**（全 repo 得 7 處 reference，冇任何設定 UI）。

開關擺喺收銀端「訂單」頁 → 值必須**收銀端寫、Kiosk 讀**，而且要經 DB（你 message 2 要求 DB level）：

| 做法 | 評價 |
|---|---|
| `pos_kiosk_settings`（按 `store_id` 主鍵，新表） | ✅ 推薦，`docs/85` §2.1 已設計好 |
| `pos_bootstrap_config` 加一個欄位 | ✅ 都得，少一張表 |
| `pos_device_configs` | ❌ **千祈唔好**：`/api/pos/device-config` GET 係 `.order("updated_at", desc).limit(1)` **冇 store filter** = 全店最新一條任何 terminal，同 autoAccept 嗰個 bug 同一個坑 |

Kiosk 落單前 `GET` 一次（落單時讀就得，**唔使 polling**）。

**⚠️ 確認流程要補（而家員工根本冇嘢好撳）**

`src/components/pos-app.tsx:701-703` 而家只係一粒 **2.6 秒就消失嘅 toast**：

```ts
if (order.status === "draft" && order.tableId && order.tableId !== "counter") {
  setToast({ tone: "info", message: `${order.tableName} 已落單，請確認` });
}
```

要補：

| 檔案 | 改乜 |
|---|---|
| `src/lib/kiosk-order.ts` `buildKioskOrder()` | 開關 ON 時，快餐單落 `status: "draft"`（而唔係而家嘅 `sent_to_kitchen`），等確認 |
| `src/lib/use-kiosk-order.ts:377` | **P0**：`buildKioskKitchenPrintJobs()` 而家係**無條件**建（完全無視 `kitchenMode`），而 `PrintFlushWorker` 2.5 秒內就出紙 → **未確認已經印咗廚房單**。要改為「確認後先建」 |
| `src/components/local-orders-panel.tsx` / `pos-app.tsx` | 加「確認」掣 → 撳先建廚房 print job + 轉 `sent_to_kitchen` |
| `src/components/pos-app.tsx` L75-78 `Toast` type | 而家 `{ tone, message }`，**冇 action 掣**。若想 toast 可以直接撳確認，要加 optional action |

**⚠️ 雙重打印風險**：收銀台撳「落單」時 `pos-app.tsx:2033` 會 `buildKitchenPrintJobs()` 建**新 uuid** 嘅 job
→ 若 Kiosk 已經建過，就會出兩份。要喺確認路徑用**同一個 order.id 去重**。

---

### 需求 8 — 打印數量固定 1 張，唔開放設定

**現況**：`src/lib/print-bridge/dispatch.ts:117`

```ts
const copies = Math.max(1, Math.floor(printer.copies ?? 1));
```

份數由**打印機層級**設定（`DevicePrinterConfig.copies`，types.ts:201）。

**注意坑**：`printer.copies` 係**跟打印機**唔係跟訂單。若廚房機設咗 2 份，而 Kiosk 用同一部機出紙，就會印 2 份。
→ 所以要喺 **job 層面**固定，淨係喺 Kiosk 設定 UI 隱藏份數欄位係唔夠嘅。

**要改**

| 檔案 | 改乜 |
|---|---|
| `src/lib/types.ts` `PrintJob`（L450-472） | 加 `copies?: number` |
| `src/lib/print-bridge/dispatch.ts` `dispatchOneJob()` L117 | `const copies = job.copies ?? Math.max(1, Math.floor(printer.copies ?? 1));` |
| `src/lib/kiosk-order.ts` `buildKioskKitchenPrintJobs()` + 新建嘅 `buildKioskReceiptPrintJobs()` | 一律帶 `copies: 1` |
| Kiosk 打印機設定 UI | **唔顯示**「打印份數」欄位，儲存時寫死 `copies: 1` |

---

## 2 · 檔案改動總表

### 2.1 型別 / 常數

| 檔案 | 改動 |
|---|---|
| `src/lib/types.ts` | `PosOrder.source?: "pos" \| "kiosk" \| "scan"`（L373 附近）；`PrintJob.copies?: number`（L450-472）；`PosLocalSettings` L339 `kioskKitchenMode` → `selfOrderConfirm: boolean` |
| `src/lib/mock-data.ts` | L485 `kioskKitchenMode: "auto"` → `selfOrderConfirm` 預設值 |

### 2.2 儲存 / 規範化

| 檔案 | 改動 |
|---|---|
| `src/lib/storage.ts` | `normalizePosLocalSettings()` L288-289 改名 + 舊值 migration |
| `src/lib/kiosk-order.ts` | `loadKioskPrinterConfig()` / `saveKioskPrinterConfig()`（新）；`buildKioskOrder()` 加 `source`；`buildKioskKitchenPrintJobs()` 補 template/content/printerId/copies |

### 2.3 Kiosk / 掃碼端

| 檔案 | 改動 |
|---|---|
| `src/lib/use-kiosk-order.ts` | L161 開關改由 DB 讀；L264 鎖 `mode = "quick"`；L266-271 tableName 鎖「自取」；L341 序號 kind 鎖 `pickup`；L377 廚房單改為確認後先建；`placeOrder()` 建顧客小票 job |
| `src/app/order/page.tsx` | 「裝置設定」彈窗（L471-492）加打印機設定 + 測試打印；落單後加會員號彈窗 |
| `src/app/menu/page.tsx` | 同步鎖 quick；落單後（如需）會員號彈窗 |

### 2.4 收銀端

| 檔案 | 改動 |
|---|---|
| `src/components/pos-app.tsx` | L692-705 `onOrderUpsert` 加：`source === "scan"` 建顧客小票 job（去重）；draft 單確認路徑；L75-78 `Toast` 加 optional action |
| `src/components/local-orders-panel.tsx` | L237 換開關；L453-487 隱藏「刪除全部訂單」；加來源 badge；加「確認」掣 |
| `src/components/orders-hub.tsx` | （視 §5 問題六）若開關放頁頭就要改 |
| `src/components/device-settings.tsx` | （視需要）「掃碼點餐」tab 加自助點餐設定；L461-463 `syncConfig()` 唔好再把 `selfOrderConfirm` 寫上 server（避免重演 autoAccept） |

### 2.5 打印層

| 檔案 | 改動 |
|---|---|
| `src/lib/print-jobs.ts` | 新增 `buildKioskReceiptPrintJobs()`；`buildKitchenPrintJobs()` 加 `copies` 支援 |
| `src/lib/print-bridge/dispatch.ts` | L117 `copies` 改讀 `job.copies` |
| `src/lib/print-bridge/hub.ts` | `resolveJobPrinter()` 喺 Kiosk 環境改讀 Kiosk printer config |
| `src/lib/escpos-render.ts` | （視 §5 問題五路線 1）`PrintItemLine` 加價格欄位 |
| `src/lib/escpos-template.ts` | （視 §5 問題三）若新增 kiosk 模板要加 `KITCHEN_SECTION_META` 同款嘅 `KIOSK_SECTION_META` + `DEFAULT_KIOSK_TEMPLATE` |
| `src/components/print-center.tsx` | （視 §5 問題三）若新增 kiosk 模板要加分頁（L41 `TemplateKindState`、L43-47 `SECTION_META`、L118 `activeTab`、L374 `renderDesigner`） |

### 2.6 同步 / DB 映射

| 檔案 | 改動 |
|---|---|
| `src/app/api/pos/sync/route.ts` | L45-70 `pos_orders` 加寫 `source`；L93-111 `pos_print_jobs` 補寫 `template` / `content` / `printer_id` |
| `src/lib/pos/pos-order-mapper.ts` | `PosOrderRow` / `mapPosOrderRow()` 加 `source`；`PosPrintJobRow` / `mapPosPrintJobRow()` 加 `template` / `content` / `printerId` |
| `src/lib/pos/use-pos-realtime.ts` | 確認新欄位有跟 realtime payload 落嚟 |

### 2.7 DB migration（新檔案）

```sql
-- supabase/migrations/0015_pos_self_order.sql

-- 1. 訂單來源
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pos';
CREATE INDEX IF NOT EXISTS idx_pos_orders_source ON pos_orders (store_id, source);

-- 2. print job 模板快照 / 預渲染內容 / 打印機綁定
ALTER TABLE pos_print_jobs ADD COLUMN IF NOT EXISTS template   jsonb;
ALTER TABLE pos_print_jobs ADD COLUMN IF NOT EXISTS content    jsonb;
ALTER TABLE pos_print_jobs ADD COLUMN IF NOT EXISTS printer_id text;

-- 3. 自助點餐設定（按店，取代 kioskKitchenMode 嘅本地真源）
CREATE TABLE IF NOT EXISTS pos_kiosk_settings (
  store_id          text PRIMARY KEY,
  self_order_confirm boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
```

（若 §5 問題三揀 (b) 新增 kiosk 模板，就要加對應嘅 API route 去讀寫 `pos_kiosk_settings` 或 `pos_bootstrap_config`）

### 2.8 跨 repo（視 §5 問題五）

| Repo | 檔案 | 改動 |
|---|---|---|
| `C:\dev\desktop-companion` | `companion-server.mjs:355` | 路線 1：item line 加價格；路線 2：優先讀 `renderedLines` 直出 |
| `C:\dev\print-agent-android` | `net/EscPosRenderer.kt:249`；`model/PrintDtos.kt:26-29` | 同上 |

---

## 3 · 判斷邏輯一覽（確保 Kiosk / POS 兩端一致）

| 場景 | 判斷 | 結果 |
|---|---|---|
| 落單模式 | Kiosk / 掃碼一律 `mode = "quick"`、`quickType = "pickup"` | `tableId = "counter"`、`tableName = "自取"` |
| 落單號碼 | `POST /api/pos/sequence` kind 一律 `pickup` | 同店共用 `next_daily_sequence` |
| 訂單來源 | Kiosk 設備（有 `kioskDeviceBinding`）→ `"kiosk"`；掃碼連結（有 `?store=` / `?tableId=`）→ `"scan"`；收銀台 → `"pos"` | 寫入 `pos_orders.source` |
| 需要確認？ | 讀 `pos_kiosk_settings.self_order_confirm`（按 `store_id`），落單時 GET 一次 | `true` → `status: "draft"`；`false` → `status: "sent_to_kitchen"` |
| 廚房單幾時建 | **必須喺確認之後**（`status` 由 `draft` → `sent_to_kitchen` 嗰一刻） | 用 `order.id` 去重，防收銀台再撳落單時雙重打印 |
| 顧客小票 | Kiosk：落單端即建（Kiosk 打印機）；掃碼：收銀端 realtime 收到 `source === "scan"` 時建 | 共用同一個模板 |
| 打印份數 | `job.copies ?? printer.copies ?? 1`；自助點餐 job 一律帶 `copies: 1` | 永遠 1 張 |
| 可取餐 | `tableId === "counter"` 且非終態（**放寬後唔再要求 `paid`**） | 容許「先出餐後付款」 |
| 會員扣款 | 餘額 `balanceAvos >= mopToAvos(total)` → 扣 + `paid`；否則 → 提示去收銀台，單維持 `sent_to_kitchen` | 見 §5 問題二 |

---

## 4 · 已知 P0 問題（本次要一併修，唔係新功能）

| # | 問題 | 位置 | 後果 |
|---|---|---|---|
| 1 | 廚房單**未確認就印咗** | `use-kiosk-order.ts:377` 無條件建 job + `PrintFlushWorker` 2.5 秒 tick | 需求 7 嘅開關形同虛設 |
| 2 | 雙重打印 | Kiosk 建一次 + 收銀台 `pos-app.tsx:2033` 再建一次（新 uuid） | 廚房出兩份單 |
| 3 | Kiosk print job 冇模板快照 | `buildKioskKitchenPrintJobs()` 冇 `template` / `content` / `printerId`；`pos_print_jobs` 亦冇呢啲欄位 | 打印端行硬編 fallback，兩邊印出嚟唔一致 |
| 4 | 開關係死 code | `kioskKitchenMode` 由 Kiosk 自己 localStorage 讀，冇設定 UI，永遠 `"auto"` | 需求 7 要解決 |
| 5 | 未付款唔准標記可取餐 | `quick-order-fulfillment.ts:33` | 需求 2 + 3 嘅流程卡死 |
| 6 | `pos_device_configs` GET 冇 store filter | `/api/pos/device-config` `.order(updated_at desc).limit(1)` | 全店最新一條任何 terminal，同 autoAccept bug 同款 |

---

## 5 · 要你拍板嘅問題（八條）

**問題一（卡住需求 1 同 4）**：Kiosk 部機實際係咩硬件同作業系統？
係 Android 平板裝我哋嘅 Print Agent APK（可以直接駁 LAN 同 USB）、
定係 Windows 桌面跑瀏覽器兼裝埋 Companion（要喺同一部機裝）、
定係 iPad 或其他純瀏覽器設備（冇得直連打印機，只能經 Cloud Print Relay 或改由收銀台出紙）？

**問題二（卡住需求 3）**：自助點餐嘅會員餘額扣款，你想用邊個做法？
方案 A 係 Kiosk 設備綁定一個店員帳號去 call 現有 Ledger RPC（Ledger 唔使改，但 Kiosk 要存憑證）；
方案 B 係請 Ledger 同事新寫一條 kiosk 專用 RPC 畀 POS server 用 service role 打（安全邊界最清晰，但要等 Ledger 排期）；
方案 C 係暫時唔做會員自助扣款，Kiosk 落單只出紙單、全部去收銀台付款（最快上線）。

**問題三（卡住需求 4）**：「顧客小票」嘅模板要用邊一套？
係沿用現有嘅「收據」模板（`PrintTemplates.receipt`，唔使新模板，但格式係結帳收據）、
定係新增一個獨立嘅「自助點餐機模版」（`PrintTemplates.kiosk`），Kiosk 小票同掃碼單收銀小票共用同一個？

**問題四（卡住需求 4）**：掃碼下單（客人自己手機落單）嘅顧客小票，係咪容許由收銀端建立 print job、用收銀台打印機出紙？
你之前講過唔想改由收銀端建 print job，但我理解嗰次係針對廚房單；顧客小票係咪可以例外？

**問題五（卡住需求 4）**：小票要印價格，你想行邊條技術路？
路線 1 係改 `PrintItemLine` 加價格欄位，POS ＋ desktop-companion ＋ print-agent-android 三個 repo 嘅渲染器全部要改同重新打包；
路線 2 係落單端預渲染成行陣列一齊寫入 `pos_print_jobs`，打印端直接輸出，唔使改三個 repo（但要加 DB 欄位，且 Companion / APK 要識優先讀）。

**問題六（卡住需求 7）**：「需要確認」開關係放邊個位置？
係直接取代 `local-orders-panel.tsx` 入面「店內線下訂單」標題右邊嗰粒「刪除全部訂單」掣（字面跟足你嘅要求），
定係放喺 `orders-hub.tsx` 嘅「訂單」頁頁頭、橫跨線上與線下兩欄（更符合「訂單介面」嘅講法，但要改多一個檔案）？

**問題七（卡住需求 7）**：呢個開關嘅預設值係乜？
係預設「需要確認」（穩陣，但開舖第一日 Kiosk 單會堆喺度等人撳），
定係預設「免確認直接出廚房單」（流暢，但有落錯單風險）？

**問題八（卡住需求 5）**：訂單來源標記要顯示喺邊？
係淨係顯示喺「訂單」介面嘅線下訂單列表，
定係同時顯示喺收銀台嘅快餐單卡片同結帳畫面？

---

## 6 · 其餘細項（我嘅預設建議，唔同意就出聲）

1. **快餐鎖定後，Kiosk 唔再提供「外賣」選項**，`quickType` 寫死 `pickup`，`tableName` 一律「自取」。
2. **Kiosk 落單後唔保留單據、唔畀加單**（鎖快餐後「本枱加單」邏輯失效）。
3. **堂食（收銀台開枱）確認流程**沿用現有 `dine_in_confirm` 做法：單落 `draft`（「點單中」），員工撳確認先轉 `sent_to_kitchen` 兼出廚房單。
4. **來源標記配色**：Kiosk = 藍「自助點餐機」、掃碼 = 青「掃碼自點」、POS = 唔顯示。
5. **「刪除全部訂單」係隱藏唔係刪除**（改動可逆，留註釋講明點還原）。
6. **`selfOrderConfirm` 唔寫上 `pos_device_configs`**（避免重演 autoAccept bug）；改寫 `pos_kiosk_settings` 按 `store_id` 存。

---

## 7 · 建議分階段（等 §5 拍板後先開工）

| Phase | 內容 | 依賴 |
|---|---|---|
| **0** | 答晒 §5 八條問題 | — |
| **1** | DB migration（`source` / print job 三欄 / `pos_kiosk_settings`）+ 型別 + mapper + sync route | — |
| **2** | 修 P0 #1、#2（廚房單確認後先建 + 去重） | Phase 1 |
| **3** | 需求 5（鎖快餐 + source 欄位 + badge） | Phase 1 |
| **4** | 需求 6（廚房單沿用模板：Kiosk 攞 printTemplates + 帶 template/content/printerId） | Phase 1 |
| **5** | 需求 7（開關 + 真源搬到 DB + 確認流程 UI） | Phase 1、2 |
| **6** | 需求 1（Kiosk 打印機設定 UI + hub 路由） | 問題一 |
| **7** | 需求 4（顧客小票：Kiosk 本地 + 掃碼收銀端）+ 需求 8（份數固定 1） | 問題三、四、五 |
| **8** | 需求 3（會員號彈窗 + 扣款） | 問題二 |
| **9** | 需求 2（放寬可取餐閘門） | — |
| **10** | 跨 repo（視問題五）+ 實機驗證 | 問題五 |
