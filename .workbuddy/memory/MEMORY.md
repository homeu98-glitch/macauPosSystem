# macauPos 記憶索引

> 上限 3k。必讀 `docs/113-agent-gotchas.md`。

## 一、API 鑑權
- 🔴 44/57 route 曾無鑑權、**冇 `middleware.ts`**；server client 用 service_role **繞 RLS** ⇒ 無鑑權＝裸奔 DB。
- 加閘用 `posRouteAuthGuard(request, storeId, tag)`，**放喺「未配置 Supabase／缺 storeId」early-return 之後**；客戶端一律 `posDeviceAuthHeadersFresh()`。
- **匿名端點唔可以加閘**：bootstrap GET、sequence、sync 匿名通道、ledger/member-login、order-lookup、kds/*。
- 回滾掣 `POS_REQUIRE_DEVICE_AUTH=0`（要 redeploy）。`print-agent/pair` 只由 APK 呼叫 → 唔可以硬加閘。

## 二、DB
- POS = `iyrywzormzisyppkokbi`、Ledger = `zymdemjflsckicwcinxl`（`.supabase.co`）。
- **已跑**：0016、0021、0041 §1。**未跑**：**0042**（P2 分段式 claim）。`0040 §2/§7` 可選。
- 🔴 migration **唔可以用 psql 專屬語法**（`:'var'`/`\set`）—— SQL Editor 唔支援（0040 實案 `42601`）。要 PL/pgSQL 變數 + 守衛。
- 🔴 `pos_orders`/`pos_print_jobs` anon policy **冇 store_id 過濾**。**唔可以就咁加**：收銀台/KDS/Hub 全用 anon key 訂 Realtime → 加咗**靜默收唔到事件**；根治要 per-store token（0041 §3）。

## 三、打印
- 🔴 建單/接單後必須 `appendPrintJobsWithSync()`；淨 `savePrintJobs()`＝**零出紙＋零紅標**。
- 🔴 出紙只喺**內容事件**（新單/改單/加菜/結帳）；轉換/採納/排位**唔出紙**。去重靠 `job.orderId`。
- 🔴 「改咗但行為唔變」＝① 冇 re-build／冇擰 `versionCode`（4 份）② 收銀機載 **Vercel 部署**。
- 🔴 `PrintJob` 必帶 `kind`。`ttl` = **絕對 epoch ms 期限**；**P1 已由 `/api/pos/sync` 落章**（min(建單+12h, 當日 23:59)，**只喺 insert 寫**）。
- 🔴 `0042`（未跑）= claim **分段式**：**同機 6min／跨機 90s**（純 90s 會令中繼機搶返自己長單 → **重複出紙**；關鍵 `claimed_by <> p_agent_id`）＋ `finished_at is null` 守衛。
- 🔴 「重試打印」以前只改本機（假報成功、零出紙）→ 現走 **`POST /api/pos/print-jobs/retry`**（冪等；已成功回 409）。
- 🔴 失敗原因唯一用 `print-job-failure.ts` 6 個碼（`TIMEOUT_CLAIM`/`TIMEOUT_STALE`/`VOID_STALE`/`AGENT_FAILED`/`ATTEMPTS_EXHAUSTED`/`UNKNOWN`）。

## 四、訂單
- 🔴 結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱），唔准全店 `find()`。
- 🔴 已收款單加菜**必須保留 `paid`**，否則雲端拒收整條 `ORDER_UPDATED`（items 上唔到雲）。
- 🔴 「RPC 冇拋錯」≠ 遠端已改：爬梯（`online-dinein-ladder.ts`）無效轉換跳過 → 走完唔代表 `completed`。
- 🔴 狀態文案唯一：只有 `pickup`/`takeaway`＝「待取餐」，其餘「待交付」（真源 `order-mapper.ledgerStatusLabel()`）。
- 🔴 列枱用 `buildDisplayFloors(bootstrapTables, localSettings.floors)`。Ledger 真欄 `selected_specs`/`line_note`。

## 五、UI
- 🔴 `button { font: inherit }`（globals.css **無 layer**）壓過 `text-*` ⇒ **按鈕字級寫喺仔元素**；`p-[3px]` 同 `px-3 py-1.5` **唔可以並存**。
- 🔴 iPad standalone 撳輸入欄**唔彈鍵盤**。`print-center.tsx` 有 16 個**既有** eslint error ⇒ lint 本來紅。

## 六、環境
- ⚠️ `npm`/`npx` 跑唔到；**冇 coreutils** → 用 Read/Glob/Grep 或 node fs。複雜 JS 寫 `.cjs`。
- ⚠️ git 全路徑 `…/PortableGit/versions/1.2.0/cmd/git.exe`；push 加 `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never`。
- ⚠️ `node --test` 只可載零依賴純模組。migration 人手跑。可能**另一 session 同改 repo**。UI 回歸 `tools/verify-pos-app-split.cjs`（**要 `localhost`**）。

## 七、口徑
- 收入認列 `isSaleCountable()`：只計 `settled`／帶 `onlineOrderId` 嘅 `paid`。日期用 Macau 邊界。
- 雲端讀到＝唯一可信源；雲端空＋成功＝空狀態，唔 fallback 本機。store 隔離 `o.storeId === merchantId`。
- 快餐單 `isQuickCounterOrder`；線上堂食 `isOnlineDineInOrder`（**唔可以改闊**）／`isPaidDineInOrder`。
- 線上接單＝Ledger `merchant_enabled`／線下接單＝`pos_store_status.is_open`，**唔准同名同色**；閘 `/api/pos/sync` §2.55。
- Realtime「reload 先見到」＝訂錯專案（`NEXT_PUBLIC_POS_SUPABASE_URL/_ANON_KEY`）。
