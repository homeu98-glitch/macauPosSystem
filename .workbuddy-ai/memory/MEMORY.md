# Macau POS System — 專案記憶

## 結構
澳門 Web POS（`C:\dev\macauPos\macauPosSystem`），前台已上線（macau-pos-system.vercel.app，Supabase `zymdemjflsckicwcinxl`）。Next.js 16 + React 19 + TS5 + Tailwind4 + Supabase（Ledger 必配 / POS 可選）+ PWA + LocalStorage 離線優先 + print-bridge。
- `src/app/`（餐飲 v1 + salon）；`src/components/pos-app.tsx` 核心。`src/lib/types.ts` 權威。
- **Android Print Agent**：獨立 repo `C:\dev\print-agent-android`（v1.1.2/code 7）。remote `origin` = github.com/EricChang1015/pos-printer-android。
- **Print Hub**：獨立 repo `C:\dev\print hub`（com.macau.printhub, v1.1.2/code 4）。純 LAN relay hub（無 Sunmi、無 WebView）：IP 掃描 + NanoHTTPD 8787 + 日誌 + 配對。2026-09-03 `git init`，首次 commit `d77a54e`。

## 重要約定
- localStorage：餐飲 `macau-pos/*`；salon `macau-pos-salon/*`。PrintJob 模型共用。
- Ledger 介面層不可繞過。不引入新依賴。
- 設定真源：per-terminal 本地優先；其餘 server 優先。
- itemIdentity 三邊同步：`menuItemId|specs|price|note`。
- 備註鎖定（docs/84）：鎖 sent_to_kitchen/paid/settled 等；唔鎖 draft/reopened。
- 非永久狀態唔越界：`*-temp/-draft/-ghost` 在 render + persistence 都要 filter。
- 長文字 `whitespace-pre-wrap break-words`，唔好 `truncate`。
- 訂單排序一律 `compareOrderByLocalNo()` = 純 `createdAt` asc。
- **storeId 單一真源 = `resolveStoreId()`（`src/lib/pos/sync-flush.ts`）**：登入 `merchantId` → kiosk binding → undefined。所有 sync / pair-status call site 必須用佢，唔好自己砌 `??` 鏈。
- **`macau-store-a` 係 admin 帳號系統嘅示範店代碼，同 `merchants.id`（UUID）係兩套嘢**。
- **`pos_print_agents` 冇 `store_name` 欄**（0020 只喺 `pos_print_jobs` 加咗）。select/insert 會 42703 → `loadPairedAgent()` 返 null → 全斷。店名由 auth session 提供。

## 打印
- **通道優先級**（`dispatch.ts`）：① native bridge ② Companion ③ Cloud Relay。relay 只喺 pure-web 觸發；`RelayPairingPanel` 已 self-gate（`isRunningInNativeShell()` → `return null`）。
- **Companion loopback 唔好主動探**（2026-09-02）：`shouldAutoDiscoverCompanion()` 閘 —— 只有 PC 原生殼或 page 喺 localhost 先探 `127.0.0.1:9311`。用家主動嘅 `?companion=` / 設定頁「測試連線」照行。
- **Health check polling 兩環境分流**（2026-09-03，`companion.ts` `subscribeCompanionAvailability()`）：純 Website early-return 唔探；Companion 環境探一次 + 15 秒週期輪詢。判斷 = `shouldKeepCompanionAlive()`。
- **⚠️ 已知安全缺口（未修）**：`pos_print_jobs` 嘅 anon RLS 策略冇 filter `store_id` → anon key 讀到全平台 print job。
- **⚠️ Supabase RLS 兩個地雷**：
  ① Realtime `postgres_changes` 只推即時變更、唔回放歷史。
  ② Realtime 對 UPDATE 用新 row 過 RLS SELECT policy，`created_at` UPDATE 時唔變 → 時間窗太短會擋延遲認領單嘅 UPDATE。
- migration `0021` 已寫好（14 days → 24 hours，**未跑**）。
- **三倉 renderer 合約（docs/95）**：web / Companion / APK 共用。加欄位必須同步三倉。
- **收據金額鐵律**：`原價+服務費+稅−抹零−優惠===總金額`。雙軌 `resolveTotalDiscount()` 取 min 截頂。
- 規格加購價靠右：三倉 `splitSpecLine()` + `twoColumn()`。中文字 2 格、ASCII 1 格。
- **⚠️ 錯誤原因「靜默失敗」checklist**：① 原因有冇計出 → ② 有冇存落資料結構 → ③ UI 有冇讀（state 有唔等於有 render）→ ④ headless 場景有冇（通知欄要 `BigTextStyle`）→ ⑤ 會自動消失嘅 UI 有冇機會睇。寫低原因記得喺成功／重試時清走。清 optional 欄位用 `withoutLastError()`（copy 完 `delete next.x`），唔好用 destructure-omit。
- **`pos-print-jobs-changed` 事件**：12 個 dispatch 位得 5 個有帶 `detail.printJobs`。listener 一律重新讀 `loadPrintJobs()`，唔好信 detail。
- **無打印通道 ≠ 失敗**：`!hasChannel` 時維持 `pending`，唔好當 failed 彈紅提示。
- **⚠️ salon 打印係完全另一套 pipeline**：storage `loadSalonPrintJobs` / event `SALON_PRINT_JOBS_CHANGED_EVENT`，唔經 `dispatch.ts`，冇 background flush / retry。`resolvePrintJobStatus()` 永遠 return `"pending"`。salon pending = 永遠唔重試（同餐飲相反）。結帳時用 `describePrintFailures()` 顯示打印失敗。
- **CompanionStatusCard（含「測試連線」掣）**：喺 `printer-companion-panel.tsx`，2026-08-30 commit `1c56c1a` 由 `device-settings.tsx` 移除（UI refactor 附帶損失），salon settings 仍有。2026-09-03 加返。

## 同步失敗「靜默」陷阱
- 網絡錯 → 保留 `pending`、唔加 attempts → 無限重試（刻意設計）。
- Server 拒收 → attempts++，到 `MAX_SYNC_ATTEMPTS = 5` 標 `failed` → doFlush `continue` → 永久 skip。
- `POS_SYNC_QUEUE_CHANGED_EVENT` 係 flush trigger，喺 doFlush 入面 dispatch 會無限迴圈；通知 UI 用 `POS_SYNC_FAILED_EVENT`。
- `retryFailedSyncEvents()`（attempts 歸零 + 轉 pending）係永久 failed event 唯一救命入口。
- `pos-app.tsx` 嘅 `queue` / `printJobs` state 要自己加 listener 先會更新。
- `backoffice-sync-page` 讀 server `syncJobs`，唔係本地 queue。
- retry filter 必須用 `status === "pending"`，唔好 `status !== "synced"`（會夾埋 failed event retry）。
- 交班記錄顯示「待同步」要分開 `pendingEvents` 同 `failedEvents`。
- `no-console` 喺 eslint config 冇開，唔好加 `// eslint-disable-next-line no-console`。

## 雲端中繼（Scheme B）
iPad(HTTPS) → Supabase Realtime(WSS) → Android Hub(LAN) → LAN printer(:9100)。
- Vercel 從來冇 call 過店內本機 app，全部連線係 Hub 主動 outbound → 零入站連線。
- relay 係備援唔係主力。
- 配對 = Android 自註冊（POS 號碼 login → merchantId → POST /pair → GET /pair）。
- web 端只剩「檢查配對狀態」掣（`GET /pair-status?storeId=<resolveStoreId()>`）。
- 6 條 Vercel route：`pair`/`claim`/`result`/`heartbeat` + `pair-status`/`unpair`。
- Realtime payload >1MB 被截 → 只當叫醒，數據經 RPC `pos_claim_print_jobs`。

## 原生殼檢測
`isRunningInNativeShell()`：`window.PosNative.printJob`（Android）/ `window.companionShell`（PC）。

## 開發環境
- 語言：繁體中文（廣東話風味）。
- git 一律 `run_in_background`；push 前 `git ls-remote` 對。
- **git push 可能 hang（GCM 憑證問題）**：緩存命中 → 2~3 分鐘成功；緩存冇 → 靜默 hang。診斷：`git ls-remote` OK 但 push hang = 憑證問題。解法：叫用戶自己 terminal push。
- **唔好喺呢個環境跑 `git rebase` / `git merge`**：會撞 sandbox 批量刪除保護或長期 hang。要 reconcile → push 去新 branch，GitHub 開 PR merge。
- **帶 `/` 嘅 git ref 喺 sandbox 係壞嘅**：用 `git branch <name>`（冇斜線）或手寫 loose ref 檔。任何 git ref 操作完一定要 `git show-ref` verify。
- `tsc --noEmit` 唯一誤報：`layout.tsx LayoutProps`。
- **Next 16 冇咗 `next lint`**：直接用 `npx eslint <files>`。
- **eslint baseline**：`pos-app.tsx` + `print-center.tsx` 已有 9 個 unused-var warning + 4 個 `react-hooks/refs` error（既有 false positive）。
- **`npx next build` 前要先 `mv .next .next.bak-<ts>`**，否則 Turbopack 清快速會撞 sandbox 批量刪除保護。
- Android build：`export JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"` + `./gradlew assembleDebug`。
- 兩個 Gradle build 唔好並行跑（`desugar_graph` AccessDeniedException）。
- Kotlin 陷阱：`runCatching` lambda 最後 expression 如果本身係 `runCatching`，返回型變 `Result<Result<Unit>>`。改用 `try/catch`。
- 寫咗 migration ≠ 跑咗 migration；本機冇 DB → 人手 Dashboard SQL Editor跑。
