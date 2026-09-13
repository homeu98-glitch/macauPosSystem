# 專案記憶索引（macauPos / macauPosSystem）

> ⚠️ 注入上限 **3k 字元**，超咗會**靜默截斷**。呢度只放最高頻紅線。
> 詳細坑總表 → [`docs/113-agent-gotchas.md`](../docs/113-agent-gotchas.md)（**改動前必讀**）。

## 一、改動前必查
- 🔴 建單／接單後必須 `appendPrintJobsWithSync()`；`RelayTransport.send()` 係 no-op → 淨 `savePrintJobs()` ＝零出紙＋零紅標。
- 🔴 出紙「改咗代碼但行為唔變」＝出紙程式冇 re-build／冇擰 `versionCode`（4 份：print-relay APK／print hub／print-agent-android／desktop-companion）。
- 🔴 **列枱／選枱**一律用 `buildDisplayFloors(bootstrapTables, localSettings.floors)`，唔可以只讀 `localSettings.floors`（同坑中過兩次）。
- 🔴 **Ledger 線上單**資料一律用「防禦式多欄名」解析（RPC 欄名從未確認）；建 `OrderItem` 唯一入口 = `mapDetailToOrderItems()`。規格／備註已補（2026-09-13）。
- 🔴 `git` 一律 `CODEBUDDY_SAFE_DELETE_ENABLED=0 git …`；`.git` 散咗**先 fetch、唔好 rebuild**（見 git-repo-rescue skill）。
- 🔴 加 `PosLocalSettings` 新欄一律**必填** → tsc 逼你補 `normalizePosLocalSettings`（storage.ts）＋`defaultPosLocalSettings`（mock-data.ts）。漏白名單 = reload 靜靜剷走。

## 二、環境（呢部機）
- ⚠️ `npm`／`npx` 經 git-bash **跑唔到**；git-bash **冇 coreutils**（ls/grep/sed/head/tail 全無）。
  → 用 `node node_modules/typescript/bin/tsc --noEmit`、`node --test`、`node node_modules/eslint/bin/eslint.js`；檔案操作靠 `Read`/`Glob`/`Grep`/`node -e`。
- ⚠️ `node --test` 只可載入**零 runtime 依賴**嘅純模組；import 用相對路徑＋`.ts`（`@/` 會 ERR_MODULE_NOT_FOUND）。
- ⚠️ 本機**冇** `.env.local`、冇 supabase CLI → migration 要人手喺 Supabase SQL Editor 跑。
- ⚠️ 可能有另一個 session 同時改同一 repo → `tsc` 偶發語法錯誤，**重跑再判斷**。
- ⚠️ 既有 ~34 個 lint error（唔係回歸）。`next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。

## 三、核心口徑
- 收入認列 `isSaleCountable(o)`：只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`。
- 日期一律 Macau 邊界 ISO（`ledger/report-period.ts`）。
- 雲端讀到＝唯一可信源；雲端空＋成功＝空狀態，唔 fallback 本機。
- store 隔離 strict `o.storeId === merchantId`；缺失一律唔拉。
- 快餐單全靠 `isQuickCounterOrder`（`!onlineOrderId && tableId==="counter"`）隔離，堂食唔受影響。
- 線上堂食：隔離閘 `isOnlineDineInOrder`／可結帳 `isSettleableOrder`（**四個入口都要改**）；`canCancelSettle()` **唔跟住放寬**。
- `ORDER_UPDATED` 送 `{ order, addedItems? }`；`/api/pos/sync`：業務拒絕 4xx `retryable:false`／基建 500 `retryable:true`。
- 報表 KPI 固定 `grid-cols-5`；合併 grid 必須刪中間 `</div>`（JSX 仍平衡 → build 捉唔到）。
- admin 面板唔可以行 `/api/pos/state` → `adminOrderFetcher()`；取消線上單一律 RPC `merchant_resolve_order_change`。
- 快餐／Kiosk 打印機真源 `pos_kiosk_settings`；`resolveJobPrinter()` 必須合併 kiosk 機。

## 四、主題索引（詳情見 docs/113 同名章節）
| 主題 | 首要紅線 |
|---|---|
| 三端架構／Electron 打包 | desktop/Android 載**同一 Vercel 網址** → 網頁更新唔使重打包；只有列印通道要三端同步。打包必加 `--config.win.signAndEditExecutable=false`（否則靜默掛起 12 分鐘） |
| React 依賴 | 父傳子嘅物件／函式 prop **一定** stable identity（`useMemo`／`useCallback`），否則無限 re-render、整個 tab 撳唔到（tsc/eslint/test 全綠，捉唔到） |
| 打印區塊 | 加「靜態文字區塊」＝零跨 repo 改動；改區塊語義／加逐項欄位才要四端同步＋擰 `versionCode` |
| 標籤機 | 型號按族過濾 `getLanModelOptions(family)`；用肯定式 `role === "zone"`（`!== "receipt"` 係危險否定式）；`USB_PRINTER_DB` 兩份硬編要同步 |
| 登入／工作台 | `allowedModules` **缺失＝全部開通**（唔係全閂）；新模組先改 `module-catalog.ts`；副作用只有 `apply-workbench.ts` |
| Realtime | 「reload 先見到」＝訂錯 Supabase 專案（要 `NEXT_PUBLIC_POS_SUPABASE_URL/_ANON_KEY` ＋ redeploy） |
| Ledger 契約 | `docs/integration/ledger-client-api.md` §5.4（欄名要防禦式解析） |
