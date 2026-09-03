# Macau POS System — 專案記憶

## 結構
澳門 Web POS（`C:\dev\macauPos\macauPosSystem`），前台已上線（macau-pos-system.vercel.app，Supabase `zymdemjflsckicwcinxl`）。Next.js 16 + React 19 + TS5 + Tailwind4 + Supabase（Ledger 必配 / POS 可選）+ PWA + LocalStorage 離線優先 + print-bridge。
- `src/app/`（餐飲 v1 + salon）；`src/components/pos-app.tsx` 核心。`src/lib/types.ts` 權威。
- **Android Print Agent**：獨立 repo `C:\dev\print-agent-android`（v1.1.2/code 7）。remote `origin` = github.com/EricChang1015/pos-printer-android。
- **Print Hub**：獨立 repo `C:\dev\print hub`（com.macau.printhub, v1.1.2/code 4）。純 LAN relay hub（無 Sunmi、無 WebView）：IP 掃描 + NanoHTTPD 8787 + 日誌 + 配對。**2026-09-03 先至 `git init`**（之前一直無版控），首次 commit `d77a54e`，remote 未設。

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
- **`macau-store-a` 係 admin 帳號系統嘅示範店代碼，同 `merchants.id`（UUID）係兩套嘢**。見到就要警覺：寫落 `pos_print_jobs.store_id` 或拎去配對，會變「配咗對但印唔出單」。
- **`pos_print_agents` 冇 `store_name` 欄**（0020 只喺 `pos_print_jobs` 加咗）。select/insert 佢會 42703 → `loadPairedAgent()` 返 null → claim/result/heartbeat 認證全斷 + `GET /pair` 永遠 pending + `/pair-status` 500。店名一律由 auth session（`merchants.name`）提供。

## 打印
- **通道優先級**（`dispatch.ts`）：① native bridge ② Companion ③ Cloud Relay。relay 只喺 pure-web 觸發；`RelayPairingPanel` 已 self-gate（`isRunningInNativeShell()` → `return null`）。
- **Companion loopback 唔好主動探**（2026-09-02）：`shouldAutoDiscoverCompanion()` 閘 —— 只有 PC 原生殼或 page 喺 localhost 先探 `127.0.0.1:9311`。純 website 探只會永久 `ERR_CONNECTION_REFUSED`（loopback 係 trustworthy origin，唔會被 mixed content 靜默擋）。用家主動嘅 `?companion=` / 設定頁「測試連線」照行。
- **⚠️ 已知安全缺口（未修）**：`pos_print_jobs` 嘅 anon RLS 策略 **冇 filter `store_id`** → 揸住 anon key（公開）讀到全平台所有店嘅 print job。0016 就係咁，唔係 Scheme B 引入。詳見 `docs/97 §5.2`。
- **⚠️ Supabase RLS 兩個地雷（2026-09-02 查證，改 production policy 前必睇）**：
  ① Realtime `postgres_changes` **只推即時變更、唔回放歷史** → 時間窗對 Realtime 暴露面**零影響**，淨影響 PostgREST 直接 SELECT。
  ② Realtime 對 **UPDATE** 事件係用**新 row** 過 RLS SELECT policy，而 `created_at` UPDATE 時唔會變 → 時間窗太短（如 1h）會擋咗「延遲認領」單嘅 UPDATE，web 收唔到出紙結果。`use-pos-realtime.ts:79` 訂閱緊 `event: "*"`，中招。
- migration `0021` 已寫好（14 days → 24 hours，**未跑**，要人手 Dashboard 貼）。根治要 JWT 帶 `store_id` claim，前置係 Vercel 加 `SUPABASE_JWT_SECRET`（而家冇）；替代方案係中繼機改純輪詢 `POST /claim`。
- **三倉 renderer 合約（docs/95）**：web / Companion / APK 共用。加欄位必須同步三倉。
- **收據金額鐵律**：`原價+服務費+稅−抹零−優惠===總金額`。雙軌 `resolveTotalDiscount()` 取 min 截頂。
- 規格加購價靠右：三倉 `splitSpecLine()` + `twoColumn()`。中文字 2 格、ASCII 1 格。
- **⚠️ 錯誤原因「靜默失敗」checklist（2026-09-03，三倉全中過，寫錯誤處理照住對）**：
  「有計到原因」唔等於「有傳到」，更唔等於「有人睇到」。五問：
  ① 原因有冇**計出嚟** → ② 有冇**存落**資料結構（web 係 `PrintJob.lastError`；Android 係
  `RelayState.lastPrintError`，有 `notePrintError()` helper）→ ③ **UI 有冇讀**
  （留意：state 有唔等於有 render —— `pos-app.tsx` 嘅 `printJobs` 就係擺咗幾個月冇人讀）
  → ④ **headless 場景**（通知欄）有冇 —— 中繼專用機鎖屏擺角落，常駐通知係唯一會俾人
  望到嘅嘢，而且要 `.setStyle(BigTextStyle().bigText(...))`，否則長原因會被 cut
  → ⑤ **會自動消失嘅 UI**（Toast／自動閂嘅頁）有冇機會睇 —— 8787 打印頁以前失敗都
  700ms 自動閂，等於冇講；現改為「印到先自動閂」。
  寫低原因嗰陣**記得喺成功／重試時清走**，否則殘留舊原因誤導人。
  ⚠️ **清 optional 欄位唔好用 destructure-omit**（`const { x: _dropped, ...rest } = obj`）——
  會留低個必然 unused 嘅變數俾 `@typescript-eslint/no-unused-vars` warn（本專案冇開
  `ignoreRestSiblings`）。用 `dispatch.ts` 嘅 `withoutLastError()`：copy 完 `delete next.x`
  （optional 欄位 `delete` 過到 TS strict）。見 commit `dcf95af`。
- **`pos-print-jobs-changed` 事件**：12 個 dispatch 位入面**得 5 個有帶 `detail.printJobs`**，
  其餘 7 個係空 detail 或者淨係 `{count}`（`print-jobs.ts:49`）。**listener 一律重新讀
  `loadPrintJobs()`，唔好信 detail**（`print-center.tsx:162` + `pos-app.tsx` 都係咁做）。
  新加 dispatch 位時唔使夾 detail，但**新加 listener 一定要用 `loadPrintJobs()`**。
- **無打印通道 ≠ 失敗**：`flushPendingPrintJobs()` 喺 `!hasChannel`（未配 companion／
  native bridge／relay）時維持 `pending`，**唔好當 failed 彈紅提示** —— 「從未設定打印」
  係正常狀態，誤報會好煩。真正有通道但失敗先係 `failed`。
- **⚠️ salon 打印係完全另一套 pipeline（2026-09-03 全修，改打印邏輯一定要兩邊都改）**：
  - storage `loadSalonPrintJobs`（`macau-pos-salon/*`）、event `SALON_PRINT_JOBS_CHANGED_EVENT`
    —— **唔係** 餐飲嗰套 `loadPrintJobs` / `pos-print-jobs-changed`。
  - **唔經 `dispatch.ts`**：`salon/print.ts` 自己 call `dispatchJobToNative` /
    `getRelayTransport` / `getCompanionTransport`。
  - **冇 background flush / retry**：`flushPendingPrintJobs` 淨係食餐飲隊列。
  - `resolvePrintJobStatus(_online)`（`companion.ts:450`）**永遠 return `"pending"`**（param 冇用）。
  - **所以 salon 嘅 `pending` 係「一世嘅謊言」** —— 同餐飲**相反**：餐飲 pending 有 worker 會
    重試（啱），salon pending 永遠唔會重試但又顯示「待列印」（錯，要標 `failed`）。
    **改任何打印狀態邏輯，兩邊語義唔同，唔好直接照搬。**
  - 結帳時收據印唔到要用 `describePrintFailures()` 顯示喺成功畫面（`salon/checkout.tsx`），
    因為列印失敗唔阻塞結帳，否則收銀員淨係見到「結帳完成」。

- **⚠️ 同步失敗嘅「靜默」陷阱（2026-09-03 全修，動 sync 邏輯必睇）**：
  - 網絡錯 → 保留 `pending`、**唔加 attempts** → 無限重試 ✅（刻意嘅設計，唔好改）
  - Server 拒收 → attempts++，到 `MAX_SYNC_ATTEMPTS = 5` 標 `failed`
  - **之後 doFlush 第 209 行 `attempts >= MAX` 就 `continue` → 永久 skip，死咗**
  - `POS_SYNC_QUEUE_CHANGED_EVENT` 係 **flush trigger**（`installPosSyncQueueAutoFlush`
    聽到就 flush）。**喺 doFlush 入面 dispatch 佢會無限迴圈**；要通知 UI 請用
    `POS_SYNC_FAILED_EVENT`（淨係 UI 聽，flush 唔聽）。
  - `retryFailedSyncEvents()`（attempts 歸零 + 轉 pending）係永久 failed event
    **唯一嘅救命入口**。冇咗佢，資料永遠留喺本機、上唔到 DB。
  - `pos-app.tsx` 嘅 `queue` state 同 `printJobs` 一樣：**要自己加 listener 先會更新**，
    唔好假設佢反映緊最新狀態。
  - `backoffice-sync-page` 讀嘅係 **server** `syncJobs`，**唔係**本地 queue ——
    傳唔到 server 嘅 event 唔會出現喺度。
- **`no-console` 喺 eslint config 冇開**：檔案入面嗰啲
  `// eslint-disable-next-line no-console` 全部係多餘（會出「Unused eslint-disable
  directive」warning）。**新寫 code 唔好再加**。

## 雲端中繼（Scheme B，解釋文 docs/97 / 規格 docs/96）
iPad(HTTPS) → Supabase Realtime(WSS) → Android Hub(LAN) → LAN printer(:9100)。
- **核心：Vercel 從來冇 call 過店內本機 app**。全部連線係 Hub 主動行出嚟（outbound），所以零入站連線 → 唔使 firewall / port forwarding / 固定 IP / VPN / Cloudflare Tunnel。
- **relay 係備援唔係主力**：能直打（native bridge / Companion）就唔好行雲。
- 「Realtime 負責快，RPC 負責準」：Realtime 斷/漏/截最多慢 60s，絕不漏單或重複印。
- **配對 = Android 自註冊（用戶唔使輸入任何 ID）**：Hub 用 POS 號碼（8 位電話 + 4 位 PIN）打 `/api/ledger/login` → 拎 `merchantId` → `POST /pair` → `GET /pair?agentId=` 拎 `{storeId,supabaseUrl,anonKey}`。web 端行同一條 login 拎同一個 merchantId，所以兩邊天然對上。
- **web 端只剩「檢查配對狀態」一個掣**（`GET /pair-status?storeId=<resolveStoreId()>`），「本店店舖 ID」輸入欄已於 2026-09-02 移除。
- **`POST /pair` 會驗真 storeId**：假店黑名單 + 查 `merchants` 表（`22P02` 當 missing 擋；基建錯 fail-open 只 warn）。缺 storeId 嘅 sync 一律 400（無 DEFAULT fallback）。
- 6 條 Vercel route：`pair`/`claim`/`result`/`heartbeat` + `pair-status`/`unpair`。已完成。
- Realtime payload >1MB 被截 → 只當叫醒，數據經 RPC `pos_claim_print_jobs`（`for update skip locked`）。
- **print-agent-android**（v1.1.1）：含 Sunmi 內置 + LAN + relay 完整功能。
- **print hub**（`C:\dev\print hub`，v1.0.0）：純 LAN relay hub（無 Sunmi、無 WebView），含 IP 掃描 + NanoHTTPD 8787 + 日誌 + 配對。port 自 `print-agent-android` 核心 Kotlin。

## 原生殼檢測
`isRunningInNativeShell()`：`window.PosNative.printJob`（Android）/ `window.companionShell`（PC）。

## 開發環境
- 語言：繁體中文（廣東話風味）。
- git 一律 `run_in_background`；push 前 `git ls-remote` 對。
- **⚠️ `git push` 可能會無限期 hang（GCM 喺 sandbox 死）**：憑證快取過期後，Git Credential Manager 彈唔到認證視窗 → push 卡死無 output（實測 hang 20+ 分鐘）。device flow（`GCM_GITHUB_AUTHMODES=device`）一樣靜默 hang；`git -c credential.helper= push` 會即刻 `fatal: could not read Username`。
  **診斷法**：`git ls-remote` OK 但 push hang = 一定係憑證問題（ls-remote 唔使認證）。
  **解法**：叫用戶喺自己 terminal 跑 `git push`（GCM 喺嗰度彈到視窗）。本機冇 `gh` CLI、冇 SSH key，agent 自己搞唔掂。
  Push 本身可以好慢（實測 58s ~ 6min），Hang 判定要睇有冇 output 而唔係等多耐。
  **2026-09-03 第一次實測（hang）**：`timeout 480 git push --progress origin main > push-out.txt`
  跑足 8 分鐘，`timeout` 掟咗（exit 124），**`push-out.txt` 係 0 bytes** —— 連
  「Enumerating objects」都冇。另外 hang 嗰陣用 `Get-Process` 搵唔到 git process，
  唔好當佢已經退咗。
  **2026-09-03 第二次實測（成功！推翻上面嘅結論）**：同一個 sandbox、同一個指令，
  **`timeout 300 git push --progress origin main` 2m26s 就成功**（exit 0，
  `18eabf7..54b532b main -> main`，output 2737 bytes，正常 print 晒進度）。
  ➡️ **正確理解：push hang 唔係必然，係「GCM 憑證有冇緩存」嘅 intermittant 問題。**
  緩存命中 → 2~3 分鐘成功；緩存冇／過期 → 靜默 hang。所以**唔好一開始就認定
  要交畀用戶**，實用做法：
  ① 用 `run_in_background` + `--progress` + 重定向落檔案；
  ② ~3 分鐘後睇 output bytes：**> 0 即係進行中，等佢**；**一直 0 bytes 即係 hang**；
  ③ hang 就掟咗佢，叫用戶喺自己 terminal push（佢 push 完，憑證入咗緩存，
     之後 agent 再 push 就得返）。
  ④ push 完一定要 `git ls-remote origin` 對 SHA，唔好淨信 exit code。
- **⚠️ 絕對唔好喺呢個環境跑 `git rebase` / `git merge`**：rebase 嘅 bulk checkout 會撞 sandbox 批量刪除保護。
  **兩種實測結果都要記住**：
  (a) 早前（2026-09-03）`print-agent-android` 真係中過招：`.git` 被剷，`5f64e26`+`305adc7` object 變 dangling。
  (b) **2026-09-03 晚再遇一次，結果唔同**：另一個 rebase background task（`AxuaXW`，`git rebase 2a1e7ca`）
      卡咗 **8h38m**，係因為保護**擋住咗** destructive checkout —— `.git` objects 105 個全 intact、
      `git fsck` 零 error、local main 6 個 commit 全喺、無 rebase-merge/apply 殘留。kill 咗之後 repo 完好。
  ➡️ 所以 rebase 喺呢度嘅實際後果係「長期 hang」多過「即時毀滅」，但**千祈唔好賭**——
  見到 rebase background task 跑耐就即刻 `TaskStop` + kill git process，及時 kill 就唔會有破壞。
  要 reconcile 分歧 → **push 去新 branch，喺 GitHub 開 PR merge**，交畀 GitHub 處理衝突。
- **修 `.git` 被剷嘅 SOP**（working tree 通常無事，只係指標斷咗）：
  ① `mkdir -p .git/refs/heads .git/refs/tags .git/refs/remotes/origin .git/logs/refs/heads`
  ② 將仲喺 object store 嘅 base commit SHA 寫入 `.git/refs/heads/<branch>`
  ③ `git update-ref -d refs/remotes/origin/<branch>` 掉咗個指住死 object 嘅 tracking ref
  ④ `git read-tree HEAD` 重建 index（`git status` 會報 `unable to read <sha>` 因為舊 index 指住死 blob）
  ⑤ `git add -A` + 重新 commit。**動手前先 `cp -a` 備份 source**。
- **GitHub credential 錯 account**：本機緩存係 `homeu98-glitch`，但 repo 屬 `EricChang1015` → push 會 403
  （`Permission to ... denied to homeu98-glitch`）。read 正常所以 `ls-remote` 唔會報錯，好易睇漏。要用戶自己重登 / 換 PAT / 轉 SSH。
- **`git fetch` / `git update-ref` 喺呢個環境可以「假成功」**：
  - `git fetch origin main` 會印 `old..new main -> origin/main` 甚至 `* [new branch] main -> origin/main`，
    但 tracking ref 往往**冇真係 persist**（`show-ref` 睇唔到、`git status` 照樣講 upstream gone）。
  - `git update-ref refs/remotes/origin/main <sha>` 報 exit 0 但一樣冇 persist。
  ➡️ **可靠做法：手寫 loose ref 檔**（`mkdir -p .git/refs/remotes/origin && printf '%s\n' <sha> > .git/refs/remotes/origin/main`）。
  2026-09-03 晚實測：update-ref 靜默失敗，手寫之後 `show-ref` / `git status` 即刻恢復正常。
  ⚠️ 記住末尾加 `\n`，唔係 `git fsck` 會 warning `refMissingNewline`（無害但污糟）。
  判斷分歧**一定要用 SHA 直接對**（`git merge-base --is-ancestor <remote-sha> HEAD`、
  `git rev-list --left-right --count <remote-sha>...HEAD`），唔好淨信 `origin/main` 呢個 ref。
- **⚠️ 帶 `/` 嘅 git ref 喺呢個 sandbox 係壞嘅（2026-09-03 實測，全部 exit 0 零 output）**：
  原因係 git 自己要喺 `.git/refs/heads/` **開子目錄／rename** —— sandbox 唔批。實測：
  - `git branch fixtmp <sha>`（**冇斜線**，唔使開目錄）→ ✅ 得
  - `git branch fix/xxx <sha>`（有斜線）→ ❌ 靜默 no-op
  - `git update-ref refs/heads/fix/xxx <sha>` → ❌ 靜默 no-op
  - **`git branch -f fix/xxx <sha>`（ref 已存在）→ ☠️ 會把條 ref 剷走！**（比 no-op 更衰，靜默 delete）
  - `mkdir -p .git/refs/heads/fix` 再 `echo <sha> > .git/refs/heads/fix/xxx` → ✅ 得（shell mkdir 可以，git 內部唔可以）
  - `git commit` 更新**已存在**嘅 `refs/heads/main` → ✅ 得
  **鐵律：任何 git ref 操作完一定要 `git show-ref` verify，唔好信 exit code。**
  要更新帶斜線嘅 branch → 手寫 ref 檔（`echo <sha> > .git/refs/heads/<dir>/<name>`）。
  要 push → 用 `git push origin <sha>:refs/heads/<name>`，完全唔使本地 ref，避開成個坑。
- `tsc --noEmit` 唯一誤報：`layout.tsx LayoutProps`。
- **⚠️ Next 16 冇咗 `next lint`**：`npx next lint` 會把 `lint` 當 project directory
  （`Invalid project directory provided, no such directory: ...\lint`）。`package.json` 嘅
  script 係 `"lint": "eslint"`，直接用 **`npx eslint <files>`**（成個 src 好慢，淨 lint 改過嘅檔）。
- **eslint baseline（2026-09-03 實測，改動前後對照用）**：`pos-app.tsx` + `print-center.tsx`
  已有 **9 個 unused-var warning（死碼）+ 4 個 `react-hooks/refs` error**，全部係既有嘅，唔使驚。
  嗰 4 個 error 全部喺 `print-center.tsx:494`，係 React Compiler 規則對
  `onChange={(e) => ... e.target.checked}` 嘅**已知 false positive**（同 `eslint.config.mjs`
  已經閗咗 `react-hooks/set-state-in-effect` / `purity` 同一類）。
  **判斷自己有冇引入新問題：淨係對照自己改過嘅行號。**
- **`npx next build` 前要先 `mv .next .next.bak-<ts>`**，否則 Turbopack 清快取會撞 sandbox 批量刪除保護（count 50 / threshold 50）→ 卡 20 分鐘後報 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。改名後 1.5 分鐘 build 完。`.gitignore` 已有 `/.next.bak*/`。
- Android build：`export JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"` + `./gradlew assembleDebug`。print hub 首次需 online（nanohttpd 等新 dep）。
- **⚠️ 兩個 Gradle build 唔好並行跑**：print hub 同 print-agent 一齊 `assembleDebug`，
  其中一個會喺 `:app:dexBuilderDebug` 報 `desugar_graph/.../graph.bin (存取被拒。)`
  `AccessDeniedException`。分開跑就正常（各 ~1min）。
- **Kotlin 陷阱**：`runCatching { ... }` 嘅 lambda 最後一個 expression 如果本身係 `runCatching { }`，
  返回型會變 `Result<Result<Unit>>` → 報「Return type mismatch」指住外層 `runCatching` 嗰行，
  好難睇得出。改用普通 `try/catch`。
- 寫咗 migration ≠ 跑咗 migration；本機冇 DB → 人手 Dashboard SQL Editor 貼。
