# 專案記憶索引（macauPos / macauPosSystem）

> ⚠️ 有注入上限（超咗靜默截斷）。**詳細「坑」總表查 [`docs/113-agent-gotchas.md`](../docs/113-agent-gotchas.md)**（改動前必讀）；日誌 `.workbuddy/memory/YYYY-MM-DD.md`。
> 維護：新「坑」先寫 docs/113，**只有最高頻**才摘要上嚟；本檔 ≤ 3k 字元。

## 改動前必查
- **後廚屏 KDS（2026-09-11 P0 完成）**：見 `docs/116` §10.1 / §10.2。四條鐵律 —— ① **唔行 outbox**、② 屏**唔碰** `pos_orders.status`（只寫 `fulfillment_status`），③ 崗位鎖喺設備綁定、屏內冇切換掣，④ **分區清單真源 = 商家 `localSettings.printZones`**（`pos_device_configs.local_settings`）——**唔可以**讀 `printer_groups`（legacy demo 值）、**唔可以**硬編碼「廚房/水吧」（後廚1/2/3 要各自獨立；只可顯示 `name`、唔可顯示帶時間戳嘅 `id`）。單品完成用 `done_qty`（份數）**唔係** boolean，否則加單會靜默漏單。屏嘅卡片格一定要 `auto-rows-max`。
- **報表頁**：KPI 帶**固定 `grid-cols-5`**（10 格同一個 grid）；**唔可以** `md:grid-cols-3 xl:grid-cols-5`。⚠️ 合併 grid **必須刪中間 `</div>`**，否則尾 N 格全寬堆疊（JSX 仍平衡 → build 全綠捉唔到）。`:key` remount ≠ 刷新，要用 `refreshToken`。
- **`normalizePosLocalSettings` 係白名單重建** → 加欄唔加白名單 = 靜靜剷走（中過 `qrUrl`/`paperSize`/`shiftPresets`）。
- **掃碼雙模式（docs/115）**：`/menu?tableId=`（堂食每枱一碼）/ `/quick?store=`（快餐全店一碼）完全區隔；`/menu` 冇 tableId **唔可以**當快餐。`scan_mode` **由登入驅動**：設定頁唯讀，唯一寫入點 `login-screen.tsx`；`kiosk`/`salon` **唔寫**。
- **Kiosk 只做快餐（規格 5）**：`use-kiosk-order.ts` 要 `mode = variant === "scan" && tableId ? "dine_in" : "quick"` —— **唔可以**用 `tableId ? …`（`/order?tableId=` 會變堂食）。
- **Kiosk 專屬打印機（0032）**：真源 DB `pos_kiosk_settings.printers`（per-store）＋本機快取 `loadKioskPrinters()`。**`resolveJobPrinter()` 必須合併 kiosk 機**，否則 by-`printerId` 搵唔到 → 跌 by-role → **靜靜印去收銀台部機**。`fetchKioskSettings().fromServer` 分「server 話冇（可清快取）」vs「攞唔到（保留快取）」；route 42703 降級要 **omit** key、唔回 `[]`；Wizard 要 `lockRole="receipt"`。
- **`job.copies` 優先於 `printer.copies`**（`dispatch.ts` 2026-09-11 修）；kiosk 小票固定 `copies:1`。
- **快餐掃碼用店內 `pickup` 序號**（唔可以用台名「自取」＝全店同號），**唔 resume**；離線用 `quickScanOfflineOrderNo()`，**唔可以**用 `nextLocalDailyOrderNo()`。
- **`saveKioskSettings(storeId, patch, headers?)`**；POST 係 read-then-merge + 42703 降級。**「未經授權：需要 POS 終端憑證。」＝ 冇帶／冇續期 token（非權限）** → 用 `posDeviceAuthHeadersFresh()`。
- **`EscPosTemplateSnapshot.cols` 係跨 repo 唯一真源** → 唔好各自判 `paperSize`。
- **`ORDER_UPDATED` 必須送 `{ order, addedItems }`**（唔係裸 order），否則 server 拒單。
- **`/api/pos/sync` 失敗分類**：業務拒絕 → 4xx `retryable:false`；基建失敗 → 500 `retryable:true`。**唔可以**任何 `ack(false)` 都回 500（變**假成功**）。
- **`nextLocalDailyOrderNo` 只可喺真正派新號時叫**（改單都叫會白燒號 → 撞號）。
- **台號查詢只認 `source="scan"`** → 放寬前先改收銀端「加單補印」閘，否則**廚房靜默漏單**。
- **`isOrderAcked` 有 TTL**：守護傳 10 分鐘、健康燈**唔可以**傳。
- **iPad 分頁唔會自動換 JS** → 「修好但仲唔同步」第一步叫用戶**強制 reload**。
- **admin 面板唔可以行 `/api/pos/state`**（要終端憑證）；單店都要 `adminOrderFetcher({ storeId })` 走 `/api/admin/orders`。
- **分格線唔可以靠「繼承上一行」**：印線前必須清 `GS !`/`ESC !`/`FS !` 殘留，dash = `dividerDashCount(size, cols)`；`divider` 預設 `s`。（docs/114）
- **🔴 建單後必須 `appendPrintJobsWithSync()`**（`@/lib/pos/print-job-enqueue`）：出紙真通道係「雲端 `pos_print_jobs` → 中繼 APK claim」，而 `RelayTransport.send()` 係 **no-op**。淨 `savePrintJobs()`／`appendPrintJobs()` = job 永留本機、樂觀標「已發送」、**零出紙 + 零紅標**（09-09 補打、09-11 Ledger 線上單接單都中過）。`ledger-pos-bridge` **唔可以**直接 import `print-jobs`（循環）→ 走 `print-job-enqueue`。只有 Kiosk 小票刻意本機。
- **`printContentToggles` 加欄要同步 5 處**（`types.ts` Kind+Toggles / `storage.ts` 白名單 / `mock-data.ts` / `device-settings.tsx` ROWS / 註釋）。`online`（線上訂單）＝同 `kitchen`/`label` **乘積**；**唔可以**納入 `setAutoPrint()` 一鍵全關；熄咗要**靜默** `return []`，唔可以彈 toast。
- **🔴「reload 先見到」＝ Realtime 冇推送**：server 寫單用 `SUPABASE_URL`（POS 專案），瀏覽器訂閱用 `NEXT_PUBLIC_SUPABASE_URL`（**Ledger 專案，冇 `pos_*` 表**）→ 訂唔存在嘅表 Supabase **唔會報錯**（照 `SUBSCRIBED`）。修：加 `NEXT_PUBLIC_POS_SUPABASE_URL`/`_ANON_KEY`（**必須 redeploy**）。健康只可靠一次性 REST 探測 `pos_orders`（`PGRST205`）；**唔可以**靠 channel status；錯 key（401）**唔可以**報成「表存在但被拒」（未認證根本冇查表，先 `bad_key` 後 `unauthorized`）。自檢 `tools/2026-09-11-check-pos-realtime.mjs --watch 20`。
- **持續型提示唔可以照抄 `setToast`**；要 store-scope localStorage + 只喺 realtime `onOrderUpsert` 由 `isNewSelfOrder` 觸發（**唔可以寫死 `source==="scan"`**）；位置 `top-20`。**撳提示一律留在點餐頁面**（`tableId==="counter"` → 高亮卡片，唔跳頁）；`focusKey` 必須用**遞增序號**（`Object.is` → boolean 連撳兩次唔重跑 effect）。
- **🔴 顧客端 Ledger（掃碼／Kiosk，契約 v3.4 §4.5／§5.11）**：**扣費／核銷只看「呢次操作有無店員 Ledger session」，同「掃碼抑或 Kiosk」無關。** 掃碼（客人手機）**冇** → 只可「顧客揀、**收銀台店員代扣**」（= docs/121 嘅 S3）；Kiosk 綁機時已用**店員帳號**登入 → 走既有 §5.7。**S2（顧客自助扣款 RPC）／S1（掃碼場景託管店員 token）Phase 1 都唔做**。顧客 JWT 打 §5.6／§5.7 會被 RLS 拒。Kiosk 必須**兩個** Ledger supabase client（顧客 `setSession` **唔可以**打店員單例，§7.3）。
- **🔴 `pos_orders` 只可存 Ledger `customer_id`（uuid），禁存電話／PIN**（§5.11 開頭＋§7.2）→ docs/110 §6.2 嘅 `member_phone` **作廢**，改 `member_customer_id`。`display_name` 只可**當次畫面**。
- **🔴 平台會員掃「別店」碼仍可登入** → 該店餘額顯示 0、卡包可能空，**唔應該 403「尚未成為本店會員」**（docs/110 §7.7 嘅反向檢查作廢）。
- **契約本地真源**：`docs/integration/ledger-client-api.md`（**已更新至 v3.4，1271 行，含 §4.5／§5.11**；舊 9/1 版只到 §4.4／§5.9）。配套短清單 `docs/integration/pos-v3.4-partner-handover-customer-login.md`（§5 = 對 docs/121 嘅逐條回覆）。分析見 `docs/120`／需求單 `docs/121`。

## 硬性口徑（唔可以改）
- 收入認列 `isSaleCountable(o)`：只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`。
- 日期一律 Macau 邊界 ISO（`ledger/report-period.ts`），禁 UTC-naive。
- 雲端讀到 = 唯一可信源；雲端空 + 成功 = 空狀態，**唔 fallback 本機**（`debugInfo.dataSource` 會標示）。
- store 隔離：讀 strict `o.storeId === merchantId`；`merchantId` 缺失一律唔拉（寧空白唔跨店）。
- 報表 `dataReady = backfillDone && ledgerDone`；admin `loadOnlineByHour` early return **必須** setLedgerDone(true)。
- 取消線上單一律打 RPC `merchant_resolve_order_change`，**唔可以**用 `update_order_status('cancelled')`。
- 同步邊界：自動化**只推商家已做嘅事**，兩邊終態唔一致 → 標 `conflict` 交人。

## 命令
- `npm run typecheck` / `npm run test`（`node --test` **無參數** → 會將 `**/test-*`、`**/*-test`、`*.test.*` 當測試檔；**utility 模組唔好用 `test-` 前綴**；測試 import 一律相對路徑 + `.ts`，`@/` 會 `ERR_MODULE_NOT_FOUND`）。
- 本機 `next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 並喺沙箱外跑。
- 🔴 **所有 `git` 指令一律 `CODEBUDDY_SAFE_DELETE_ENABLED=0 git …`**：環境嘅「安全刪除」層會將 `unlink()` 變成移入回收筒，git 跑 `gc --auto` / `pack-refs` 時就會被搬走 → `fatal: not a git repository`（已第三次：09-01、09-09、09-11）。已 `git config --local gc.auto 0` 減風險。修法見 docs/113（回收筒 `$I*` 可解出原路徑還原；**唔好 `git init`**）。
- 🔴 **`.git` 散咗／GitHub Desktop 認唔到 repo → 一定「先 `git fetch` 由 origin 還原」，唔好即刻 rebuild**（09-11 白做一次：遠端一直有完整歷史，只因本機有 ref（連 `pre-incident-*` 標記分支）指向目標 commit → 被當成 `have` → **fetch 一個物件都唔拿、亦唔報錯**）。做法：`git update-ref -d` 清走指向該 commit 嘅 ref → `git fetch --negotiation-tip=<完好 commit> origin main` → `git fsck` 要零 missing。（**GitHub Desktop 認唔到 repo = 帶 `--branch` 嘅 `git status` exit 128**；無 `--branch` 版本照 OK，別被騙。`refs/remotes/origin/` 會被環境搬走 → 要 `mkdir + head -c 40`/`printf` 重建。）
- 🔴 **出紙修正「改咗代碼但行為唔變」＝ 幾乎一定係出紙程式冇重 build / 冇發佈**（docs/101/102/103/114）。**不只要重 build，仲要擰 `versionCode`**——唔擰就分唔清部機裝咗邊個 build（實例：docs/114 嘅分格線修正 09-10 寫好、一直只喺源碼，部機跑 09-04 APK → 09-11 實紙仍然「一條線變兩條」；反觀網頁會自動更新，所以出現「預覽正常、實紙唔正常」）。驗證：`git log -1` 日期 vs `app/build/outputs/apk/debug/*.apk` mtime vs 工作區 `git status`（`M` = 未 commit）。Android 建置要先俾 `JAVA_HOME`（`/c/Program Files/Android/Android Studio/jbr`），否則 `ERROR: JAVA_HOME is not set`；SDK 路徑喺各 repo `local.properties`。
- 🔴 **出紙通道地圖（改 renderer 前必讀）**：四份同一算法嘅實作都要各自 build／發佈 —— `print-relay` APK（**正式出紙通道**）、`print hub`（同名 App 舊檢出）、`print-agent-android`、`desktop-companion`（**Macau POS Desktop = Electron 載 Vercel 網頁 + 內嵌 companion :9311**）。用戶講「我用網站版」**唔等於冇出紙程式**：純 website / PWA 會 **skip** companion 分支（`dispatch.ts` / `print-test-print.ts` 只認原生殼或 `?companion=`）→ 只剩「雲端中繼 → 店內機 claim」；**全 repo 除 `qr-print.ts` 外冇 `window.print()` 出單路徑**。桌面版更新 feed = `https://macau-pos-system.vercel.app/releases/`（`latest.yml` + `manifest.json`），由 POS repo `public/releases/` serve；⚠️ `desktop-companion/scripts/release.mjs` 嘅 `PROJECT_ROOT` 假設兩個專案同 repo（實際一個喺 `C:\dev\desktop-companion`、一個喺 `C:\dev\macauPos\macauPosSystem`）→ **會寫去唔存在嘅 `C:\dev\public\releases`，要人手複製**（0.1.16 就係咁冇上到網站）。`desktop-companion` 冇 `.git`。
- 環境見 AGENTS.md（Node 22.22.2-2、Next.js 16.3.0 + Turbopack + Tailwind 4）。
