# Macau POS System — 專案記憶

## 結構

`macauPosSystem` 澳門 Web POS，前台已上線（macau-pos-system.vercel.app）。
Next.js 16 App Router + React 19 + TS5 + Tailwind4 + Supabase 雙寫（Ledger 必配 / POS 可選）+ PWA + LocalStorage 離線優先 + print-bridge。

- `src/app/` 路由（餐飲 v1 + salon v1+）
- `src/components/` — `pos-app.tsx` 核心（快餐與堂食共用，都掛 `/`）、`online-orders.tsx`（`/orders`）、`device-settings.tsx`、`print-center.tsx`
- `src/lib/types.ts` 只讀權威；`storage.ts` localStorage 包裝；`ledger/`；`print-bridge/`（`client.ts` HTTP / `native.ts` Android bridge / `dispatch.ts` 路由）
- `print-agent-android/` Native Android Print Agent（WebView + `window.PosNative`）
- `docs/` 編號文檔（01…87）；`supabase/migrations/` SQL

業務：澳門餐飲（飲品、炸雞、輕堂食）+ 美容院。與 Macau-Ledger 共用 Supabase Auth + 線上訂單 Realtime。
不做：藍牙打印、大中餐酒樓工位、平台託管金流。

## 重要約定

- 餐飲 localStorage 鍵 `macau-pos/*`；salon `macau-pos-salon/*`。PrintJob 模型共用。
- Ledger 介面層不可繞過（不走 Vercel HTTP，已 410）。不引入新依賴。
- **設定真源**：per-terminal 設定（floors / printTemplates / `onlineOrderSettings.autoAccept`）本地優先，唔畀 server 蓋；其餘 server 優先。因為 `pos_device_configs` GET 係 `.order(updated_at desc).limit(1)` = **全店最新一條（任何 terminal）**，本來就唔可信。
- **itemIdentity 三邊同步**：`pos-app.tsx:1301` `itemIdentity()` = `menuItemId|specs|price|note`（**note 係 identity 一部分**）。改已下單菜品（note/specs/price）必須同步 `cartItems` + `baseOrderItems` + `order.items`，只改一邊 → `locked` 變 false → 「已下單」標記消失、退菜彈「尚未正式下單」。參考 `voidOrderedItem` L1530-1531。
- `pos_orders.items` 係 JSONB 整條存（`/api/pos/sync` L58）→ `OrderItem` 加 field 唔使 migration。
- **備註鎖定（2026-08-31 ✅，docs/84）**：備註／規格喺送出（sent_to_kitchen）嗰刻固定，之後唔准改。真源 `src/lib/pos/order-note-lock.ts` `isOrderNoteLocked()`（鎖 sent_to_kitchen/paid/settled/cancelled/partially_refunded/refunded；**唔鎖** draft 同 reopened）。單品另靠 `orderedItemQtyMap.get(identity) > 0`。UI（disabled）+ 資料層（`applyItemNote`/`applySpecSelection`/彈窗保存）**兩邊都要擋**。理由：① 廚房單係建 PrintJob 時 snapshot，改咗唔補印；② items JSONB 整條寫入 → 雙軌不一致；③ note/specs 係 identity 一部分。
- **非永久狀態唔可以越界（反例待修）**：返結 temp 枱 `isReopenTemp` 被 `createReopenTempTable()` push 入 `localSettings.floors[].tables[]`，`device-settings.tsx:134 saveTablesLocal()` 攤平帶去 bootstrap → admin 一撳保存 temp 枱永久升級。鐵律：任何 `*-temp / *-draft / *-ghost / isReopenTemp` entity，render layer 同 persistence layer 都要 filter 走。
- **長文字換行（✅，docs/84 §7）**：用戶自由輸入長文字一律 `whitespace-pre-wrap break-words`，唔好 `truncate`。純 `break-normal` 對長串 CJK 無效。長文字要獨立一行整寬，外層 flex 用 `items-start`。

## 線上訂單

- **自動接單被 server 覆蓋（✅ 已修）**：`pos-app.tsx loadRuntimeState()` merged 冇保護 `onlineOrderSettings` → 被 server 份（autoAccept:true）蓋走。已修：merged 加保護 + `/api/online-order-settings` store 隔離（4 個 call site 帶 `merchantId`）。遺留：`syncConfig()` 仍把 autoAccept 寫上 server。
- **Print Center 冇 entry（✅ 已修）**：`onPrintJobUpsert` 用 React state 做基底 → 被直接寫 localStorage 嘅 path 沖走。已修：改以 `loadPrintJobs()` 為基底 + 補 dispatch `pos-print-jobs-changed` + 統一 `mergePrintJobs()`（去重 + tombstone）。
- 狀態顯示：`normalizeLedgerStatus()` 把 accepted+preparing 摺成 preparing（`/orders` 一律「製作中」）；`ledgerStatusBadgeLabel()` 先會出「已接單」，只喺 `quick-online-orders-panel.tsx`。

## Kiosk / 掃碼落單

- 共用邏輯 `src/lib/use-kiosk-order.ts`；`/order` 三欄平板，`/menu` 手機外賣 App 風。
- **storeId 讀設備綁店，唔讀 auth session**：kiosk 登入（`login-screen.tsx` mode=kiosk）只 `saveKioskDeviceBinding()`。生成枱 QR 用 `loadKioskDeviceBinding()?.storeId`，唔好用 `loadAuthSession()?.merchantId`（會空 → fallback `DEFAULT_KIOSK_STORE_ID = macau-store-a`）。
- 客人餐牌 = 商家真 menu（per-store）：`GET /api/pos/bootstrap?storeId=`；`bootstrap = fetchedBootstrap ?? loadBootstrapCache() ?? mockBootstrap`。
- 落單號碼跟店內線下序號 `/api/pos/sequence`（dine_in→pos / pickup / delivery），同店共用 `next_daily_sequence`。
- 收銀見單靠 realtime（filter `store_id=eq.<merchantId>`）+ 15s pull fallback。
- 全局 `body{overflow:hidden}`：手機頁要 `main h-[100dvh] overflow-hidden` + 內部 `section flex-1 overflow-y-auto` + 頂/底 `shrink-0`。

### 自助點餐 v2（docs/87，進行中 2026-08-31）

規格 8 點已確認：同一 Vercel 專案 / 同一 DB、唔拆部署、**唔重建 APK/EXE**（商家設定切 kiosk mode）；新增獨立「自助點餐機模版」；顧客只傳訂單內容去 macau-pos，確認後沿用收銀正常落單流程（`upsertCurrentOrder("sent_to_kitchen")` + `buildKitchenPrintJobs` + `buildLabelPrintJobs`）；**免確認直接出單＝開關嘅預設值，唔係取消開關**；開關掣叫「自動接自助單」，**取代「刪除全部訂單」掣位（logic 保留、UI 隱藏）**；顯示位置＝訂單頁／收銀快餐單卡片／結帳畫面；小票格式完全沿用現有收據（唔好再問）。

- 開關真源 = 新表 `pos_kiosk_settings`（PK store_id），**絕對唔好放 `pos_device_configs`**（GET 冇 store filter）。
- `PrintTemplates.kiosk` 第 4 格，但 `buildSnapshot("receipt", kioskTemplate)` —— kind 必須係 `"receipt"`，三個 repo 先唔使改。
- Kiosk 只寫 `pos_orders`（`source`），**唔推 `PRINT_JOB_CREATED`** → 廚房單一律收銀端建，避免雙印。
- `source: "pos" | "kiosk" | "scan"`（migration 0015）。

## Ledger 報表 DB 對接（docs/83 v1.1 ✅）

- Ledger 直連 macau-pos Supabase，角色 `ledger_report_ro`（唯讀 + `connection limit 3`），經 `report_ro` schema 22 個 View。SQL：`docs/sql/83-ledger-readonly-access.sql`。**嚴禁 polling**。
- **PII**：`salon_orders`/`salon_bookings`/`salon_customers`/`salon_bootstrap_config` 唔直接授權，只經 View（剔走 `customer_phone` / `internal_notes`）。
- **報表口徑真源**：`restaurant-daily-report.tsx aggregate()`（只計 settled/partially_refunded/refunded；歸屬日 `coalesce(updatedAt, createdAt)`；退菜＝`items[].voided:true`）同 `salon/reports.tsx`（`status==='settled'`；歸屬日 `coalesce(settledAt, createdAt)`；技師業績含 `kind='product'`）。改報表要同步改 docs/83 §5 範例 SQL。
- 列級 vs 日級：`serving_minutes_*` 喺 `v_pos_orders`；`serving_measured_count`/`serving_*_min_*` 喺 `v_pos_daily_summary`。median/P95 唔可以跨日加總。

## Salon（2026-08-14 ✅ 7 phase 完成）

`store.industry = restaurant | salon`；salon 全新建（`src/app/salon/`），唔動餐飲。共用 auth / storage / sync-queue / print-bridge / backoffice。核心差別：預約 vs 點單、staff label-only 唔登入、Ledger 餘額替代次卡、無庫存無退款。見 `docs/26`（忠誠度 `docs/30`）。

## 打印

- **Native Print Agent（2026-08-19 ✅）**：Android WebView 注入 `window.PosNative`，`PosNative.printJob(json)` → Kotlin raw socket `IP:9100` ESC/POS。非 Android fallback HTTP bridge。見 `docs/36`。
- **🟥 Native bridge protocol 轉發（2026-09-01 ✅ §18+20）**：`src/lib/print-bridge/native.ts:56-61` 嘅 `dispatchJobToNative` payload map 顯式只攞 `name/quantity/specs/note` 四個 field — **主動 strip 走 `PrintItemLine` 上面任何新加嘅 field**（包括 `price`，包括將來任何 protocol 擴展）。Companion / Relay 通道用 `JSON.stringify({ job })` 直透傳唔 strip。**教訓**：每加新 field 到 `PrintItemLine` / `PrintJob.items[i]` 後，必須 audit `native.ts` 嘅 payload map — 否則 APK / Companion 收唔到 data。Forward-compatible 寫法：`...(typeof it.field === "number" ? { field: it.field } : {})`（optional spread，唔加 `undefined`）。
- **ESC/POS 放大真相表（Companion 0.1.15）**：`ESC ! n`（1B21）只管 ASCII（`0x20`闊 `0x10`高）；`FS ! n`（1C21）只管 Kanji（`0x04`闊 `0x08`高）；`GS ! n`（1D21）管 ASCII+Kanji，nibble `(h-1)<<4|(w-1)` → l=`0x11`（**唔係 0x30**）。舊 bug：CJK 行 `ESC!0x30`+`GS!0x30` 相乘 4×4。已修 companion（`GS_SIZE_BYTE={s:0x00,m:0x01,l:0x11}` + `resetMagnify()`）。**待 `npm run dist` 打包 0.1.15 驗收**（見 `docs/81`）。

## 開發環境 / 偏好

- sandbox 自帶 `node_modules`，可直接 `npx tsc --noEmit`（`npm install` 可能 EPERM）。
- `tsc --noEmit` 唯一已知誤報：`src/app/layout.tsx(37) LayoutProps`（standalone tsc 見唔到 `.next/types`，唔影響 Vercel build）。真正 `next build` 建議 dev box 跑。
- 語言：繁體中文（廣東話風味）。工作流：先討論定方向 → 寫正式文檔 → 上 GitHub；重要決定要存檔。
- 偏好「不動現有」增量擴展。排查時**要先徹底查根因再動手**，唔接受憑猜測俾修法。
- 提問要用完整句子，唔好用 Q1-1 / Q2-7 呢類編號代稱。
- 桌面 app 更新要重 build 並**主動告知新版本號**（區分「source 已修」vs「已打包 exe 生效」）。
