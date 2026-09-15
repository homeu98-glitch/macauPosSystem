# macauPos 記憶索引

> 上限 3k。必讀 `docs/113-agent-gotchas.md`。

## 一、API 鑑權
- 🔴 44/57 route 曾無鑑權、**冇 `middleware.ts`**；server client 用 service_role **繞 RLS** ⇒ 無鑑權＝裸奔 DB。
- 加閘用 `posRouteAuthGuard(request, storeId, tag)`，**放喺「未配置 Supabase／缺 storeId」early-return 之後**；客戶端一律 `posDeviceAuthHeadersFresh()`。
- **匿名端點唔可以加閘**：bootstrap GET、sequence、sync 匿名通道、ledger/member-login、order-lookup、kds/*。
- 🔴 **`POS_REQUIRE_DEVICE_AUTH` 冇設 ＝ 閘照樣開著**（`isPosDeviceAuthRequired()` 空值回 `true`，fail closed）。**「冇設」≠「關閉」**——極易中招。
- 🔴 簽名密鑰 `resolveSecret()` 三段 fallback：`POS_DEVICE_TOKEN_SECRET` → `ADMIN_SESSION_SECRET` → `SUPABASE_SERVICE_ROLE_KEY/_KEY`。⇒ **冇設 `POS_DEVICE_TOKEN_SECRET` 唔會壞**（借 service role key 簽得到）。但換 service role key 會令全部 token 一齊失效。
- 🔴 判「簽發能力是否健康」＝打 `POST /api/pos/device-token`；回 **503「系統未設定終端憑證密鑰」＝真缺 secret**；回 401「Ledger 會話已失效」＝secret 鏈正常。
- Token TTL **12h**，續期走 `POST /api/pos/device-token`（用 Ledger access token 換）。`print-agent/pair` 只由 APK 呼叫 → 唔可以硬加閘。

## 二、DB
- POS = `iyrywzormzisyppkokbi`、Ledger = `zymdemjflsckicwcinxl`（`.supabase.co`）。
- **已跑**：0016、0021、0041 §1。**未跑**：**0042**、`0040 §2/§7` 可選。
- 🔴 migration **唔可以用 psql 專屬語法**（`:'var'`/`\set`）—— SQL Editor 唔支援（0040 實案 `42601`）。要 PL/pgSQL 變數 + 守衛。
- 🔴 `pos_orders`/`pos_print_jobs` anon policy **冇 store_id 過濾**。**唔可以就咁加**：收銀台/KDS/Hub 全用 anon key 訂 Realtime → 加咗**靜默收唔到事件**；根治要 per-store token（0041 §3）。

## 三、打印
- 🔴 建單/接單後必須 `appendPrintJobsWithSync()`；淨 `savePrintJobs()`＝**零出紙＋零紅標**。
- 🔴 出紙只喺**內容事件**（新單/改單/加菜/結帳）；轉換/採納/排位**唔出紙**。去重靠 `job.orderId`。
- 🔴 「改咗但行為唔變」＝① 冇 re-build／冇擰 `versionCode`（4 份）② 收銀機載 **Vercel 部署**。
- `PrintJob` 必帶 `kind`。`ttl` = **絕對 epoch ms**；`/api/pos/sync` 落章，**只喺 insert 寫** ⇒ 舊行恆 NULL＝永不過期。
- 🔴 `0042`（未跑）= claim **分段式**：**同機 6min／跨機 90s**（純 90s 會令中繼機搶返自己長單 → **重複出紙**）＋ `finished_at is null`。
- 「重試打印」走 **`POST /api/pos/print-jobs/retry`**（冪等；已成功回 409）。失敗原因唯一用 `print-job-failure.ts` 6 碼。### 中繼配對（易錯位，實測沉澱）
- 🔴 `paired:true` 只係「`pos_print_agents` 有行」＝**歷史事實**，唔等於機活著（Web 綠＋App 死可同時成立）。
- 🔴 **反向**：中繼機 render 得出狀態文字＝ **APK 活著**。**「POS 雲端未設定」唔喺 APK 源碼**（APK 只出「欠 supabaseUrl / anonKey，用 30s 輪詢兜底」＋Toast「配對失敗，請檢查網絡或店舖 ID 是否正確」）⇒ 見到要去 **iPad 側**揾。
- 🔴 `pair-status` 401 → panel 顯示「配對失敗」→ **配對流程自己停擺**。401 正解＝**iPad 重新登入**，唔係搞商米。`GET /pair?agentId=<假>` 恆回 `pending` ⇒ 證明唔到 env 有無值。
- 🔴 徽章綠（localStorage 有 `pairing`）同紅塊（`state.kind==="failed"`）係**兩個獨立 state**，可同時出現 ⇒「網站正常」可能只睇咗徽章。`macau-pos-relay-auto-pair-stopped` 落 localStorage 後 **reload 都唔自動重配**。
- **判機死活**＝有無 `claimed_by` 非 NULL 行；`attempts=0` 全 NULL＝從來冇 claim。硬件＝`attempts>0`+`AGENT_FAILED`。
- **唔靠 secret 探測**：線上 bundle 抽 `eyJ…` → base64 中段 `ref` 認專案 → 唯讀打 PostgREST。**判線上部署版本**＝掃 bundle 特定字串（無 `androidReady` ⇒ 未部署）。
- 「最後心跳 N 分鐘前」**只在 `/prints` 紅 banner、且要有未完成任務才 render**；**收銀台 `/` 睇唔到**。
- `resolveRelayRealtimeConfig()` = `/pair` 同 `/pair-status` 共用判準；**唔准 fallback `NEXT_PUBLIC_SUPABASE_URL`（= Ledger，冇 `pos_*`）**。`sendJoin()` 只認 `phx_reply` → 訂錯專案照樣「已連線」。

## 四、訂單
- 🔴 結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱），唔准全店 `find()`。
- 🔴 已收款單加菜**必須保留 `paid`**，否則雲端拒收整條 `ORDER_UPDATED`（items 上唔到雲）。
- 🔴 「RPC 冇拋錯」≠ 遠端已改：爬梯（`online-dinein-ladder.ts`）無效轉換跳過 → 走完唔代表 `completed`。
- 狀態文案唯一：只有 `pickup`/`takeaway`＝「待取餐」，其餘「待交付」（`order-mapper.ledgerStatusLabel()`）。
- 列枱用 `buildDisplayFloors(bootstrapTables, localSettings.floors)`。Ledger 真欄 `selected_specs`/`line_note`。

## 五、UI
- 🔴 `button { font: inherit }`（globals.css **無 layer**）壓過 `text-*` ⇒ **按鈕字級寫喺仔元素**；`p-[3px]` 同 `px-3 py-1.5` **唔可以並存**。
- 🔴 iPad standalone 撳輸入欄**唔彈鍵盤**。`print-center.tsx` 有 16 個**既有** eslint error ⇒ lint 本來紅。

## 六、環境
- ⚠️ `npm`/`npx` 跑唔到；**冇 coreutils** → 用 Read/Glob/Grep 或 node fs。複雜 JS 寫 `.cjs`。
- ⚠️ git 全路徑 `…/PortableGit/versions/1.2.0/cmd/git.exe`；push 加 `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never`。
- ⚠️ `node --test` 只可載零依賴純模組。migration 人手跑。可能**另一 session 同改 repo**。
- ⚠️ `.git` 易被沙箱破壞（9/01、9/11、9/16）。症狀＝`fatal: not a git repository`；**缺 `refs/` 乜都做唔到**。修法見 skill `git-repo-rescue`。
- 🔴 **Vercel 改 env 唔會自動套用到現有 deployment，一定要 Redeploy。**

## 七、口徑
- 收入認列 `isSaleCountable()`：只計 `settled`／帶 `onlineOrderId` 嘅 `paid`。日期用 Macau 邊界。
- 雲端讀到＝唯一可信源；雲端空＋成功＝空狀態，唔 fallback 本機。store 隔離 `o.storeId === merchantId`。
- 快餐單 `isQuickCounterOrder`；線上堂食 `isOnlineDineInOrder`（**唔可以改闊**）／`isPaidDineInOrder`。
- 線上接單＝Ledger `merchant_enabled`／線下接單＝`pos_store_status.is_open`，**唔准同名同色**；閘 `/api/pos/sync` §2.55。
- 🔴 **時間軸一律換算 Macau(+8)**：GitHub commit 係 UTC，`16:05Z`＝澳門**翌日 00:05**。
