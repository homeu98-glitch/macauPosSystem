# Macau POS System — 專案記憶

## 結構

澳門 Web POS（`C:\dev\macauPos\macauPosSystem`），前台已上線（macau-pos-system.vercel.app，Supabase = `zymdemjflsckicwcinxl`）。
Next.js 16 App Router + React 19 + TS5 + Tailwind4 + Supabase 雙寫（Ledger 必配 / POS 可選）+ PWA + LocalStorage 離線優先 + print-bridge。

- `src/app/`（餐飲 v1 + salon）；`src/components/pos-app.tsx` 核心（快餐／堂食共用，掛 `/`）
- `src/lib/types.ts` 只讀權威；`storage.ts`；`ledger/`；`print-bridge/`；`pos/`
- `docs/` 編號文檔（01…95）；`supabase/migrations/`；`print-relay/`
- **Android Print Agent 係獨立 repo：`C:\dev\print-agent-android`（唔喺本 repo）**，v1.0.3 / versionCode 4，APK 喺該目錄根。
- 業務：澳門餐飲（飲品、炸雞、輕堂食）+ 美容院。與 Macau-Ledger 共用 Supabase Auth + 線上訂單 Realtime。

## 重要約定

- 餐飲 localStorage 鍵 `macau-pos/*`；salon `macau-pos-salon/*`。PrintJob 模型共用。
- Ledger 介面層不可繞過（Vercel HTTP 已 410）。不引入新依賴。
- **設定真源**：per-terminal 設定（floors / printTemplates / `onlineOrderSettings.autoAccept`）本地優先；其餘 server 優先。`pos_device_configs` GET 係 `order(updated_at desc).limit(1)` = 全店最新一條（任何 terminal），本來就唔可信。
- **itemIdentity 三邊同步**：`menuItemId|specs|price|note`（note 係 identity 一部分）。改已下單菜品要同步 `cartItems` + `baseOrderItems` + `order.items`，只改一邊 → `locked` 變 false → 退菜彈「尚未正式下單」。
- `pos_orders.items` 係 JSONB 整條存（`/api/pos/sync`）→ `OrderItem` 加 field 唔使 migration。
- **備註鎖定（docs/84）**：`isOrderNoteLocked()` 鎖 sent_to_kitchen/paid/settled/cancelled/partially_refunded/refunded，**唔鎖** draft / reopened。UI disabled + 資料層兩邊都要擋。
- **非永久狀態唔可以越界**：任何 `*-temp / *-draft / *-ghost / isReopenTemp` entity，render 層同 persistence 層都要 filter 走。
- 長文字換行：用戶自由輸入一律 `whitespace-pre-wrap break-words`，唔好 `truncate`（純 `break-normal` 對長串 CJK 無效）。
- 菜單 card 灰字 `printerGroup` = 廚房單派去邊個分區打印機（可由 `menuPrinterOverrides` 覆寫），唔係「喺邊度煮」。時價菜顯示「時價菜」。
- **訂單排序**：一律 `compareOrderByLocalNo()`（`src/lib/pos-order-filters.ts`）= 純 `createdAt` ascending。唔好用單號（跨 prefix 撞號）／updatedAt（改狀態就彈位）。UI 唔好按狀態分段。

## 線上訂單

- **自動接單真源（docs/92）**：`pos_online_order_settings`（per-store，server 權威）→ 同步 Ledger；線下「自動接自助單」係 `pos_kiosk_settings.selfOrderAutoAccept`，**唔對接 Ledger**。四個 call site 統一 `<AutoAcceptPill variant="contained" size="md">`。
- **server error 唔可以靜默吞**：要攞 server error message 翻譯成有行動指向嘅訊息（`describeServerError()`）。共用元件嘅 `error` prop 要 check call site 有冇傳。
- `normalizeLedgerStatus()` 把 accepted+preparing 摺成 preparing；「已接單」badge 只喺 `quick-online-orders-panel.tsx`。

## Kiosk / 掃碼落單

- 共用 `src/lib/use-kiosk-order.ts`；`/order` 三欄平板，`/menu` 手機外賣 App 風。
- **storeId 讀設備綁店** `loadKioskDeviceBinding()?.storeId`，唔好讀 auth session（會空 → fallback `macau-store-a`）。
- 客人餐牌 = per-store 真 menu：`GET /api/pos/bootstrap?storeId=`；`bootstrap = fetched ?? cache ?? mock`。
- 收銀見單靠 realtime（`store_id=eq.<merchantId>`）+ pull fallback，**嚴禁 polling**。
- 全局 `body{overflow:hidden}`：手機頁要 `main h-[100dvh] overflow-hidden` + 內層 `flex-1 overflow-y-auto` + 頂底 `shrink-0`。
- 自助點餐 v2（docs/87）：同專案同 DB、唔拆部署、唔重建 APK/EXE；開關真源 = `pos_kiosk_settings`（PK store_id），**絕對唔好放 `pos_device_configs`**；`PrintTemplates.kiosk` 第四格但 `buildSnapshot("receipt", …)`；Kiosk 只寫 `pos_orders`、**唔推 `PRINT_JOB_CREATED`** → 廚房單一律收銀端建。

## Sync 架構（餐飲）

- `src/lib/pos/sync-flush.ts` + `pos-sync-flush-worker.tsx`（mount 喺 root layout）：自動 listener（online/offline/queue-changed/visibilitychange/30s/mount）、chain lock 序列化、dedup by entityId、legacy heal、`MAX_SYNC_ATTEMPTS=5` 後標 failed 留底、enqueue 後 `notifyQueueChanged()`。
- storeId 解析：authSession.merchantId → kiosk binding → undefined。跨店污染（`ORDER_UPDATED` upsert 冇 store filter）未處理。
- Mock mode：無 service_role key → 503 → 5 次後 failed 留底。

## Ledger 對接

- **報表 DB 對接（docs/83）**：Ledger 直連 macau-pos Supabase，角色 `ledger_report_ro`（唯讀，`connection limit 3`），經 `report_ro` schema 22 個 View。SQL `docs/sql/83-ledger-readonly-access.sql`。**PII**：`salon_orders`/`salon_bookings`/`salon_customers`/`salon_bootstrap_config` 唔直接授權，只經 View。
- **報表口徑真源**：`restaurant-daily-report.tsx aggregate()`（只計 settled/partially_refunded/refunded；歸屬日 `coalesce(updatedAt, createdAt)`；退菜＝`items[].voided:true`）同 `salon/reports.tsx`（`status==='settled'`；歸屬日 `coalesce(settledAt, createdAt)`）。改報表要同步改 docs/83 §5 範例 SQL。
- 列級 vs 日級：`serving_minutes_*` 喺 `v_pos_orders`；`serving_measured_count`/`serving_*_min_*` 喺 `v_pos_daily_summary`。median/P95 唔可以跨日加總。
- **報表一次性 API（docs/94）**：`report_ro.build_full_report(text, date, date, int, int) returns jsonb`，`security invoker` + `stable`，全部由 22 個 View 砌，範圍上限 90 日（`meta.clamped`）。驗語法：`python tools/check-94-sql.py`（需 pglast）。
- **🔴 server 端冇 `pg` driver，得 `@supabase/supabase-js`（PostgREST，無 `GROUP BY`）** → 任何 group-by 聚合**必須寫成 Postgres function 再 `.rpc()`**。
- **DB 口徑兩處刻意同前端唔同（docs/94 §5）**：① `pos_orders` 冇 `original_settled_at` → serving fallback 退到 `updated_at` ② 「跌 20%」用「本期日均 vs 前 7 日日均」，基線窗口剔走本期。
- **Index expression 坑**：0017 嘅 index 用 `timezone('Asia/Macau', …)`，View 嘅 `biz_date` 用 `at time zone` —— 語義一樣但 textual 唔同，**PG 當唔同 expression**。加 index 時兩邊寫法要一致。
- **🚨 寫咗 migration ≠ 跑咗 migration（踩咗兩次：0018、0019）**。本機冇 `.env.local`／DB 連線／`supabase/config.toml` → `supabase db push` 跑唔到，要人手去 Supabase Dashboard SQL Editor 貼。寫完要用 curl 打 production API 驗證。
- **點驗 production（可重用）**：curl 首頁 HTML → 拎 `/_next/*.js` → download → `grep -oE 'https://[a-z0-9]+\.supabase\.co'`。打公開 API 探測：表唔存在返 `Could not find the table 'public.xxx' in the schema cache`。

## Salon

`store.industry = restaurant | salon`；salon 全新建（`src/app/salon/`），唔動餐飲。共用 auth / storage / sync-queue / print-bridge / backoffice。核心差別：預約 vs 點單、staff label-only 唔登入、Ledger 餘額替代次卡、無庫存無退款。見 `docs/26`（忠誠度 `docs/30`）。

## 打印

- **通道優先級**（`src/lib/print-bridge/dispatch.ts`）：① native bridge（Android APK WebView `window.PosNative.printJob`）② 桌面 Companion（localhost HTTP，`desktop-companion/`）③ Cloud Print Relay。冇通道 → job 維持 pending。
- **🟥 native bridge protocol**：`native.ts dispatchJobToNative` 只 map `name/quantity/specs/note`，**主動 strip 走 `PrintItemLine` 上任何新加 field**。Companion / Relay 係 `JSON.stringify({ job })` 直透傳唔 strip。每加 field 必須 audit `native.ts`。Forward-compatible 寫法：`...(typeof it.field === "number" ? { field: it.field } : {})`。
- **🟥 三倉 renderer 合約（docs/95）**：「設計 == 預覽 == 出紙」三條同源路徑 —— web `src/lib/escpos-render.ts`、Companion `companion-server.mjs renderEscPos`、APK `EscPosRenderer.kt renderTemplateTicket`。**加 `PrintItemLine` / `PrintJob` 任何欄位，必須同步 `docs/55 §3` 合約 + 三個 renderer**。（血案：`price` web 算好但兩個 renderer 冇讀 → 收據印唔出價錢。）
- **ESC/POS 放大真相表（Companion 0.1.15，docs/81）**：`ESC ! n`(1B21) 只管 ASCII（`0x20` 闢 / `0x10` 高）；`FS ! n`(1C21) 只管 Kanji（`0x04` 闢 / `0x08` 高）；`GS ! n`(1D21) 管 ASCII+Kanji，nibble `(h-1)<<4|(w-1)` → l=`0x11`（**唔係 0x30**）。**待 `npm run dist` 打包 0.1.15 驗收**。
- 熱敏排版：冇 flex → 兩欄靠空格 pad 到 `RECEIPT_PAPER_COLUMNS = 48`（80mm）；**中文字 2 格、ASCII 1 格**（用 `displayWidth()`）；太窄退化成兩空格分隔、**唔削名**。
- 熱敏紙係 1-bit → 底色/強調只能用 **反白 `ESC { n`（1B 7B）**，「文字前開、文字後閂」**唔包 LF**。網頁預覽對應 `print-color-adjust: exact`。
- **QR 用 `GS v 0`（1D 76 30）點陣圖**，唔用 `GS ( k`（舊機唔支援）。POS 端 `src/lib/escpos-qr.ts encodeQrPayload()` encode 一次 → `PrintJob.qr { size, bits }` → 三倉共用。印圖前**必須 `resetMagnify()`**。
- 收據專屬渲染一律用 `isReceipt = template.kind === "receipt"` 包住（價錢 / 折扣 / QR），廚房單同標籤單 byte-for-byte 維持原樣。
- **🟥 收據金額鐵律（docs/95 §12）**：`原價合計 + 服務費 + 稅 − 抹零 − 優惠合計 === 總金額` 必須永遠成立。
  舊碼「優惠合計 = `order.discountAmount` + Σ單品折讓」係**三格數字唔同源**（`原價合計`/`總金額` 由 items 現場計，`discountAmount` 係寫死持久欄）→ 客戶見過 -72 / -81 呢類對唔到數嘅神秘數字。
  現用**雙軌對帳 `resolveTotalDiscount()`**：`naive`（理論值）vs `derived = 原價合計+服務費+稅−抹零−總金額`（反推值），**取 min 再截頂到原價合計**（安全方向 = 寧少報折讓）。改任何收據金額邏輯都要過 `node tools/verify-receipt-totals.mjs`。
- **計錢基數要跟 `pos-app.tsx::orderTotals()`**：摺 subtotal 用 `it.price`（**包**加購 spec delta）→ 收據折讓一樣要用 `it.price`。
  `unitBasePrice(it)`（剝走加購）**只可用嚟顯示**主行「原價 $X / 折後 $Y」，用嚟計錢會計少折讓、對唔返總金額。
- **✅ 已修（docs/95 §14，2026-09-02 用戶拍板「落」）**：`pos-app.tsx` `paymentBase` 之前
  `total = subtotal + taxAmount` **冇加 `serviceChargeAmount`**，而落單 `total = subtotal + service + tax - discount`
  → `serviceChargeRate > 0` 嘅舖結帳會靜默少收服務費（連全單折扣基數都縮水，因為 `discountAmountFromRate(paymentBase.total, …)`）。
  現用 `sumOrderBaseTotal(order) = subtotal + (serviceChargeAmount ?? 0) + taxAmount`，`paymentSummary.serviceChargeAmount` 跟 `paymentBase`。
  **改呢度要小心**：① 自助點餐單 `kiosk-order.ts:135` 同口徑，唔會雙重計 ② **線上 Ledger 單唔會經 `paymentBase`**
  （`bridgeLedgerOrderToPos()` 只寫 `bridgedOrders` in-memory Map，契約 M3/M8 唔 mirror 落 POS DB，而 `currentSettlementOrder` 只從 `orders` 搵）
  ③ **fix 前已結帳嘅歷史單 `total` 冇服務費，唔做 migration**（改歷史金額＝改歷史營收），靠雙軌對帳取細值頂住 → 舊單對唔平但唔會印錯折讓。
- **⚠️ 已知未修（ROOT 3 根因 #1，未拍板）**：`pos-app.tsx:1737` 退菜路徑
  `total: Math.max(0, nextTotals.total - activeOrder.discountAmount)` —— 重計 subtotal 但沿用 **stale `discountAmount`**。
  收據層已被 `resolveTotalDiscount()` 頂住，但持久落 DB 嘅數本身仲係錯。
- **Kotlin 對齊 JS 嘅坑**：`Double.toString()` 出 `"30.0"` vs JS `${n}` 出 `"30"` → 要 `num()`（`%.2f` trim）；optional 數字唔好俾默認值 0（`optDouble(k, 0.0)` → 冇欄位當「價錢 0」）。
- 文字變形根因 = **synthetic bold**：CJK fallback（PingFang TC）冇 700/800 字重 → `fontSynthesis: "none"` + `letterSpacing: 0` 根治。
- **規格行加購價錢要靠右**（docs/95 §9.1）：`formatSpecLine()` 拼 `"加購:加麵 $5"` 成單一字串，**預覽有 `splitSpecLine()` + flex justify-between，renderer 冇** → 出紙同預覽唔一致。三個 repo 都要有 `splitSpecLine()`（regex `^(.*?)\s+(-?\$\d+|-\d+)$`），拆完用 `twoColumn(label, price)`；冇價就維持原樣。
- **`unitBasePrice()` 只用喺主行基價 / 折扣 base，唔可以用喺「原價合计」**：會剝走加購。`it.price` 喺 `pos-app.tsx::priceWithSpecs()` 入面已經包埋 spec delta（折扣菜用 `originalPrice`），**直接用就係「100% 原價」**。
- **單品折扣 saving 公式：`原價 × (100 - rate) / 100`，唔唔用 `× rate / 100`**。rate=85 應該係「折讓 15%」（原價 × 15%），唔係「折後 85%」。個錯誤好隱晦：rate 放喺公式入面會俾人誤以為「直接乘 rate」。`computeItemSavings` + `buildReceiptContent discount_breakdown` 兩處都要檢。

### Android Print Agent（`C:\dev\print-agent-android`）

- `MainActivity.kt`（WebView 殼 + UI）、`hub/LanHttpServer.kt`（**LAN HTTP server，port 8787**，自寫 socket）、`hub/PrinterHub.kt`、`hub/PrintHubService.kt`（foreground service + `START_STICKY`）、`net/EscPosRenderer.kt`、`model/PrintDtos.kt`、`net/LanScanner.kt`。
- `LanHttpServer` 已返 `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Private-Network: true`；有 `/api/status`、`/api/devices`、`/api/scan`、`/api/assign`、`/api/manual`、`/api/remove`、`/api/print`、`/print`（HTML）、`/beacon`（1x1 PNG + job/seq/total/chunk 分片組裝）、`/setup.html`。
- ⚠️ **`/beacon` 嘅「被動 mixed content 偷渡」喺 HTTPS 頁上面會失效**：mixed content 規範規定 host 係 IP literal 嘅可升級內容（`<img>`）會**直接 block**（MDN 明文）。只有 domain name 先會被 auto-upgrade。
- Android 端主入口 = `EscPosRenderer.renderTemplateTicket(job, cfg)`；`SdkPrinter.print()` 經 `net.posprinter` AAR 支援 **ETHERNET（info = `"ip,port"`）/ USB / BT**；`EscPosPrinter.printRaw()` 裸 socket 後備。
- **Relay 現況**：`docs/46` 規格 + `print-relay/{server.mjs, stationary-agent.mjs}`（WSS 骨架，auth 係 placeholder、出單係 stub）+ 本 repo `src/lib/print-bridge/relay-transport.ts`（終端側 client 骨架，**未接入 `dispatch.ts`**）。**Sunmi 中繼方案見 `docs/96`（2026-09-02）。**

### 🟢 雲端中繼基建（大部分**已經存在**，2026-09-02 盤點 · docs/96）

- `pos_print_jobs` **表已存在**（0011 建、0012/0015 加欄位），有 `store_id`/`items` jsonb/`template`/`content`/`printer_id`，**已入 `supabase_realtime` publication**；RLS（0016）anon SELECT 14 日窗 + service_role 全權。
- **上傳路已通**：`pos-app.tsx` 9 處 enqueue `PRINT_JOB_CREATED` → sync queue → `/api/pos/sync:282` → `pos_print_jobs` upsert（`onConflict:"id"` 冪等）。
- **訂閱路已通**：`src/lib/pos/use-pos-realtime.ts` 用 anon client 訂閱 `pos_print_jobs`，filter `store_id=eq.<storeId>`。
- **缺**：`printer`/`kind`/`qr`/`copies`/`ttl`/`claimed_*`/`attempts` 欄位（migration 0020，見 docs/96 §5.1）；原子拎單 RPC `pos_claim_print_jobs()`（`for update skip locked`）；4 條 `/api/pos/print-agent/*` route；web `RealtimePrintTransport`。
- **Sunmi 中繼 APK**：喺 `print-agent-android` **開新 `:relay` module + 抽 `:core` 復用 `net/`/`model/`/`PrinterHub`**，只換輸入層（WebView bridge → Realtime + claim RPC）。**由零寫會變第四個 renderer，會重新踩三倉合約嗰堆坑。**
- 配對：APK 顯示 `agentId` QR → iPad 掃（復用 `loadJsQr()`）→ server 簽 token → 經 **broadcast 頻道 `pair:<agentId>`** 推畀 APK（一次性、唔落 anon 可讀表）。**Sunmi 唔使有相機。**

### 🔑 Supabase Realtime 限制（2026-09-02 查證官方 limits）

- **postgres_changes payload 上限 1,024 KB；超標時 `new`/`old` 只帶每個 ≤64 bytes 嘅欄位** → `template`/`items`/`content` 會被靜默剝走。
- Broadcast payload：Free 256 KB / Pro 3,000 KB。Concurrent connections：Free 200 / Pro 500。Messages/s：Free 100 / Pro 500。Channels per connection 100。
- **⇒ 鐵律：Realtime 事件只當「叫醒訊號」，權威數據一定要經 RPC 由 DB 直接攞。** 多機爭奪用 `for update skip locked` 防重複打印。

### 🔑 瀏覽器打印硬限制（2026-09-01 查證，關 iPad 方案）

- iOS Safari：無 raw TCP / WebUSB / Web Bluetooth → **USB、BT、LAN:9100 全部打唔到**。
- HTTPS 頁 `fetch("http://192.168.x.x/...")` = active mixed content → **一律 block**。
- 被動 mixed content（`<img>`/`<audio>`/`<video>`）本來會 auto-upgrade 去 https，但 **host 係 IP literal 就直接 block**，所以唔可以用嚟偷渡。
- **唯一例外：top-level navigation 唔算 mixed content** → `window.open("http://192.168.x.x/print?...")` 可以（但要開新 tab，UX 差）。iframe 係 blockable → 唔得。
- Chrome PNA（公網 https → 區網 IP 要 preflight）**rollout 官方暫停中**，但政策會收緊；Safari/WebKit 未實作 PNA。
- ⇒ **結論：iPad Safari 嘅 POS 要去區網打印機，唯一穩陣出路係經雲端中繼（Android/常開機主動出站拎單）。**

## 原生殼 / PWA

檢測用 codebase 自己注入嘅 bridge marker（**唔好用 user-agent**）：`window.PosNative.printJob`（Android APK）、`window.companionShell`（PC Electron）。Helper `isRunningInNativeShell()`（`pwa-install-button.tsx`）。登入介面喺原生殼入面唔顯示 PWA 安裝入口。

## 開發環境 / 偏好

- sandbox 自帶 `node_modules`，可直接 `npx tsc --noEmit`（`npm install` 可能 EPERM）。
- **🚨 git 操作一律 `run_in_background`**：sandbox 會 SIGTERM 打死長時間 foreground git（2026-08-31 搞到 `.git/refs/` + `.pack` 被刪）。想對比 lint baseline 唔好用 `git stash`。push 前用 `git ls-remote` 對。
- `tsc --noEmit` 唯一已知誤報：`src/app/layout.tsx(38,50) LayoutProps`（standalone tsc 見唔到 `.next/types`，唔影響 Vercel build）。
- **Android build（sandbox）**：冇 `JAVA_HOME`，要 `export JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"` 再用 `./gradlew assembleDebug --offline`。約 40s–100s，**要 `run_in_background`**。改 renderer 後要 bump `app/build.gradle.kts` versionCode/versionName。
- **TS 5.5 type-predicate 陷阱**：`arr.filter((x) => x !== "lit")` 會由 callback 推斷 type predicate，令元素類型收窄 → 之後 `.splice("lit")` compile 唔到。用顯式型別註釋 + `indexOf` 去重。
- 語言：繁體中文（廣東話風味）。工作流：先討論定方向 → 寫正式文檔 → 上 GitHub；重要決定要存檔。
- 偏好「不動現有」增量擴展。排查**先徹底查根因再動手**，唔接受憑猜測俾修法。
- 桌面 app 更新要重 build 並**主動告知新版本號**（區分「source 已修」vs「已打包生效」）。
