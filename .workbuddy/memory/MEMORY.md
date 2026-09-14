# 專案記憶索引（macauPos / macauPosSystem）

> ⚠️ 上限 **3k 字元**，超咗**靜默截斷**。只放最高頻紅線。
> 詳細坑總表 → [`docs/113-agent-gotchas.md`](../docs/113-agent-gotchas.md)（**改動前必讀**）。

## 一、改動前必查
- 🔴 建單／接單後必須 `appendPrintJobsWithSync()`；`RelayTransport.send()` 係 no-op → 淨 `savePrintJobs()` ＝零出紙＋零紅標。
- 🔴 「改咗代碼但行為唔變」＝① 出紙程式冇 re-build／冇擰 `versionCode`（4 份：relay／hub／android／companion）② 收銀機／desktop 載 **Vercel 部署** → 本機改完要 **deploy** 先生效。
- 🔴 **列枱／選枱**一律用 `buildDisplayFloors(bootstrapTables, localSettings.floors)`。
- 🔴 **Ledger 線上單**真欄名：`selected_specs`／`product_id`／`line_note`（防禦式解析）。建 `OrderItem` 唯一入口 = `mapDetailToOrderItems()`。
- 🔴 `resolveLedgerPosOrderForReceipt()` 唔可以無條件短路：有 `detail` 一定重建，但要保留本機 `status`／`prepaidAmount`。
- 🔴 `PrintJob` 必帶 `kind`；冇 `template` 時兜底渲染按 kind 分流。
- 🔴 `git` 唔喺 PATH → 全路徑 `…/PortableGit/versions/1.2.0/cmd/git.exe`；**push 加 `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never`**（唔加＝無聲掛住等憑證窗）。
- 🔴 加 `PosLocalSettings` 新欄**必填** → tsc 逼你補 `normalizePosLocalSettings`＋`defaultPosLocalSettings`。
- 🔴 已收款單（快餐 counter／排位單／**掃碼已付單**）加菜**必須保留 `paid`**；打返 `sent_to_kitchen` → 雲端 `paid-downgrade` 拒收整條 `ORDER_UPDATED` → **items 上唔到雲**（只剩金額 patch）→ 收據「1 項 $75、總額 160」。docs/113 §(3b)。
- 🔴 結帳／免單／完成訂單嘅目標單一律 `resolveSettleTargetOrder()`（明確 id → 當前工作台 → **只限當前枱**），**唔准**全店 `orders.find()`（實案：A03 結帳去咗第二張枱）。「可結帳」=`isSettleableOrder()`（`paid`＋真枱，**唔要求** `onlineOrderId`）；桌台標籤同入口共用同一 predicate。
- 🔴 **「RPC 冇拋錯」≠ 遠端狀態已改**：排位爬梯嘅無效轉換一律跳過 → 走完唔代表到咗 `completed`（已取消單都報成功）⇒ 要驗證（讀返狀態）或遠端親口回成功。⚠️ `invalid transition` 被 `mapRpcErrorMessage` **譯成中文**「目前狀態不可執行此操作。」，判定要同時認中文。爬梯口徑 = `lib/pos/online-dinein-ladder.ts`；兩個入口都要檢查 `ledgerProgress`。docs/113 §(3b)(3c)。
- 🔴 狀態文案口徑唯一：**只有自取**（`pickup`／`takeaway`）= 「待取餐」，其餘（堂食／外賣／外送）= 「待交付」。真源 = `order-mapper.ledgerStatusLabel()`，唔准各處自創。
- 🔴 兩個「營業中」唔准撈埋：`merchant_enabled`（Ledger，= **線上接單**，只擋會員通）vs `pos_store_status.is_open`（POS DB 0039，= **店內營業**，擋掃碼／kiosk）。權威閘 = `/api/pos/sync` §2.55（只擋匿名，收銀台逃生門）；兩邊**一律 fail-open**（讀唔到＝營業中）；客端 gating **必須**加「未落單」條件（否則蓋走扣款結果）。`MerchantOpenPill` 預設確認文案寫死「堂食唔受影響」→ 新開關要自己傳 `confirmMessage`。

## 二、環境（呢部機）
- ⚠️ `npm`／`npx` 經 git-bash **跑唔到**；**冇 coreutils** → 用 `node node_modules/{typescript/bin/tsc,eslint/bin/eslint.js}`＋`node --test`；檔案操作用 Read/Glob/Grep。
- ⚠️ `node --test` 只可載入**零 runtime 依賴**純模組；import 要相對路徑＋`.ts`（`@/` 會爆）。
- ⚠️ 本機**冇** `.env.local`、冇 supabase CLI → migration 要人手喺 Supabase SQL Editor 跑。
- ⚠️ 可能有另一 session 同改同一 repo → `tsc` 偶發語法錯誤，重跑再判斷。

## 三、核心口徑
- 收入認列 `isSaleCountable(o)`：只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`。
- 日期一律 Macau 邊界 ISO（`ledger/report-period.ts`）。
- 雲端讀到＝唯一可信源；雲端空＋成功＝空狀態，唔 fallback 本機。
- store 隔離 strict `o.storeId === merchantId`；缺失一律唔拉。
- 快餐單隔離靠 `isQuickCounterOrder`（`!onlineOrderId && tableId==="counter"`）。
- 線上堂食：隔離閘 `isOnlineDineInOrder`（只認 `onlineOrderId`，**唔可以**改闊 —— 佢同時管推 Ledger 狀態）；可結帳／桌台標籤用 `isPaidDineInOrder`。
- 報表 KPI 固定 `grid-cols-5`；合併 grid 必須刪中間 `</div>`。
- admin 面板唔可以行 `/api/pos/state` → `adminOrderFetcher()`；取消線上單一律 RPC `merchant_resolve_order_change`。
- 快餐／Kiosk 打印機真源 `pos_kiosk_settings`；`resolveJobPrinter()` 必須合併 kiosk 機。

## 四、主題索引（詳情見 docs/113 同名章節）
| 主題 | 首要紅線 |
|---|---|
| 三端架構／打包 | desktop/Android 載**同一 Vercel 網址**；打包必加 `--config.win.signAndEditExecutable=false` |
| React 依賴 | 父傳子物件／函式 prop **一定** stable identity，否則無限 re-render、整個 tab 撳唔到 |
| 標籤機 | 型號按族過濾 `getLanModelOptions(family)`；`USB_PRINTER_DB` 兩份要同步 |
| 打印機設定 UI | 品牌分組 `groupModelsByBrand()`。🔴 篩選狀態三入口必 reset（漏＝清單空白無 error） |
| 登入／工作台 | `allowedModules` **缺失＝全部開通**；新模組先改 `module-catalog.ts` |
| Realtime | 「reload 先見到」＝訂錯 Supabase 專案（`NEXT_PUBLIC_POS_SUPABASE_URL/_ANON_KEY`） |
| Ledger 契約 | `docs/integration/ledger-client-api.md` §5.4（欄名防禦式解析） |
| 預約單 | `scheduled_pickup_at` → `LedgerOnlineOrder.scheduledPickupAt` → `PosOrder.scheduledPickupAt`。判定／「快到‧逾時」**只准**用 `lib/pos/scheduled-pickup.ts`；UI 用 `components/scheduled-pickup-badge.tsx`；紙本 `scheduled_pickup` 係**靜態文字區塊**（唔使改下游三端、唔使擰 versionCode） |
