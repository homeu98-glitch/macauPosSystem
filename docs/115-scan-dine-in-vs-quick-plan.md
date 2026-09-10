# 115 · 掃碼下單雙模式（堂食 / 快餐）技術方案

> 建立：2026-09-10 · 狀態：**已實作（2026-09-10）** —— 見 §11 實作記錄與**三處刻意偏差**（需要用戶確認）
> 相關：`docs/87-kiosk-final-plan.md`（自助點餐機）、`docs/113-agent-gotchas.md`、`docs/reviews/qr-self-order-audit-2026-09-10.md`

---

## 0. 目標

把「客人掃碼點餐」拆成兩個**店級二選一**的模式，並補齊快餐模式的落單／呈現／收銀端提示。

| | 堂食掃碼 | 快餐掃碼 |
|---|---|---|
| QR | 每張枱一個專屬碼 | **全店只有一個碼** |
| 下單綁定 | 綁桌號 | 不綁枱（`tableId = "counter"`） |
| 落單語意 | 首單新增；同枱再加 = 更新同一張 | **每單獨立新增**，永不更新舊單 |
| 客人落單後 | 見「本枱訂單」＋可加單 | 見取餐號，**不可加單**，可「再點一單」 |
| POS 側 | 枱單（停在工作台／桌台） | 快餐 counter 單（**直接收進訂單頁**） |

---

## 1. 用戶已確認的決策（2026-09-10 22:14）

1. Kiosk 落單後的彈窗 = **出在 POS 收銀機**。
2. 「查看」跳轉**堂食與快餐不同**：堂食訂單停留在桌台（維持現狀 → 跳桌台工作台）；快餐單直接被收起來、去訂單頁（→ 開 `/orders` 的「查看」）。
3. 快餐掃碼單號**沿用 kiosk 的 `pickup` 序號**（同源同格式）。
4. 快餐落單後畫面**跟 kiosk**（取餐號 + 倒數返回）。
   > ⚠️ **實作偏差 D1**（見 §11）：改為「取餐號 + **手動**『再點一單』」，唔用 5 秒倒數自動返回。原因：倒數一過就會蓋走取餐號，而客人係用**自己部手機**、去到櫃檯仲要show個號。詳見 §11。
5. 同一部手機**可以**連續落多張快餐單。
6. 付款：**本階段一律「到櫃檯付款」**；Ledger 會員扣款列為後續。
7. **堂食與快餐不可同時開啟**（店級互斥，二選一）。
8. QR **固定不換碼**；場景 = 老闆自行列印貼出（與堂食貼枱同一做法）。

---

## 2. 現況與缺口（已核實，非推測）

### 2.1 已具備（不用重做）

- **入口已分家**：`/order` → `useKioskOrder()`（kiosk）、`/menu` → `useScanOrder()`（客人掃碼），共用 `useOrderingCore(variant)`。
- **core 內已有 `mode`**：`const mode = tableId ? "dine_in" : "quick"`；`buildKioskOrder()` 的 quick 分支已設 `tableId = "counter"`、`tableName = "自取"`、`status` 受 `selfOrderAutoAccept` 管。
- **快餐掃碼其實已「半通」**：今日開 `/menu?store=<storeId>`（不帶 tableId）已經落到單，POS 端 `isQuickCounterOrder()`（`tableId === "counter"`）認得，realtime + 自動建廚房單／標籤單亦通。
- **Kiosk 彈窗組件已存在**（`self-order-notice-stack.tsx`）：右上角 `fixed right-4 top-20`、不自動消失、多單各一張卡、向右滑 ≥64px 關閉、容器 `pointer-events-none`（卡片自己 `pointer-events-auto`）。

### 2.2 缺口（必須修，否則快餐模式做不成）

| 編號 | 缺口 | 位置 |
|---|---|---|
| **G1** | 只按桌台生成 QR → 無桌台（快餐）**永遠拿不到碼** | `kiosk-qr-panel.tsx`（`tables.length === 0` → 「尚未設定桌台」） |
| **G2** | 掃碼一律 `orderNoSource: "table"` → `localOrderNo` = `tableName` → 快餐**所有單都叫「自取」**，廚房單／收據／POS 列表分不清 | `use-kiosk-order.ts:561`、`kiosk-order.ts:250-251` |
| **G3** | 快餐落單後**沒有任何確認畫面**（成功頁入閘條件 `activeTableOrder` 在 quick 永遠是 `null` → 直接被彈返餐牌，客人以為沒落成單） | `menu/page.tsx:159`、`use-kiosk-order.ts:424-427` |
| **G4** | Kiosk 落單**不會觸發彈窗**（閘門寫死 `order.source === "scan"`） | `pos-app.tsx:1371` |
| **G5** | 彈窗點擊後的去向與需求不同；且 **`/orders` 完全沒有 deep link** | `pos-app.tsx:1300-1329`、`orders-hub.tsx` |

---

## 3. Link 規格（完全區隔）

| 模式 | Link | 說明 |
|---|---|---|
| 堂食 | `/menu?tableId=<枱UUID>&store=<storeId>` | **維持不變**，向後兼容已貼出的枱碼 |
| 快餐 | `/quick?store=<storeId>` | **新獨立 route** |

**為何用獨立 route 而不用 `/menu?quick=1`**：需求是「link 完全區隔、日後改動互不影響」。獨立 route = 獨立入口檔，任何人改快餐入口都不會碰到堂食檔；同時避免靠「URL 沒有 tableId」這種**隱含推導**判斷模式（日後任何參數異動都會誤判）。

**但實作不拆兩份**：`/menu` 與 `/quick` 各自只是 thin wrapper，實際 UI 由同一個 `ScanOrderPage` 元件（新，由現 `menu/page.tsx` 抽出）以 `variant` 渲染；落單邏輯繼續走 `useOrderingCore`。
> 理由：2026-09-10「加單漏出廚房單」事故，正是同一段邏輯重複實作、修 bug 時漏改一條造成（見 `use-scan-order.ts` 頂部註解）。

---

## 4. 店級設定：掃碼模式

**存放位置**：沿用 `pos_kiosk_settings`（per-store、有 store filter、已有 RLS 與 API），**不要**用 `pos_device_configs`（該表讀取無 store filter，會全店串設定 —— 見 `onlineOrderSettings.autoAccept` 同一個坑）。

**Migration `0031_pos_kiosk_scan_mode.sql`**：

```sql
ALTER TABLE pos_kiosk_settings
  ADD COLUMN IF NOT EXISTS scan_mode text NOT NULL DEFAULT 'dine_in';
ALTER TABLE pos_kiosk_settings
  DROP CONSTRAINT IF EXISTS pos_kiosk_settings_scan_mode_chk;
ALTER TABLE pos_kiosk_settings
  ADD CONSTRAINT pos_kiosk_settings_scan_mode_chk
  CHECK (scan_mode IN ('dine_in', 'quick'));
```

**API `GET/POST /api/pos/kiosk-settings`**：`select` 加 `scan_mode`；`KioskSettings` 加 `scanMode: "dine_in" | "quick"`（預設 `"dine_in"`，離線 fallback 亦同）。POST 要**兩個欄位一齊 upsert**（現時 POST 只寫 `self_order_auto_accept`，改一半會洗走另一半）。

**設定頁「掃碼點餐」tab**：
- 頂部加模式選擇器（堂食 / 快餐，二選一）。
- `scanMode === "dine_in"` → 顯示現有 `KioskQrPanel`（逐枱碼）。
- `scanMode === "quick"` → 顯示新 `QuickScanQrPanel`（單一碼 `origin + /quick?store=<storeId>`，附複製網址）。
- 切換模式要彈確認，並提示：**已列印的舊碼不會失效**（貼枱的碼仍然是堂食碼），需要自行回收。

---

## 5. 快餐落單規格

| 欄位 | 值 |
|---|---|
| `source` | `"scan"` |
| `table_id` | `"counter"` |
| `table_name` | `"自取"` |
| `mode` | `"quick"` |
| `local_order_no` | **server 序號**：`POST /api/pos/sequence { kind: "pickup" }` → 例：`自取01` |
| `orderNoSource` | `"sequence"`（**不再是 `"table"`**） |
| 事件類型 | 永遠 `ORDER_CREATED`；**永不 `ORDER_UPDATED`** |
| 狀態 | 受 `selfOrderAutoAccept` 管：`true` → `sent_to_kitchen`／`false` → `draft` |
| 付款 | 到櫃檯付款（不做線上支付） |

**實作**（`use-kiosk-order.ts` `placeOrder()`）：
```ts
const seqKind = mode === "dine_in" ? "pos" : "pickup";
const needsSequence = !isScanLink || mode === "quick";      // ← 快餐掃碼都要攞序號
...
orderNoSource: isScanLink && mode === "dine_in" ? "table" : "sequence",
```

**為何必須改用 server 序號**：現時快餐單 `localOrderNo = tableName = "自取"`，等於全店同號；廚房單、標籤、收據、POS 列表全部無法分辨。

**另加：快餐掃碼唔 resume**（`use-kiosk-order.ts` resume effect 提早 return）。
舊版會用 sessionStorage 嘅 `kiosk-last-order` 撈返客人自己上一張快餐單 →
客人再點餐會變成「加單」落到舊單；而 `activeTableOrder` 對 quick 又永遠係 `null`
→ 兩邊唔一致，行為同 kiosk 快餐唔同。快餐係「一單一單獨立」，一律當新單。

**離線 fallback（R2 落實）**：`nextLocalDailyOrderNo()` **唔可以用** ——
客人手機同收銀機係兩部唔同裝置，兩邊各自由「自取01」開始數 → 必撞。
改用 `quickScanOfflineOrderNo()`（`kiosk-order.ts`）= `自取-` + 4 位 base32
（去掉 `0/O/1/I/L` 等易讀錯字元），明顯唔係序號，收銀一眼睇得出未對號。
**上雲後唔重寫號碼**（號碼已經喺客人手上 / 廚房單上）。

---

## 6. 收銀端（POS）改動

### 6.1 彈窗（G4）

`pos-app.tsx` 閘門由 `isNewSelfOrder && order.source === "scan"` 改為 **`if (isNewSelfOrder)`**
（`isNewSelfOrder` 本身已經係 `!existing && isSelfOrder(order)`，`isSelfOrder` 已涵蓋
`kiosk` + `scan`），所以係**放寬**而唔係新增條件。

**文案改進**：卡片顯示嘅標識唔再一律用 `tableName`。
- 有真枱 → 台名（`A02`），維持原本；
- 冇枱（自助機 / 快餐，`tableId === "counter"`）→ **單號**（`自取01`）。

否則幾張快餐單會全部寫「自取 已下單」，收銀分唔清邊張打邊張（甚至以為係重複提示）。
實作喺 `toSelfOrderNoticeItems()`（`lib/pos/self-order-notice.ts`，純函式、有單元測試）。

### 6.2 彈窗點擊去向（G5）

| 訂單類型 | 行為 |
|---|---|
| 冇枱（`tableId === "counter"`：自助機 / 快餐） | 跳 `/orders?orderId=<id>` → 自動開該單的「查看」彈窗 → 移除提示 |
| 有真枱（堂食掃碼 / 堂食 kiosk） | **維持現狀**：跳該桌台工作台 → 移除提示 |

> 為何唔一刀切全部跳 `/orders`：堂食單嘅「睇單」天然就係枱面工作台（要出菜、要加單、
> 要結帳）；硬跳訂單列表反而多一步。而冇枱嘅單喺枱面根本冇位，跳桌台只會彈「開桌」。

已結帳／已失效 → 維持現狀（卡片轉「已結帳」灰底，等用戶滑走，不跳頁）。

### 6.3 `/orders` deep link

- `OrdersHub` 用 `window.location.search` 讀 `orderId`（**不用 `useSearchParams`** ——
  後者喺 App Router 下要 `<Suspense>` 包住，否則靜態生成階段報錯；而呢個 deep link
  只係一次性入頁動作，唔需要參與 hydration）。
- 讀完即刻 `history.replaceState` 清走 query，免得刷新 / 撳返回又彈一次。
- 傳 `focusOrderId` 落 `LocalOrdersPanel`：入頁即開「查看」彈窗，並**先切去「全部」tab**
  （否則可能停在「已完成」，彈窗後面嘅列表睇唔到張單）。
- ⚠️ **偏差 D3**：原本計劃亦傳落 `OnlineOrders`，實作只做 `LocalOrdersPanel` ——
  自助單（kiosk / scan）冇 `onlineOrderId`，一定落喺「店內線下訂單」，`OnlineOrders`
  永遠唔會有呢張單。

---

## 7. 檔案清單（= 實際實作）

| 檔案 | 動作 | 內容 |
|---|---|---|
| `supabase/migrations/0031_pos_kiosk_scan_mode.sql` | 新增 | `scan_mode` 欄位 + CHECK 約束 + COMMENT |
| `src/lib/pos/kiosk-settings.ts` | 改 | `ScanMode` 型別、`normalizeScanMode()`、`KioskSettings.scanMode`、`KioskSettingsPatch`；`saveKioskSettings(storeId, patch)`（**簽名由 boolean 改為 patch**） |
| `src/lib/pos/kiosk-settings.test.ts` | 新增 | `normalizeScanMode` 規則（未知值 / 未跑 migration 一律 `dine_in`） |
| `src/app/api/pos/kiosk-settings/route.ts` | 改 | GET select + 回傳 `scanMode`；POST 改 **read-then-merge 部分更新**（只覆寫 payload 有帶嘅欄位）；42703 降級容錯 |
| `src/lib/kiosk-order.ts` | 改 | 新增 `quickScanOfflineOrderNo()`；補 `orderNoSource` 判斷文件 |
| `src/lib/use-kiosk-order.ts` | 改 | 序號閘門 `!isScanLink \|\| mode === "quick"`；`orderNoSource` 三元式；快餐掃碼唔 resume；離線 fallback 分流 |
| `src/lib/use-scan-order.ts` | 改 | 暴露 `returnToHome`（只畀快餐成功頁「再點一單」用） |
| `src/components/scan-order-page.tsx` | 新增 | 由舊 `menu/page.tsx` 抽出嘅共用 UI，收 `link: "dine_in" \| "quick"`；含快餐成功頁、連結閘門 |
| `src/app/menu/page.tsx` | 改 | thin wrapper：`<ScanOrderPage link="dine_in" />` |
| `src/app/quick/page.tsx` | 新增 | thin wrapper：`<ScanOrderPage link="quick" />` |
| `src/lib/pos/qr-print.ts` | 新增 | `buildQrSvgMarkup()` + `openQrPrintWindow()`（獨立列印視窗，A4 正中大 QR，印完自動關窗） |
| `src/components/kiosk-qr-panel.tsx` | 改 | `QrSvg` 改為 export（共用）；每枱加「列印」掣；加操作提示 |
| `src/components/scan-mode-panel.tsx` | 新增 | 模式選擇器（堂食 / 快餐，二選一）+ `QuickScanQrPanel`（單一碼 + 複製/列印） |
| `src/components/device-settings.tsx` | 改 | 「掃碼點餐」tab 由 `<KioskQrPanel />` 改為 `<ScanModePanel />` |
| `src/components/self-order-auto-accept-toggle.tsx` | 改 | 配合 `saveKioskSettings` 新簽名 |
| `src/lib/pos/self-order-notice.ts` | 改 | 顯示標識：有枱 → 台名；冇枱 → **單號** |
| `src/lib/pos/self-order-notice.test.ts` | 改 | 補 counter 單標識測試 |
| `src/components/self-order-notice-stack.tsx` | 改 | 文件更新（涵蓋 kiosk、點擊去向兩種） |
| `src/components/pos-app.tsx` | 改 | 彈窗閘門放寬（`isNewSelfOrder` 已含 kiosk）；冇枱 → `router.push("/orders?orderId=…")` |
| `src/components/orders-hub.tsx` | 改 | 讀 `orderId` query → `focusOrderId`；清 query |
| `src/components/local-orders-panel.tsx` | 改 | 接受 `focusOrderId` → 切「全部」+ 開該單「查看」 |

**不動**：`useOrderingCore` 的中性基礎設施（menu bootstrap、售罄、realtime、金額計算、落單重試、本地待同步隊列）、`/api/pos/sync`、POS 出廚房單邏輯、`isQuickCounterOrder()`。

> **偏差 D2**：原計劃打算新增 `use-quick-scan-order.ts` + `quick-scan-qr-panel.tsx` 兩個檔。
> 實作改為 **唔新增**：兩條 link 嘅落單差異全部收喺 core 嘅 `mode` 分支（`placeOrder` /
> resume effect），對外介面（`useScanOrder()`）完全一樣，所以唔需要第二個 hook；
> QR 面板只有一個碼，直接同模式選擇器放埋一個檔（`scan-mode-panel.tsx`）更易睇。
> 符合計劃本身嘅原則：「只分家入口 / 對外介面 / 設定 / QR 面板，core 保持單一」。

---

## 8. 驗收口徑

**快餐路徑**
1. 設定 → 掃碼點餐 → 模式 = 快餐 → 只顯示**一個** QR，內容 = `<origin>/quick?store=<storeId>`（可複製 / 列印）。
2. 手機開該 link → 落單 → DB row：`source=scan`、`table_id=counter`、`table_name=自取`、`local_order_no` 為 **server 出的 `自取NN`**（不是「自取」二字）。
3. 客人端：落單後見**取餐號 + 狀態**，**沒有**「加單」按鈕，有「再點一單」。（**偏差 D1**：唔用 5 秒倒數）
4. POS：即時出現在「店內線下訂單」，右上角彈窗「**自取NN** 已下單／請查看」（顯示單號，唔係「自取」）。
5. 撳彈窗 → 跳 `/orders?orderId=<id>` → **自動開啟該單「查看」**（並切去「全部」tab）→ 提示消失。
6. 向右滑 → 提示消失且**不跳頁**。
7. 同一部手機再落一張 → 產生**另一張獨立單**（新 `自取NN`），不會加到上一張。

**堂食回歸**（必須完全不變）
8. `/menu?tableId=<枱>` 落單／加單／resume 行為與今日一致；`local_order_no` 仍為枱名。
9. POS 撳堂食單提示 → **仍然跳桌台工作台**（不是訂單頁）。
10. `/menu` **冇 `tableId`** → 顯示「請掃描枱上 QR 點餐」，**唔會**當快餐落單（舊版會）。

**Kiosk 回歸**
11. Kiosk 落單 → POS 亦會出彈窗（新增行為）；快餐 kiosk 單點擊 → 跳 `/orders?orderId=`；
    堂食 kiosk 單點擊 → 跳桌台。

**模式互斥**
12. 設定頁只能二選一；快餐模式下不會顯示逐枱碼，堂食模式下不會顯示快餐碼。

**通用**
13. `npm run typecheck` ✅、`npm run test` ✅（52 tests pass）、`npm run build` ✅；改動檔案 lint 無問題。
14. 離線：斷網落單 → 入本地待同步隊列、UI 顯示「同步中」，網絡恢復後自動補推；
    快餐掃碼離線號碼為 `自取-XXXX`（明顯非序號）。

---

## 9. 風險與邊界

| 編號 | 風險 | 處理 |
|---|---|---|
| **R1** | **匿名限流**：`/api/pos/sequence` 60/min（per IP）、`/api/pos/sync` 300/min（per IP）。店內所有機（kiosk + 客人手機）共用同一條 NAT 公網 IP → 快餐掃碼上線後匿名流量上升，可能**自我 DoS** | 上線前重新評估兩個上限；考慮快餐掃碼路徑改用 storeId 為主的限流 |
| **R2** | **離線序號撞號**：客戶端 `nextLocalDailyOrderNo()` 是各機自己的 localStorage → 兩部手機離線各自發「自取01」 | 快餐掃碼離線時**不要**用本地每日序號；改用明顯非序號的短後綴（例：`自取-K7Q2`，碰撞機率極低且收銀一眼看出未對號）。上雲後**不重寫**號碼（避免與已列印的廚房單前後不一致） |
| **R3** | **模式互斥的守門**：URL 模式與店級設定不一致（老闆切了模式但舊碼仍在街上） | **fail-open**：讀取設定失敗／離線時照 URL 落單（不得因網絡問題令客人落唔到單）。⚠️ 實作上**未做**一致性檢查 —— 見 §11.3。 |
| **R4** | 重複實作 | 只分家入口／hook 對外介面／設定／QR 面板；`useOrderingCore` 保持單一 |
| **R5** | `needsBinding` 文案寫死「請掃描枱上 QR 點餐」 | 快餐模式要改為對應文案（否則客人看到「請掃描枱上 QR」會混亂） |
| **R6** | 快餐單不佔枱 | 已由 `isQuickCounterOrder()`（`tableId === "counter"`）支援，快餐面板／可取餐流程沿用，無需新增 |

---

## 10. 用戶回覆（2026-09-10，已全部確認）

1. 快餐 route 名 = **`/quick`** ✅
2. 印出貼於**櫃檯／快餐區** ✅（→ 已加列印功能）
3. 快餐模式下**完全唔再提供**逐枱碼；反之堂食亦唔顯示快餐碼 ✅
4. R2 離線序號方案（`自取-K7Q2` 短隨機後綴）✅

---

## 11. 實作記錄（2026-09-10）

**完成狀態**：`npm run typecheck` ✅ · `npm run test` ✅ 52/52 · `npm run build` ✅ · 改動檔案 eslint 無問題。

### 11.1 三處**刻意偏差**（需要用戶確認）

| 編號 | 原計劃 | 實際做法 | 原因 |
|---|---|---|---|
| **D1** | 快餐成功頁跟 kiosk：取餐號 + **5 秒倒數自動返回** | 取餐號 + 狀態 + **手動**「再點一單」 | 客人係用**自己部手機**。倒數一過就會蓋走取餐號，而佢去到櫃檯要 show 個號；而且離開／鎖屏再返嚟就搵唔返。kiosk 係店內共用平板，倒數係為咗下一位客人 —— 場景唔同。 |
| **D2** | 新增 `use-quick-scan-order.ts` + `quick-scan-qr-panel.tsx` | 唔新增；差異收喺 core 嘅 `mode` 分支，QR 面板同模式選擇器放一個檔 | 兩條 link 對外介面完全一樣（都係 `useScanOrder()`），第二個 hook 只係轉發；QR 面板只有一個碼，夾埋模式選擇器一個檔更易睇。 |
| **D3** | `orderId` deep link 同時傳落 `LocalOrdersPanel` **同** `OnlineOrders` | 只傳 `LocalOrdersPanel` | 自助單（kiosk / scan）冇 `onlineOrderId`，一定落喺「店內線下訂單」；`OnlineOrders` 永遠唔會有呢張單。 |

> 若 D1 要用返倒數，改動點只有一個：`scan-order-page.tsx` 快餐成功頁分支
> （加返 `useEffect` + `setInterval` 倒數，參考 `app/order/page.tsx` 嘅 `returnIn`）。

### 11.2 順帶修好嘅既有問題（非本次需求，但同源）

- `saveKioskSettings(storeId, boolean)` 簽名變更 → **舊 POST 會無腦寫死另一個欄位**
  （只改 `scan_mode` 會順手把「自動接自助單」洗返 `true`）。已改為 read-then-merge 部分更新。
- `KioskQrPanel` 原本只有「複製網址」，冇列印 → 已加（堂食逐枱 + 快餐單碼）。

### 11.3 未做 / 已知限制

- **R1（匿名限流）未處理**：`/api/pos/sequence` 60/min per IP。快餐掃碼上線會令匿名
  請求上升（每張快餐單都要攞號），店內 NAT 同一條公網 IP → 有自我 DoS 風險。
  上線前要重新評估上限。**呢個係真實風險，唔係理論。**
- **模式互斥冇做 URL 層守門**（原 R3 嘅「不一致時停喺該模式介面」）：`/menu`（堂食 link）
  唔會檢查店級 `scan_mode`。原因：要檢查就要 fetch 設定，離線 / 失敗時唔可以擋住客人落單
  （離線優先原則），而「軟擋」又擋唔實。實務影響有限 —— 轉模式係老闆喺設定頁嘅明確動作，
  佢應該回收舊貼紙；而且 migration 預設 `dine_in`，**冇任何既有店鋪會自動被切走**。
  ⚠️ 但**老闆轉快餐模式之後，街上舊嘅枱碼貼紙仍然有效**（會落一張綁枱單，
  而鋪頭可能已經冇開枱）→ 呢個要喺設定頁文案 + 上線交代清楚。
- 快餐 QR **固定不換碼**（用戶確認）：即係同一個 URL 永久有效，冇 per-order token。
  好處係印一次就得；代價係任何人攞到條 URL 都可以落單（同堂食枱碼一樣嘅信任模型）。
