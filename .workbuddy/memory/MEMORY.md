# 專案記憶索引（macauPos / macauPosSystem）

> ⚠️ 有注入上限（超咗靜默截斷）。**詳細「坑」總表查 [`docs/113-agent-gotchas.md`](../docs/113-agent-gotchas.md)**（改動前必讀）；日誌 `.workbuddy/memory/YYYY-MM-DD.md`。
> 維護：新「坑」先寫 docs/113，**只有最高頻**才摘要上嚟；本檔 ≤ 3k 字元。

## 改動前必查
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
- **🔴「reload 先見到」＝ Realtime 冇推送**：server 寫單用 `SUPABASE_URL`（POS 專案），瀏覽器訂閱用 `NEXT_PUBLIC_SUPABASE_URL`（**Ledger 專案，冇 `pos_*` 表**）→ 訂唔存在嘅表 Supabase **唔會報錯**（照 `SUBSCRIBED`）。修：加 `NEXT_PUBLIC_POS_SUPABASE_URL`/`_ANON_KEY`（**必須 redeploy**）。健康只可靠一次性 REST 探測 `pos_orders`（`PGRST205`）；**唔可以**靠 channel status；錯 key（401）**唔可以**報成「表存在但被拒」（未認證根本冇查表，先 `bad_key` 後 `unauthorized`）。自檢 `tools/2026-09-11-check-pos-realtime.mjs --watch 20`。
- **持續型提示唔可以照抄 `setToast`**；要 store-scope localStorage + 只喺 realtime `onOrderUpsert` 由 `isNewSelfOrder` 觸發（**唔可以寫死 `source==="scan"`**）；位置 `top-20`。**撳提示一律留在點餐頁面**（`tableId==="counter"` → 高亮卡片，唔跳頁）；`focusKey` 必須用**遞增序號**（`Object.is` → boolean 連撳兩次唔重跑 effect）。

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
- 環境見 AGENTS.md（Node 22.22.2-2、Next.js 16.3.0 + Turbopack + Tailwind 4）。
