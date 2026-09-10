# 專案記憶索引（macauPos / macauPosSystem）

> ⚠️ 有注入上限（超咗靜默截斷尾段）。**詳細「坑」總表一律查 [`docs/113-agent-gotchas.md`](../docs/113-agent-gotchas.md)**（改動前必讀）；工作日誌 `.workbuddy/memory/YYYY-MM-DD.md`。
> 維護：新「坑」先寫入 docs/113，**只有最高頻嘅**才摘要上嚟；本檔嚴格 ≤ 3k 字元。

## 改動前必查
- **`:key` remount ≠ 自動刷新**：報表 `dataReady` 會歸 false → 全頁閃 skeleton。自動刷新要用 `refreshToken` 加落 fetch effect 依賴。
- **`normalizePosLocalSettings` 係白名單重建** → 加欄唔加白名單 = 靜靜剷走（中過：`qrUrl`/`paperSize`/`shiftPresets`）。
- **掃碼雙模式（docs/115）**：`/menu?tableId=`（堂食每枱一碼）/ `/quick?store=`（快餐全店一碼）link 完全區隔；`/menu` 冇 tableId **唔可以**當快餐落單。真源 `scan_mode`，**由登入驅動**：設定頁唯讀（唯一寫入點 `login-screen.tsx`，要喺 `saveAuthSession()` 後、導航前 `await`）；`kiosk`/`salon` → **唔寫**（兩機互覆）。
- **快餐掃碼用店內 `pickup` 序號**（台名「自取」做單號＝全店同號），**唔 resume**（每單獨立）；離線用 `quickScanOfflineOrderNo()`（`自取-K7Q2`），**唔可以**用 `nextLocalDailyOrderNo()`。
- **`saveKioskSettings(storeId, patch, headers?)`**（唔再係 boolean）；`/api/pos/kiosk-settings` POST 係 **read-then-merge** + 42703 降級。**「未經授權：需要 POS 終端憑證。」＝ client 冇帶／冇續期 token，唔係權限問題**：`posDeviceAuthHeaders()` 只讀唔續期（TTL 12h）→ 一律用 `posDeviceAuthHeadersFresh()`。（docs/113）
- **`EscPosTemplateSnapshot.cols` 係跨 repo 唯一真源** → 唔好再各自判 `paperSize`。
- **`ORDER_UPDATED` 必須送 `{ order, addedItems }`**（唔係裸 order），否則 server 拒單、收銀端零反應。
- **`/api/pos/sync` 失敗分類**：業務拒絕 → 4xx `retryable:false`；基建失敗 → 500 `retryable:true`。**唔可以**任何 `ack(false)` 都回 500（變**假成功**）。
- **`nextLocalDailyOrderNo` 只可喺真正派新號時叫**（改單都叫會白燒號 → 撞號）。
- **台號查詢只認 `source="scan"`** → 放寬前先改收銀端「加單補印廚房單」閘，否則**廚房靜默漏單**。
- **`isOrderAcked` 有 TTL**：守護傳 10 分鐘、健康燈**唔可以**傳（會每 10 分鐘閃「N 張待傳」）。
- **iPad 分頁唔會自動換 JS** → 「明明修好但仲唔同步」第一步叫用戶**強制 reload**。
- **admin 面板唔可以行 `/api/pos/state`**（要終端憑證 → 選商家即 401）；單店都要 `adminOrderFetcher({ storeId })` 走 `/api/admin/orders`。
- **分格線唔可以靠「繼承上一行」**：印線前必須清 `GS !`/`ESC !`/`FS !` 放大殘留，dash = `dividerDashCount(size, cols)`（`m`/`l` 減半）→ 永遠一行；`divider` 預設 `s`。「廚房單正常、收據唔正常」多數唔係兩個 renderer 唔同 → 睇「線前面嗰行係乜 size」。（docs/114）
- **持續型提示唔可以照抄 `setToast`**（2.6s 自動清）；要 store-scope localStorage + 只喺 realtime `onOrderUpsert` 由 `isNewSelfOrder` 觸發（**唔可以寫死 `source==="scan"`**）；位置 `top-20`（`top-4` 撞工具列）、容器 `pointer-events-none`；標識「有真枱→台名；counter→單號」。（docs/113）

## 硬性口徑（唔可以改）
- 收入認列 `isSaleCountable(o)`：只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`。
- 日期一律 Macau 邊界 ISO（`ledger/report-period.ts`），禁 UTC-naive 86400000。
- 雲端讀到 = 唯一可信源；雲端空 + 成功 = 空狀態，**唔 fallback 本機**（`debugInfo.dataSource` 會標示）。
- store 隔離：讀 strict `o.storeId === merchantId`；`merchantId` 缺失一律唔拉（寧空白唔跨店）。
- 報表 `dataReady = backfillDone && ledgerDone`；admin `loadOnlineByHour` early return **必須** setLedgerDone(true)。
- 取消線上單一律打 RPC `merchant_resolve_order_change`，**唔可以**用 `update_order_status('cancelled')`。
- 同步邊界：自動化**只推商家已做嘅事**，兩邊終態唔一致 → 標 `conflict` 交人。

## 命令
- `npm run typecheck` / `npm run test`（`node --test`；**測試 import 一定要相對路徑 + `.ts`**，`@/` alias 會 `ERR_MODULE_NOT_FOUND`）。
- 本機 `next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 並喺沙箱外跑。
- 環境見 AGENTS.md（Node 22.22.2-2、Python 3.13.12、Next.js 16.3.0 + Turbopack + Tailwind 4）。
