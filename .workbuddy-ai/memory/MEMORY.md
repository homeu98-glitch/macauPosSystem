# Macau POS System — 專案記憶

## 結構

澳門 Web POS（`C:\dev\macauPos\macauPosSystem`），前台已上線（macau-pos-system.vercel.app）。
Next.js 16 App Router + React 19 + TS5 + Tailwind4 + Supabase 雙寫（Ledger 必配 / POS 可選）+ PWA + LocalStorage 離線優先 + print-bridge。

- `src/app/`（餐飲 v1 + salon v1+）；`src/components/pos-app.tsx` 核心（快餐／堂食共用，掛 `/`）
- `src/lib/types.ts` 只讀權威；`storage.ts`；`ledger/`；`print-bridge/`；`pos/`
- `docs/` 編號文檔（01…92）；`supabase/migrations/`；`print-agent-android/`；`desktop-companion/`
- 業務：澳門餐飲（飲品、炸雞、輕堂食）+ 美容院。與 Macau-Ledger 共用 Supabase Auth + 線上訂單 Realtime。

## 重要約定

- 餐飲 localStorage 鍵 `macau-pos/*`；salon `macau-pos-salon/*`。PrintJob 模型共用。
- Ledger 介面層不可繞過（Vercel HTTP 已 410）。不引入新依賴。
- **設定真源**：per-terminal 設定（floors / printTemplates / `onlineOrderSettings.autoAccept`）本地優先；其餘 server 優先。`pos_device_configs` GET 係 `order(updated_at desc).limit(1)` = 全店最新一條（任何 terminal），本來就唔可信。
- **itemIdentity 三邊同步**：`menuItemId|specs|price|note`（note 係 identity 一部分）。改已下單菜品要同步 `cartItems` + `baseOrderItems` + `order.items`，只改一邊 → `locked` 變 false → 退菜彈「尚未正式下單」。
- `pos_orders.items` 係 JSONB 整條存（`/api/pos/sync`）→ `OrderItem` 加 field 唔使 migration。
- **備註鎖定（docs/84）**：`isOrderNoteLocked()` 鎖 sent_to_kitchen/paid/settled/cancelled/partially_refunded/refunded，**唔鎖** draft / reopened。UI disabled + 資料層兩邊都要擋。
- **非永久狀態唔可以越界**：任何 `*-temp / *-draft / *-ghost / isReopenTemp` entity，render 層同 persistence 層都要 filter 走。（案例：`isReopenTemp` 枱被 `saveTablesLocal()` 持久化，admin 保存後 temp 枱永久升級）
- **長文字換行**：用戶自由輸入一律 `whitespace-pre-wrap break-words`，唔好 `truncate`。純 `break-normal` 對長串 CJK 無效。
- 菜單 card 灰字 `printerGroup` = 呢道菜嘅廚房單派去邊個分區打印機（可由 `menuPrinterOverrides` 覆寫），唔係「喺邊度煮」。時價菜顯示「時價菜」。
- **訂單排序**：一律 `compareOrderByLocalNo()`（`src/lib/pos-order-filters.ts`）= 純 `createdAt` ascending。唔好用單號（跨 prefix 撞號）／唔好用 updatedAt（改狀態就彈位）。UI 唔好按狀態分段。

## 線上訂單

- **自動接單真源（docs/92）**：`pos_online_order_settings`（per-store，server 權威）→ 同步 Ledger；線下「自動接自助單」係 `pos_kiosk_settings.selfOrderAutoAccept`，**唔對接 Ledger**。四個 call site 統一 `<AutoAcceptPill variant="contained" size="md">`。
- **server error 唔可以靜默吞**：一律「請稍後再試」會令「配置未做好」同「暫時網絡問題」變成同一個冇反應。要攞 server error message 翻譯成有行動指向嘅訊息（`describeServerError()`）。共用元件嘅 `error` prop 要 check call site 有冇傳。
- `normalizeLedgerStatus()` 把 accepted+preparing 摺成 preparing；「已接單」badge 只喺 `quick-online-orders-panel.tsx`。

## Kiosk / 掃碼落單

- 共用 `src/lib/use-kiosk-order.ts`；`/order` 三欄平板，`/menu` 手機外賣 App 風。
- **storeId 讀設備綁店** `loadKioskDeviceBinding()?.storeId`，唔好讀 auth session（會空 → fallback `macau-store-a`）。
- 客人餐牌 = per-store 真 menu：`GET /api/pos/bootstrap?storeId=`；`bootstrap = fetched ?? cache ?? mock`。
- 收銀見單靠 realtime（`store_id=eq.<merchantId>`）+ pull fallback，**嚴禁 polling**。
- 全局 `body{overflow:hidden}`：手機頁要 `main h-[100dvh] overflow-hidden` + 內層 `flex-1 overflow-y-auto` + 頂底 `shrink-0`。
- 自助點餐 v2（docs/87）：同專案同 DB、唔拆部署、唔重建 APK/EXE；開關真源 = `pos_kiosk_settings`（PK store_id），**絕對唔好放 `pos_device_configs`**；`PrintTemplates.kiosk` 第四格但 `buildSnapshot("receipt", …)`；Kiosk 只寫 `pos_orders`、**唔推 `PRINT_JOB_CREATED`** → 廚房單一律收銀端建。

## Sync 架構（餐飲）

- 根治：`src/lib/pos/sync-flush.ts` + `pos-sync-flush-worker.tsx`（mount 喺 root layout）：自動 listener（online/offline/queue-changed/visibilitychange/30s/mount）、chain lock 序列化、dedup by entityId、legacy heal（舊 queue status 唔可信，首次全部重推）、`MAX_SYNC_ATTEMPTS=5` 後標 failed 留底、enqueue 後 `notifyQueueChanged()`。
- storeId 解析：authSession.merchantId → kiosk binding → undefined。跨店污染（`ORDER_UPDATED` upsert 冇 store filter）未處理。
- Mock mode：無 service_role key → 503 → 5 次後 failed 留底。

## Ledger 對接

- **報表 DB 對接（docs/83）**：Ledger 直連 macau-pos Supabase，角色 `ledger_report_ro`（唯讀，`connection limit 3`），經 `report_ro` schema 22 個 View。SQL `docs/sql/83-ledger-readonly-access.sql`。**PII**：`salon_orders`/`salon_bookings`/`salon_customers`/`salon_bootstrap_config` 唔直接授權，只經 View（剔走 phone / internal_notes）。
- **報表口徑真源**：`restaurant-daily-report.tsx aggregate()`（只計 settled/partially_refunded/refunded；歸屬日 `coalesce(updatedAt, createdAt)`；退菜＝`items[].voided:true`）同 `salon/reports.tsx`（`status==='settled'`；歸屬日 `coalesce(settledAt, createdAt)`）。改報表要同步改 docs/83 §5 範例 SQL。
- 列級 vs 日級：`serving_minutes_*` 喺 `v_pos_orders`；`serving_measured_count`/`serving_*_min_*` 喺 `v_pos_daily_summary`。median/P95 唔可以跨日加總。
- **報表一次性 API（docs/94，2026-09-01 交付）**：`report_ro.build_full_report(text, date, date, int, int) returns jsonb` —— Ledger 用現有唯讀連線 call 一次攞全份餐飲報表。`security invoker` + `stable`，全部由 22 個 View 砌，**冇重新計數**。範圍上限 90 日（超出倒推截斷 + `meta.clamped`）。covers 靠 dynamic SQL 守 `pos_orders.party_size`（0017）。驗語法：`python tools/check-94-sql.py`（需 pglast）。
- **🔴 server 端冇 `pg` driver，得 `@supabase/supabase-js`（PostgREST），而 PostgREST 冇 `GROUP BY`** → 任何 group-by 聚合（菜品／桌台／尖峰排行）**必須寫成 Postgres function 再 `.rpc()`**，喺 Vercel 用 TS 砌唔出。要喺 route 跑任意 SQL 就要加 `pg`（違反「唔引入新依賴」）。
- **DB 口徑兩處刻意同前端唔同（docs/94 §5）**：① `pos_orders` 冇 `original_settled_at` 欄 → serving fallback 退到 `updated_at` ② 「跌 20%」規則用「本期日均 vs 前 7 日日均」，基線窗口剔走本期（前端包埋今日，佔 1/7 會稀釋跌幅）。
- **Index expression 坑**：0017 建嘅 index 用 `timezone('Asia/Macau', …)`，View 嘅 `biz_date` 用 `at time zone` —— 語義一樣但 textual 唔同，**PG 當唔同 expression，index 幫唔到手**。加 index 時兩邊寫法要一致。
- **🚨 寫咗 migration ≠ 跑咗 migration（踩咗兩次：0018、0019）**。本機冇 `.env.local`／冇 DB 連線／冇 `supabase/config.toml` → `supabase db push` 跑唔到，一定要人手去 Supabase Dashboard SQL Editor 貼。寫完要用 curl 打 production API 驗證。
- **點驗 production（可重用手法）**：① curl 首頁 HTML → 拎 `/_next/*.js` → download → `grep -oE 'https://[a-z0-9]+\.supabase\.co'`（`NEXT_PUBLIC_` 會 inline 落 bundle）。2026-09-01 驗到 production = `https://zymdemjflsckicwcinxl.supabase.co`。② 打公開 API 探測：表唔存在返 `Could not find the table 'public.xxx' in the schema cache`；`LEDGER_WEBHOOK_SECRET` 未設返「伺服器未設定 webhook secret。」。

## Salon

`store.industry = restaurant | salon`；salon 全新建（`src/app/salon/`），唔動餐飲。共用 auth / storage / sync-queue / print-bridge / backoffice。核心差別：預約 vs 點單、staff label-only 唔登入、Ledger 餘額替代次卡、無庫存無退款。見 `docs/26`（忠誠度 `docs/30`）。

## 打印

- **Native Print Agent（docs/36）**：Android WebView 注入 `window.PosNative.printJob(json)` → Kotlin raw socket `IP:9100` ESC/POS；非 Android fallback HTTP bridge。
- **🟥 native bridge protocol**：`src/lib/print-bridge/native.ts` `dispatchJobToNative` 只 map `name/quantity/specs/note`，**主動 strip 走 `PrintItemLine` 上任何新加 field**。Companion / Relay 通道係 `JSON.stringify({ job })` 直透傳唔 strip。每加 field 去 `PrintItemLine` 後必須 audit `native.ts`。Forward-compatible 寫法：`...(typeof it.field === "number" ? { field: it.field } : {})`。
- **ESC/POS 放大真相表（Companion 0.1.15，詳見 docs/81）**：`ESC ! n`(1B21) 只管 ASCII（`0x20` 闢 / `0x10` 高）；`FS ! n`(1C21) 只管 Kanji（`0x04` 闢 / `0x08` 高）；`GS ! n`(1D21) 管 ASCII+Kanji，nibble `(h-1)<<4|(w-1)` → l=`0x11`（**唔係 0x30**）。**待 `npm run dist` 打包 0.1.15 驗收**。

## 原生殼 / PWA

檢測用 codebase 自己注入嘅 bridge marker（**唔好用 user-agent**）：`window.PosNative.printJob`（Android APK）、`window.companionShell`（PC Electron）。Helper `isRunningInNativeShell()`（`pwa-install-button.tsx`）。登入介面喺原生殼入面唔顯示 PWA 安裝入口。

## 開發環境 / 偏好

- sandbox 自帶 `node_modules`，可直接 `npx tsc --noEmit`（`npm install` 可能 EPERM）。
- **🚨 git 操作一律 `run_in_background`**：sandbox 會 SIGTERM 打死長時間 foreground git（2026-08-31 搞到 `.git/refs/` + `.pack` 被刪、repo 變 not a git repository）。想對比 lint baseline 唔好用 `git stash`。sandbox 入面 `git status` / tracking ref 可能 stale，push 前用 `git ls-remote` 對。（急救步驟見 2026-08-31 daily log）
- `tsc --noEmit` 唯一已知誤報：`src/app/layout.tsx(38,50) LayoutProps`（standalone tsc 見唔到 `.next/types`，唔影響 Vercel build）。
- 語言：繁體中文（廣東話風味）。工作流：先討論定方向 → 寫正式文檔 → 上 GitHub；重要決定要存檔。
- 偏好「不動現有」增量擴展。排查**先徹底查根因再動手**，唔接受憑猜測俾修法。
- 桌面 app 更新要重 build 並**主動告知新版本號**（區分「source 已修」vs「已打包生效」）。
