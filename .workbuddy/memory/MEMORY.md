# macauPos 記憶索引

> 上限 3k。必讀 `docs/113-agent-gotchas.md`。

## 一、API 鑑權
- 🔴 44/57 route 曾無鑑權、**冇 `middleware.ts`**；server client 用 service_role **繞 RLS** ⇒ 無鑑權＝裸奔 DB。
- 加閘用 `posRouteAuthGuard(request, storeId, tag)`，**放喺「未配置 Supabase／缺 storeId」early-return 之後**；客戶端用 `posDeviceAuthHeadersFresh()`。
- **匿名端點唔可以加閘**：bootstrap GET、sequence、sync 匿名通道、ledger/member-login、order-lookup、kds/*、`print-agent/pair`。
- 🔴 **`POS_REQUIRE_DEVICE_AUTH` 冇設 ＝ 閘照樣開著**（空值回 `true`）。**「冇設」≠「關閉」**。
- 🔴 **2026-09-16 09:00 實測：此值已被設為 `0`（全局關閉）** —— 匿名零憑證打 `state`／`print-jobs/status`／`device-config`／`orders`／`pair-status` 全回 **200**。
  `resolvePosRouteAuth()`（`pos-route-auth.ts:59`）第一條 `disabled` 分支直接放行 ⇒ 知道 `storeId` 就可讀寫該店。
  ⚠️ **唔可以未確認就改返 `1`**（iPad token 續期未通 ⇒ 即刻全站 401）。**次序**：先確認 `POST /api/pos/device-token` 回 200+token ⇒ 再設 `=1` + Redeploy ⇒ 逐端點驗 401。
- 簽名密鑰 `resolveSecret()`：`POS_DEVICE_TOKEN_SECRET` → `ADMIN_SESSION_SECRET` → `SUPABASE_SERVICE_ROLE_KEY`；TTL 12h。判簽發能力＝打 `POST /api/pos/device-token`（503＝真缺）。

## 二、DB
- POS = `iyrywzormzisyppkokbi`、Ledger = `zymdemjflsckicwcinxl`。**已跑** 0016/0021/0041§1；**未跑 0042**。
- 🔴 migration **唔可以用 psql 專屬語法**（`:'var'`/`\set`）。
- 🔴 `pos_orders`/`pos_print_jobs` anon policy **冇 store_id 過濾**；唔可以就咁加（收銀台/KDS/Hub 用 anon 訂 Realtime → 靜默失效）；根治要 per-store token（0041§3）。
- ⚠️ `pos_print_agents` anon 冇 SELECT（`42501`）⇒ 睇心跳要 service_role。
- **一個專案可有多個 `store_id`，每店一台中繼機**。第一步要「唔帶 store 過濾」掃：
  `select store_id, count(*) filter (where finished_at is null) from public.pos_print_jobs group by 1 order by 2 desc;`

## 三、打印
- 🔴 建單/接單後必須 `appendPrintJobsWithSync()`；淨 `savePrintJobs()`＝**零出紙＋零紅標**。
- 🔴 出紙只喺**內容事件**（新單/改單/加菜/結帳）；轉換/採納/排位**唔出紙**。去重靠 `job.orderId`。
- 🔴 「改咗但行為唔變」＝① 冇 re-build／冇擰 `versionCode` ② 收銀機載 **Vercel 部署**。
- `ttl` = **絕對 epoch ms**；只喺 insert 寫 ⇒ 舊行恆 NULL＝永不過期（=`pos_void_stale_print_jobs()` 盲區）。
- 🔴 `0042`（未跑）= claim **分段式**：同機 6min／跨機 90s（純 90s → 搶自己長單 → **重複出紙**）。
- 「重試打印」＝ `POST /api/pos/print-jobs/retry`（冪等，成功回 409）。原因碼唯一用 `print-job-failure.ts`。
- 🔴 **判失敗真因睇 `last_error` 原文**：`兩種通道都失敗｜直連：failed to connect to /<打印機IP> from /<中繼機IP>` ⇒ **網段不通**。
- 🔴 **判中繼機跑邊個 App**：`兩種通道都失敗｜…` ⇒ **`print-relay`（com.macau.printhub）**；`dispatch failed` ⇒ **`macau-ledger-merchant`（com.macauledger.merchant）`PosJobRunner.kt:247` 硬編碼**（源碼 `C:\dev\_ref-macau-ledger-merchant`）。
- 🔴 **中繼機同打印機必須同網段**：`192.168.31.x`＝店內路由器；`10.61.x.x`／`172.20.10.x`＝手機熱點／流動網絡。
- 🔴 **APK dex 係 DEFLATE 壓縮**：直接掃 .apk 一定假陰性 ⇒ 解 zip + `zlib.inflateRawSync`（`tools/_apk-strings.cjs`）。
- ⚠️ **定時炸彈**：`print-relay` `fetchDeviceConfig()`（`RelayApi.kt:221`）**冇帶憑證**，收緊 `device-config` 即「拉唔到配置 → IP 變 NULL → 全店停印」。
- ⚠️ `/api/pos/sync` 只寫 `printer_name`/`printer_id`，**`printer` jsonb 從來冇寫**；`claim/route.ts:42` 硬編碼 `printers:[]` ⇒ APK 只靠 `device-config`（60s）攞 IP。
- ⚠️ `device-config` 缺 storeId 時 early-return **200** ⇒ 唔可以用 200 判店是否存在。
- ⚠️ `result/route.ts` 寫 `failed` 時**冇同時改 `status`** ⇒ 出現 `status='printing'` 但 `last_error` 有值嘅不一致行。
- ⚠️ 該 App dispatch 失敗原因被吞三層（`LanTcpPrinter.kt:27` 回 false → `PosPrintDispatcher` 回 Boolean → `PosJobRunner:247` 硬編碼）⇒ 雲端分唔清 refused/timeout。

### 中繼配對
- 🔴 `paired:true` 只係「`pos_print_agents` 有行」＝**歷史事實**，唔等於機活著。
- 🔴 `pair-status` 401 → panel 顯「配對失敗」→ **配對流程自己停擺**。401 正解＝**iPad 重新登入**。
- 🔴🔴 **「配對失敗：POS 雲端未設定」係「垃圾桶文案」**（2026-09-16 09:10 實測推翻「Vercel 憑證缺」）：
  `GET /pair` 實測回 `status:"paired"` + 兩欄齊全 ⇒ **Vercel 側冇問題**。**真兇**＝`PosPairingManager.kt:65-68` `restorePairing()` 要求 `status=="paired"`，
  而 agent 一旦被撤銷 ⇒ 永遠回 **`{"status":"pending"}`** ⇒ **靜默 `return false`**；之後 `autoPair()` 靠 `AppSession.merchant.merchantId`（未登入 Ledger ⇒ 空 ⇒ 一樣失敗）。
  失敗文案由 `PosRelaySession.kt:219` `?: "配對失敗：POS 雲端未設定"` 冒泡 ⇒ **三種無關原因同一句**。
  **次序**：① `GET /pair` 回 `pending` ⇒ **App 內重新配對** ② `paired` 但兩欄空 ⇒ 查 Vercel env ③ `paired` 有值 ⇒ 查 **Ledger 登入態** ④ 才輪到 `BuildConfig.POS_URL`。**唔使改 Vercel、唔使重裝 APK。**
- 🔴 **「能 claim」同「配對失敗」可同時為真**：claim 唔需 Supabase 憑證；但 `PosRelayClient.init()` 失敗 ⇒ `client==null` ⇒ **Realtime 從不訂閱，只剩 60s 對賬**。
- 🔴 **「外賣: 已連線」＋「堂食POS: 配對失敗」唔矛盾**：`PrinterService.kt:74-76` 用 `combine()` 把 MQTT 同 relay 兩條獨立通道接成一句文案。
- 🔴 徽章綠（localStorage `pairing`）同紅塊（`state.kind==="failed"`）係**兩個獨立 state**。`macau-pos-relay-auto-pair-stopped` 落 localStorage 後 **reload 都唔自動重配**。
- 🔴 **`macau-ledger-merchant` 配對五道防線**（`PosPairingManager.kt:13-44`）：`POS_URL` 空即停／只認 `ok:true`／`storeId≠merchantId` 拒絕／URL 唔可等於 `BuildConfig.SUPABASE_URL`／url+key 成對非空。其 `POS_URL` 只在 `.env.example`（`loadProjectEnv()` 只讀第一個存在嘅檔、唔合併）。
- ⚠️ 該 App「堂食測試印」`PosRelaySession.kt:146-153` **繞過 runner 直接 sendRaw** ⇒ **出紙 ≠ 配對正常**。
- **判機死活**＝有無 `claimed_by` 非 NULL 行；`attempts=0` 全 NULL＝從來冇 claim。
- **唔靠 secret 探測**：線上 bundle 抽 `eyJ…` → 中段 `ref` 認專案 → 唯讀打 PostgREST。
- 🔴 **`resolveStoreId()`（`sync-flush.ts:308-314`）＝登入 session 嘅 `merchantId`**；`print-center.tsx:419-424` 用佢叫 `pair-status`。
  ⇒ **UI banner 可能顯示別店心跳**（2026-09-16：截圖「1138 分鐘前」＝ `8291f843`(1154分)，非現場 `d564b932`(68分)）。**先確認 iPad 登入邊個 merchantId**。
- 🔴 **判機死活唔可以睇 `/prints` 嗰句「N 分鐘前」**（`print-center.tsx:1769-1772` 純前端計算、會膨脹）。
  要實時打 `GET /api/pos/print-agent/pair-status?storeId=` 讀 `lastSeenAt`，對照 `pos_print_jobs` 最後 `claimed_at`；
  **兩者同一秒停 ⇒ `PosJobRunner` 已死**（心跳 30s 同 tick 60s 獨立 coroutine 同時停＝整個 scope 被 cancel）
  ⇒ **唔使重配／改 Vercel／重裝 APK，只需叫醒個 App**（切前台 → 重啟 → 電池「不限制」＋自啟動）。
- 🔴 **爆紙警告**：通道修好後舊 job 會同時出紙。**修之前**必先 `select public.pos_void_stale_print_jobs('<storeId>')`。
  ✅ `attempts>=5` 嘅行**安全**（`coalesce(attempts,0) < 5` 唔成立 ⇒ 永不 claim）。
  🔴🔴 **但該函式回 `0` 唔代表清乾淨**：`0042:140-146` 條件係 `ttl is not null and ttl <= now` ⇒ **`ttl IS NULL` 永遠掃唔到**。
  2026-09-16 實案：11 張風險單 ⇒ 回 `0` 後覆核**一張都冇變**。**驗證法**＝跑前跑後 `count(*) where finished_at is null and coalesce(attempts,0)<5` 比對。清 `ttl=NULL` 只可用 UPDATE 退路，**逐店分開跑**。

### 孤兒單 / 隔離區（2026-09-09 方案 A）
- 🔴 **訂單號顯示 `print-xxxxxxxx` ＝ 本機孤兒單，唔喺雲端**（2026-09-16 結案）：
  該值是 **`PosOrder.localOrderNo` 本身壞**（建單時誤寫 `uid("print")`），
  出現在「同步健康檢查」彈窗的 **「已隔離訂單」** 區塊（`sync-health-modal.tsx:531`），
  標註「自動隔離（手動更新）」＝`reason:"auto-full-pull"`（`pos-app.tsx:1409` 全量拉取後自動）。
- 🔴 **唔可以用查雲端 DB 去找呢類單** —— `pos_orders` 掃 `print-%` 必然 **0 rows**（已實測）。
  佢哋係 `QuarantinedOrderRow`（`storage.ts:989`）= 本機 localStorage `{order, quarantinedAt, reason}`，
  **從來冇上雲**。要睇就喺 App 內（同步健康檢查）或讀本機 localStorage。
- 隔離三條件（`sync-reconcile.ts:260-264`）：本機非終態 ＋ 雲端全量冇 ＋ outbox 冇 pending/failed `ORDER_*`；
  ＋單齡 ≥ `ORPHAN_MIN_AGE_MS` = **10 分鐘**（防 flush/pull 競態）。
- ⚠️ 隔離區係**救生艇唔係檔案庫**：`MAX_QUARANTINED_ORDERS = 200`，超出由最舊剷。
- 🔴 **「還原」對孤兒單係陷阱**：還原＝放返 `orders`，雲端永遠冇 ⇒ 又變孤兒。
  應「永久刪除」（寫 tombstone；`restoreQuarantinedOrder` 有 tombstone 分支會清隔離記錄唔還原）。

## 四、訂單
- 🔴 結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱），唔准全店 `find()`。
- 🔴 已收款單加菜**必須保留 `paid`**，否則雲端拒收整條 `ORDER_UPDATED`。
- 🔴 「RPC 冇拋錯」≠ 遠端已改：爬梯（`online-dinein-ladder.ts`）無效轉換跳過。
- 狀態文案唯一：只有 `pickup`/`takeaway`＝「待取餐」，其餘「待交付」。
- 列枱用 `buildDisplayFloors(bootstrapTables, localSettings.floors)`。Ledger 真欄 `selected_specs`/`line_note`。

## 五、UI
- 🔴 `button { font: inherit }`（globals.css 無 layer）壓過 `text-*` ⇒ **按鈕字級寫喺仔元素**；`p-[3px]` 同 `px-3 py-1.5` **唔可以並存**。
- 🔴 iPad standalone 撳輸入欄**唔彈鍵盤**。`print-center.tsx` 有 16 個**既有** eslint error。

## 六、環境
- ⚠️ `npm`/`npx` 跑唔到；**冇 coreutils** → 用 Read/Glob/Grep 或 node fs；複雜 JS 寫 `.cjs`。
- ⚠️ git 全路徑 `…/PortableGit/versions/1.2.0/cmd/git.exe`；push 加 `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never`。
- ⚠️ `.git` 易被沙箱破壞。修法見 skill `git-repo-rescue`。
- ⚠️ 同檔**唔可以同一 message 發多個 Edit**。`Glob` 唔索引工作區外。
- 🔴 **Vercel 改 env 唔會自動套用到現有 deployment，一定要 Redeploy。**

## 七、口徑
- 收入認列 `isSaleCountable()`：只計 `settled`／帶 `onlineOrderId` 嘅 `paid`。日期用 Macau 邊界。
- 雲端讀到＝唯一可信源；store 隔離 `o.storeId === merchantId`。
- 快餐單 `isQuickCounterOrder`；線上堂食 `isOnlineDineInOrder`（**唔可以改闊**）／`isPaidDineInOrder`。
- 線上接單＝Ledger `merchant_enabled`／線下接單＝`pos_store_status.is_open`，**唔准同名同色**。
- 🔴 **時間軸一律換算 Macau(+8)**：GitHub commit 係 UTC。

## 八、判別／取證（2026-09-16 加）
- 🔴 **訂單 id 前綴 = 邊個程式建單**（唯一可靠判別法）：
  `order-`＝收銀台／快餐（source **寫死 `pos`**，`pos-app.tsx:2412,2428,3446`）／`staff-`＝店員手機／`kiosk-`＝自助機 `/order` 或掃碼（`use-kiosk-order.ts:856`）／
  **`ledger-<ledgerOrderId>`＝線上單鏡像**（`ledger-pos-bridge.ts:567`）。
  ⇒ **收銀台永遠唔會出「自助點餐機」徽章**（徽章＝`source==="kiosk"`）。
- 🔴 **訂單列表顯示嘅時間係「最後更新」，唔係建立時間**（kiosk 單實案：顯示 19:41 其實係取消時間，建立係 19:27）。
  判建立時間一律睇 `pos_orders.created_at`。
- 🔴 **事件 payload 兩種形狀**：裸 order（收銀台落單／kiosk）vs `{ order, addedItems }`（加單／線上單橋接）。
  拆解規則已收歸 **`src/lib/pos/sync-order-payload.ts`**（附迴歸測試）——**唔准喺 route 內自己再寫一份**，
  2026-09-16 就係因為兩處規則唔一致而令 6 張線上單嘅 ORDER_CREATED 永久 400（`{order}` 形狀）。
- 🔴 **`storeId` 係公開值**（枱 QR `/menu?tableId=…&store=<merchantId>`）⇒ kiosk 綁店（`/order` 手動輸入 storeId）＝**無密碼落單入口**。
- 🔴 **Vercel log 匯出 CSV 冇 IP 欄**；而且**一個請求出多行**（每 `console.log` 一行）⇒ 行數唔等於請求數。時間 filter 要問清時區（用戶講「7:40」可能係 UTC−4）。
  要 IP 靠 `sync/route.ts:375` 嗰句 `console.info(ip=…)`，佢**只在 auth 開著時才執行**。
- 🔴 **「按放棄又彈返」**＝`sync-flush.ts:558-560` legacy-heal 分支（每次 reload 行一次）**只排除 `failed`、唔排除 `skipped`**。
- **關「自助點餐機」模組擋唔住任何嘢**：`allowedModules` 純 UI 導覽，`/order` 同 `/api/pos/sync` 都唔檢查，且要逐部終端重新登入。
