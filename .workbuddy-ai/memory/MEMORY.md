# Macau POS System — 專案記憶

## 結構

澳門 Web POS（`C:\dev\macauPos\macauPosSystem`），前台已上線（macau-pos-system.vercel.app）。
Next.js 16 App Router + React 19 + TS5 + Tailwind4 + Supabase 雙寫（Ledger 必配 / POS 可選）+ PWA + LocalStorage 離線優先 + print-bridge。

- `src/app/` 路由（餐飲 v1 + salon v1+）；`src/components/pos-app.tsx` 核心（快餐與堂食共用，都掛 `/`）
- `src/lib/types.ts` 只讀權威；`storage.ts`；`ledger/`；`print-bridge/`；`pos/`（sync-flush、order-note-lock…）
- `print-agent-android/`、`desktop-companion/`；`docs/` 編號文檔（01…87）；`supabase/migrations/`
- 業務：澳門餐飲（飲品、炸雞、輕堂食）+ 美容院。與 Macau-Ledger 共用 Supabase Auth + 線上訂單 Realtime。

## 重要約定

- 餐飲 localStorage 鍵 `macau-pos/*`；salon `macau-pos-salon/*`。PrintJob 模型共用。
- Ledger 介面層不可繞過（不走 Vercel HTTP，已 410）。不引入新依賴。
- **設定真源**：per-terminal 設定（floors / printTemplates / `onlineOrderSettings.autoAccept`）本地優先，唔畀 server 蓋；其餘 server 優先。因為 `pos_device_configs` GET 係 `.order(updated_at desc).limit(1)` = **全店最新一條（任何 terminal）**，本來就唔可信。
- **itemIdentity 三邊同步**：`pos-app.tsx` `itemIdentity()` = `menuItemId|specs|price|note`（**note 係 identity 一部分**）。改已下單菜品必須同步 `cartItems` + `baseOrderItems` + `order.items`，只改一邊 → `locked` 變 false → 「已下單」標記消失、退菜彈「尚未正式下單」。
- `pos_orders.items` 係 JSONB 整條存（`/api/pos/sync`）→ `OrderItem` 加 field 唔使 migration。
- **備註鎖定（docs/84）**：備註／規格喺送出（sent_to_kitchen）嗰刻固定。真源 `src/lib/pos/order-note-lock.ts` `isOrderNoteLocked()`（鎖 sent_to_kitchen/paid/settled/cancelled/partially_refunded/refunded；**唔鎖** draft 同 reopened）。UI（disabled）+ 資料層**兩邊都要擋**。
- **非永久狀態唔可以越界（反例待修）**：返結 temp 枱 `isReopenTemp` 被 push 入 `localSettings.floors[].tables[]`，`device-settings.tsx saveTablesLocal()` 攤平帶去 bootstrap → admin 一撳保存 temp 枱永久升級。鐵律：任何 `*-temp / *-draft / *-ghost / isReopenTemp` entity，render 層同 persistence 層都要 filter 走。
- **長文字換行（docs/84 §7）**：用戶自由輸入長文字一律 `whitespace-pre-wrap break-words`，唔好 `truncate`。純 `break-normal` 對長串 CJK 無效。
- **訂單排序（2026-09-01 ✅ 第二輪）**：訂單顯示一律用 `compareOrderByLocalNo()`（`src/lib/pos-order-filters.ts`），但**純 `createdAt` ascending**（舊→新）。唔用單號做主 key：跨 prefix（同日 自取01 vs 外賣01）號碼會撞，純單號排會跳邊（用戶第一輪反映嘅「自取01 10:32 排得比 取餐09 01:25 仲前」就係呢個 bug）。**唔可以用 `orderTimestamp`（updatedAt）排** —— 改狀態就 refresh updatedAt → 張單彈去最前。序號 per `(store_id, kind, biz_date)` 見 migration 0012，所以同日多 prefix 序號會撞。UI 亦**唔好按狀態分段**（收銀 strip 已改單一列）。

## 線上訂單

- **自動接單被 server 覆蓋（✅ 已修）**：`loadRuntimeState()` merged 冇保護 `onlineOrderSettings`。已修：merged 加保護 + `/api/online-order-settings` store 隔離。遺留：`syncConfig()` 仍把 autoAccept 寫上 server。
- **Print Center 冇 entry（✅ 已修）**：改以 `loadPrintJobs()` 為基底 + dispatch `pos-print-jobs-changed` + `mergePrintJobs()`（去重 + tombstone）。
- 狀態顯示：`normalizeLedgerStatus()` 把 accepted+preparing 摺成 preparing；`ledgerStatusBadgeLabel()` 先會出「已接單」，只喺 `quick-online-orders-panel.tsx`。

## Kiosk / 掃碼落單

- 共用邏輯 `src/lib/use-kiosk-order.ts`；`/order` 三欄平板，`/menu` 手機外賣 App 風。
- **storeId 讀設備綁店，唔讀 auth session**：用 `loadKioskDeviceBinding()?.storeId`，唔好用 `loadAuthSession()?.merchantId`（會空 → fallback `macau-store-a`）。
- 客人餐牌 = 商家真 menu（per-store）：`GET /api/pos/bootstrap?storeId=`；`bootstrap = fetchedBootstrap ?? loadBootstrapCache() ?? mockBootstrap`。
- 收銀見單靠 realtime（filter `store_id=eq.<merchantId>`）+ pull fallback。**嚴禁 polling**。
- 全局 `body{overflow:hidden}`：手機頁要 `main h-[100dvh] overflow-hidden` + 內部 `section flex-1 overflow-y-auto` + 頂/底 `shrink-0`。
- 自助點餐 v2（docs/87）：同一 Vercel 專案／同一 DB、唔拆部署、**唔重建 APK/EXE**；開關真源 = 新表 `pos_kiosk_settings`（PK store_id），**絕對唔好放 `pos_device_configs`**；`PrintTemplates.kiosk` 第四格但 `buildSnapshot("receipt", …)`（kind 必須係 `"receipt"`）；Kiosk 只寫 `pos_orders`（`source`）、**唔推 `PRINT_JOB_CREATED`** → 廚房單一律收銀端建。

## Sync 架構（餐飲）

- **Bug 教訓（✅ 已修）**：舊版 `pushEvents()` 寫 queue status="synced" 但**完全冇 sync scheduler** → 本地 cancelled 從不上 DB → 重開 app 時 backfill 撈 draft 蓋返 → 「鬼」單復活。
- **根治 `src/lib/pos/sync-flush.ts` + `src/components/pos-sync-flush-worker.tsx`**（mount 喺 root layout）：
  1. 自動 install listener：online / offline / pos-network-status-changed / pos-sync-queue-changed / visibilitychange / 30s interval / mount-time once
  2. Chain lock 序列化防並發 3. Dedup by entityId（最新蓋前面）4. **Legacy heal**（舊 queue status 唔可信，首次全部重推一次）5. `MAX_SYNC_ATTEMPTS=5` 後標 failed 留底 6. caller enqueue 後 call `notifyQueueChanged()`
- **storeId 解析**：authSession.merchantId → kiosk binding → undefined。跨店污染 pre-existing risk（ORDER_UPDATED upsert 冇 store filter）尚未處理。
- **Mock mode 限制**：無 service_role key → server 返 503 → 5 次後 failed 留底，唔會自動清。

## Ledger 報表 DB 對接（docs/83）

- Ledger 直連 macau-pos Supabase，角色 `ledger_report_ro`（唯讀 + `connection limit 3`），經 `report_ro` schema 22 個 View。SQL：`docs/sql/83-ledger-readonly-access.sql`。
- **PII**：`salon_orders`/`salon_bookings`/`salon_customers`/`salon_bootstrap_config` 唔直接授權，只經 View（剔走 phone / internal_notes）。
- **報表口徑真源**：`restaurant-daily-report.tsx aggregate()`（只計 settled/partially_refunded/refunded；歸屬日 `coalesce(updatedAt, createdAt)`；退菜＝`items[].voided:true`）同 `salon/reports.tsx`（`status==='settled'`；歸屬日 `coalesce(settledAt, createdAt)`）。改報表要同步改 docs/83 §5 範例 SQL。
- 列級 vs 日級：`serving_minutes_*` 喺 `v_pos_orders`；`serving_measured_count`/`serving_*_min_*` 喺 `v_pos_daily_summary`。median/P95 唔可以跨日加總。

## Salon

`store.industry = restaurant | salon`；salon 全新建（`src/app/salon/`），唔動餐飲。共用 auth / storage / sync-queue / print-bridge / backoffice。核心差別：預約 vs 點單、staff label-only 唔登入、Ledger 餘額替代次卡、無庫存無退款。見 `docs/26`（忠誠度 `docs/30`）。

## 打印

- **Native Print Agent（docs/36）**：Android WebView 注入 `window.PosNative`，`PosNative.printJob(json)` → Kotlin raw socket `IP:9100` ESC/POS。非 Android fallback HTTP bridge。
- **🟥 Native bridge protocol 轉發**：`src/lib/print-bridge/native.ts` `dispatchJobToNative` payload map 顯式只攞 `name/quantity/specs/note` 四個 field — **主動 strip 走 `PrintItemLine` 上面任何新加嘅 field**。Companion / Relay 通道用 `JSON.stringify({ job })` 直透傳唔 strip。**教訓**：每加新 field 到 `PrintItemLine` / `PrintJob.items[i]` 後，必須 audit `native.ts`。Forward-compatible 寫法：`...(typeof it.field === "number" ? { field: it.field } : {})`。
- **ESC/POS 放大真相表（Companion 0.1.15）**：`ESC ! n`（1B21）只管 ASCII（`0x20`闊 `0x10`高）；`FS ! n`（1C21）只管 Kanji（`0x04`闊 `0x08`高）；`GS ! n`（1D21）管 ASCII+Kanji，nibble `(h-1)<<4|(w-1)` → l=`0x11`（**唔係 0x30**）。**待 `npm run dist` 打包 0.1.15 驗收**（見 `docs/81`）。

## 原生殼 / PWA

- 檢測用 codebase 自己注入嘅 bridge marker（**唔好用 user-agent**）：`window.PosNative.printJob`（Android APK WebView）、`window.companionShell`（PC Electron preload）。Helper：`isRunningInNativeShell()`（`src/components/pwa-install-button.tsx`）。登入介面喺原生殼入面唔顯示 PWA 安裝入口。

## 開發環境 / 偏好

- sandbox 自帶 `node_modules`，可直接 `npx tsc --noEmit`（`npm install` 可能 EPERM）。
- **🚨 git 操作一律 `run_in_background`**：呢個 sandbox 會 SIGTERM 打死長時間嘅 foreground git（`git stash` / `git push` / `git clone` / `git gc`）。2026-08-31 就係咁搞到 `.git/refs/` + `.pack` 被刪、repo 變 `not a git repository`。想對比 lint baseline 唔好用 `git stash`。
  - Git 損毀急救（已實證可行）：① 先 `cp` 改動檔去 `/tmp` ② `git ls-remote origin` 確認 remote ③ 背景 `git clone --no-checkout <url> <tmp>`（網絡可能 `curl 56`，加 `-c http.lowSpeedLimit=0 -c http.lowSpeedTime=0 -c http.postBuffer=524288000` + 重試）④ 換 `.git` ⑤ `git reset`（**mixed，唔好 `--hard`**，因為 `--no-checkout` clone 冇 index）⑥ `git status` 核對。
  - sandbox 入面 `git status` / tracking ref 可能係 stale，push 前要用 `git ls-remote` 對。
- `tsc --noEmit` 唯一已知誤報：`src/app/layout.tsx(38,50) LayoutProps`（standalone tsc 見唔到 `.next/types`，唔影響 Vercel build）。真正 `next build` 建議 dev box 跑。
- 語言：繁體中文（廣東話風味）。工作流：先討論定方向 → 寫正式文檔 → 上 GitHub；重要決定要存檔。
- 偏好「不動現有」增量擴展。排查時**要先徹底查根因再動手**，唔接受憑猜測俾修法。
- 提問要用完整句子，唔好用 Q1-1 / Q2-7 呢類編號代稱。
- 桌面 app 更新要重 build 並**主動告知新版本號**（區分「source 已修」vs「已打包生效」）。
