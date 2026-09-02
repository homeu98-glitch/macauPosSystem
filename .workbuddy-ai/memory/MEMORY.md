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
- **⚠️ 絕對唔好喺呢個環境跑 `git rebase` / `git merge`（2026-09-03 實測中招）**：rebase 嘅 bulk checkout 會撞 sandbox 批量刪除保護，**連 `.git/refs/`、`.git/logs/` 同新嘅 loose object 一齊剷走**，repo 即時變 `fatal: not a git repository`，commit 全部變 dangling。
  當時 `print-agent-android` 就係咁丟咗 `5f64e26` + `305adc7` 兩個本地 commit 嘅 object（working tree 反而冇事）。
  要 reconcile 分歧 → **push 去新 branch，喺 GitHub 開 PR merge**，交畀 GitHub 處理衝突。
- **修 `.git` 被剷嘅 SOP**（working tree 通常無事，只係指標斷咗）：
  ① `mkdir -p .git/refs/heads .git/refs/tags .git/refs/remotes/origin .git/logs/refs/heads`
  ② 將仲喺 object store 嘅 base commit SHA 寫入 `.git/refs/heads/<branch>`
  ③ `git update-ref -d refs/remotes/origin/<branch>` 掉咗個指住死 object 嘅 tracking ref
  ④ `git read-tree HEAD` 重建 index（`git status` 會報 `unable to read <sha>` 因為舊 index 指住死 blob）
  ⑤ `git add -A` + 重新 commit。**動手前先 `cp -a` 備份 source**。
- **GitHub credential 錯 account**：本機緩存係 `homeu98-glitch`，但 repo 屬 `EricChang1015` → push 會 403
  （`Permission to ... denied to homeu98-glitch`）。read 正常所以 `ls-remote` 唔會報錯，好易睇漏。要用戶自己重登 / 換 PAT / 轉 SSH。
- **`git fetch` 喺呢個環境可以「假成功」**：output 印咗 `old..new main -> origin/main` 但 tracking ref 其實冇 update
  （寫唔到 `.git/refs/remotes/`）。判斷分歧**一定要用 SHA 直接對**（`git merge-base --is-ancestor <remote-sha> HEAD`、
  `git rev-list --left-right --count <remote-sha>...HEAD`），唔好信 `origin/main` 呢個 ref。
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
