# Macau POS System — 專案記憶

## 結構
澳門 Web POS（`C:\dev\macauPos\macauPosSystem`），前台已上線（macau-pos-system.vercel.app，Supabase `zymdemjflsckicwcinxl`）。
Next.js 16 App Router + React 19 + TS5 + Tailwind4 + Supabase（Ledger 必配 / POS 可選）+ PWA + LocalStorage 離線優先 + print-bridge。
- `src/app/`（餐飲 v1 + salon）；`src/components/pos-app.tsx` 核心（快餐／堂食共用，掛 `/`）。`src/lib/types.ts` 權威；`storage.ts`；`ledger/`；`print-bridge/`；`pos/`。
- `docs/` 編號文檔（01…96）；`supabase/migrations/`；`print-relay/`。
- **Android Print Agent 係獨立 repo：`C:\dev\print-agent-android`（唔喺本 repo）**。

## 重要約定
- 餐飲 localStorage `macau-pos/*`；salon `macau-pos-salon/*`。PrintJob 模型共用。
- Ledger 介面層不可繞過（Vercel HTTP 已 410）。不引入新依賴。
- **設定真源**：per-terminal（floors / printTemplates / `onlineOrderSettings.autoAccept`）本地優先；其餘 server 優先。
- **itemIdentity 三邊同步**：`menuItemId|specs|price|note`。改已下單菜品要同步 `cartItems` + `baseOrderItems` + `order.items`。
- **備註鎖定（docs/84）**：鎖 sent_to_kitchen/paid/settled/cancelled/partially_refunded/refunded；**唔鎖** draft / reopened。
- **非永久狀態唔越界**：`*-temp/-draft/-ghost/isReopenTemp` 喺 render + persistence 都要 filter。
- 長文字一律 `whitespace-pre-wrap break-words`，唔好 `truncate`。
- **訂單排序**一律 `compareOrderByLocalNo()`（`pos-order-filters.ts`）= 純 `createdAt` asc；唔好按狀態分段。

## 打印
- **通道優先級**（`dispatch.ts`）：① native bridge（Android `window.PosNative.printJob`）② Companion（localhost）③ Cloud Relay。relay 只喺 pure-web（iPad/PC browser / PWA）觸發；`RelayPairingPanel` 已 self-gate（`isRunningInNativeShell()` → `return null`），所以 Android APK WebView（POS 終端模式）同 PC Companion 殼都唔會顯示中繼配對 UI。
- **🟥 三倉 renderer 合約（docs/95）**：web `escpos-render.ts` / Companion `renderEscPos` / APK `EscPosRenderer.renderTemplateTicket`。**加 `PrintItemLine`/`PrintJob` 任何欄位必須同步三倉 + `docs/55 §3`**。
- **ESC/POS 放大**：`GS ! n`(1D21) nibble `(h-1)<<4|(w-1)` → `0x11`（**唔係 0x30**）。QR 用 `GS v 0` 點陣圖（唔用 `GS ( k`），印前 `resetMagnify()`。
- 熱敏：兩欄空格 pad 到 `RECEIPT_PAPER_COLUMNS`（80mm=48 / 58mm=32），中文字 2 格、ASCII 1 格（`displayWidth()`）。1-bit → 強調只用反白 `ESC { n`（唔包 LF）。
- **🟥 收據金額鐵律（docs/95 §12）**：`原價合計+服務費+稅−抹零−優惠合計===總金額`。雙軌 `resolveTotalDiscount()`：`naive` vs `derived=原價合計+服務費+稅−抹零−總金額`，取 min 截頂到原價合計。
- **計錢基數跟 `pos-app.tsx::orderTotals()`**：subtotal 用 `it.price`（包加購）。`unitBasePrice(it)` 只可用嚟顯示。
- **✅ 已修（2026-09-02）結帳服務費被丟棄**：`sumOrderBaseTotal(order)=subtotal+(serviceChargeAmount??0)+taxAmount`。
- **⚠️ 未修（ROOT 3 #1，未拍板）**：退菜路徑 `total: Math.max(0, nextTotals.total - activeOrder.discountAmount)` 沿用 stale `discountAmount`；收據層被 `resolveTotalDiscount()` 頂住，但 DB 數本身錯。
- 規格加購價靠右：三倉 `splitSpecLine()`（regex `^(.*?)\s+(-?\$\d+|-\d+)$`）+ `twoColumn()`。單品折扣 `原價×(100-rate)/100`。Kotlin 對齊 JS：`Double.toString()`→`"30.0"` 要 `num()`；optional 數字唔好俾默認 0。文字變形根因=synthetic bold → `fontSynthesis:"none"`。

## Android Print Agent（`C:\dev\print-agent-android`，**v1.1.1 / versionCode 6 / minSdk 24**）
- 2026-09-02 **已 build APK**：`print-agent-1.1.0-debug.apk`（3.44 MB）。**直接改現有 app module**（冇開新 `:relay` module，避免第四個 renderer）。
- `MainActivity.kt`（WebView 殼 + `relayHome` flag 直入中繼畫面）；`hub/LanHttpServer.kt`(8787)；`hub/PrinterHub.kt`；`net/EscPosRenderer.kt`（`renderTemplateTicket` 主路徑，已加 `paperColumns()` 修 58mm 爆紙）；`model/PrintDtos.kt`；`net/LanScanner.kt`。
- **Sunmi 內置**：`net/SunmiPrinter.kt`（`com.sunmi:printerlibrary:1.0.24`，`InnerPrinterManager.bindService()` + `sendRAWData`，RAW 全大寫，latch 等 ack 25s 超時當失敗）。Manifest `<queries>` 宣告 `woyou.aidlservice.jiuiv5` + WAKE_LOCK/BOOT_COMPLETED/IGNORE_BATTERY。
- **LAN**：`net/SdkPrinter.print()` 經 `net.posprinter` AAR 支援 ETHERNET（`info="ip,port"`）/USB/BT；`printBytes(ctx,cfg,bytes)` 送 pre-rendered bytes。

## 🟢 雲端中繼（Sunmi 方案，docs/96）
- 目的：iPad Safari 冇 raw TCP / 打唔到 LAN:9100 / HTTPS fetch http = mixed content block → 經雲端中繼（Android 常開機主動出站拎單）。
- **核心基建已存在**：`pos_print_jobs` 表（0011+）+ realtime publication + RLS（anon SELECT 14 日窗 / service_role 全權）；上傳（`PRINT_JOB_CREATED`→sync→upsert）+ 訂閱（anon client）已通。
- **APK 中繼包（`relay/`）已完成**：`RelayPrefs`(長期 token)/`RelayState`/`RelayApi`(OkHttp claim/report/heartbeat)/`RealtimeClient`(Phoenix WSS，payload 只當叫醒)/`JobRunner`(claim→render→dispatch→report)/`RelayService`(FGS+WifiLock)/`RelayActivity`(QR/測試/解除)/`BootReceiver`。
- **配對 = Android 自註冊（用戶嫌掃 QR 麻煩，2026-09-02 拍板改用）**：方向反轉 —— APK 喺 `RelayActivity` 輸入 storeId → 自行 `POST /pair`（agentId+token+storeId，token 存 `token_hash=sha256`）→ `RelayService.pollPair` 輪詢拎 `{status:"paired",storeId,storeName,supabaseUrl,anonKey}`。web 淨係 `GET /pair-status?storeId=` 查「呢間店有冇已配對 agent」→ 寫 localStorage 令 `isRelayConfigured()`=true、dispatch 通道③啟用。**web 唔使掃 QR、唔使攞 token**（token 只存 hash，web 唔需要），零新依賴，iPad 安全（HTTPS→LAN 混合內容問題完全避開）。
- **✅ 狀態（2026-09-02 落實）**：① 0020 **用戶已人手跑** ② 6 條 Vercel route：`{pair,claim,result,heartbeat}` + **新增 `pair-status`(GET) / `unpair`(POST)** **已完成** ③ web `RelayTransport`（send → `flushPosSyncQueue` 推上雲）**已完成**，`dispatch.ts` channel ③ 已接 ④ **web 配對 UI `RelayPairingPanel` 已完成**，掛喺 `device-settings.tsx` 設備 tab（"雲端列印中繼"卡片，檢查/解除配對）⑤ **APK `RelayActivity` 改手動輸入 storeId 配對（移除 QR）已完成**：`RelayPrefs.ensureToken()` / `RelayApi.selfPair()` / `revoke()` / `doPair()`；`RelayService` 通知文案改「請喺 web POS 設置輸入店舖 ID」⑥ both builds green（web `tsc` 過，APK `1.1.1` / code 6）。
- 技術鐵律：Realtime payload >1MB 被截 → 只當叫醒，權威數據經 RPC。多機爭奪用 `for update skip locked` 防重複打印。

## 原生殼 / PWA
檢測用 bridge marker（**唔好 user-agent**）：`window.PosNative.printJob`（Android）、`window.companionShell`（PC）。Helper `isRunningInNativeShell()`（pwa-install-button.tsx）。

## 開發環境 / 偏好
- 語言：繁體中文（廣東話風味）。先討論定方向 → 寫文檔 → 上 GitHub；重要決定存檔。
- 偏好「不動現有」增量擴展；排查先徹底查根因再動手。桌面 app 更新要重 build 並**主動告知版本號**。
- **🚨 git 一律 `run_in_background`**（sandbox 會 SIGTERM 打死長 foreground git）；push 前 `git ls-remote` 對。
- `tsc --noEmit` 唯一誤報：`src/app/layout.tsx(38,50) LayoutProps`（standalone tsc 見唔到 `.next/types`，唔影響 Vercel build）。
- **Android build（sandbox）**：`export JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"` + `./gradlew assembleDebug --offline`。改 renderer 後 bump `app/build.gradle.kts` versionCode/versionName。
- **🚨 寫咗 migration ≠ 跑咗 migration**（踩過 0018/0019）。本機冇 DB 連線 → 要人手去 Supabase Dashboard SQL Editor 貼；寫完 curl production API 驗。
