# 專案記憶索引（macauPos / macauPosSystem）

> ⚠️ 本檔有注入上限（超咗會靜默截斷尾段）。**詳細版一律查 [`docs/113-agent-gotchas.md`](../docs/113-agent-gotchas.md)**（完整「坑」總表，改動前必讀）。
> 工作日誌：`.workbuddy/memory/YYYY-MM-DD.md`。本檔只放「一睇就要記住」嘅最高頻規則。
> 維護：新「坑」先寫入 `docs/113-agent-gotchas.md`，**只有最高頻嘅**才摘要上嚟；本檔嚴格保持 ≤ 3k 字元。

## 改動前必查
- **`:key` remount ≠ 自動刷新**：報表 `dataReady` 會歸 false → 全頁閃 skeleton。自動刷新要用 `refreshToken` 加落 fetch effect 依賴。
- **`normalizePosLocalSettings` 係白名單重建** → 加欄唔加白名單 = 靜靜剷走（中過：`qrUrl`/`qrSize`/`paperSize`/`shiftPresets`）。
- **掃碼雙模式（docs/115）**：`/menu?tableId=`（堂食，每枱一碼）同 `/quick?store=`（快餐，全店一碼）**兩條 link 完全區隔**；`/menu` 冇 tableId **唔可以**當快餐落單。模式真源 `pos_kiosk_settings.scan_mode`（店級互斥），正規化一律 `normalizeScanMode()` → 未知值 = `dine_in`。
- **快餐掃碼一定要攞店內 `pickup` 序號**（寫台名「自取」做單號 = 全店同號，廚房/收銀分唔清），而且**唔 resume**（每單獨立）；離線用 `quickScanOfflineOrderNo()`（`自取-K7Q2`），**唔可以**用 `nextLocalDailyOrderNo()`（客人手機同收銀機必撞）。
- **`saveKioskSettings(storeId, patch)`**（唔再係 boolean）；`/api/pos/kiosk-settings` POST 係 **read-then-merge**（只覆寫有帶嘅欄位，否則會洗走另一個），並對 42703 降級。
- **`EscPosTemplateSnapshot.cols` 係跨 repo 唯一真源** → 唔好再各自判 `paperSize`。
- **`ORDER_UPDATED` 必須送 `{ order, addedItems }`**（唔係裸 order），否則 server 拒單、收銀端零反應。
- **`/api/pos/sync` 失敗分類**：業務拒絕 → 4xx + `retryable:false`；基建失敗 → 500 + `retryable:true`。**唔可以**任何 `ack(false)` 都回 500（會變**假成功**）。
- **`nextLocalDailyOrderNo` 只可喺真正派新號時叫**（改單都叫會白燒號 → 撞號）。
- **台號查詢只認 `source="scan"`** → 放寬前先改收銀端「加單補印廚房單」閘，否則**廚房靜默漏單**。
- **`isOrderAcked` 有 TTL**：守護傳 10 分鐘、健康燈**唔可以**傳（會每 10 分鐘閃「N 張待傳」）。
- **iPad 分頁唔會自動換 JS** → 「明明修好但仲唔同步」第一步叫用戶**強制 reload**。
- **admin 面板唔可以行 `/api/pos/state`**（要 POS 終端憑證 → 選商家即 401）；單店都要傳 `adminOrderFetcher({ storeId })` 走 `/api/admin/orders`。
- **分格線唔可以靠「繼承上一行」**：印線前必須清 `GS !`/`ESC !`/`FS !` 放大殘留，dash 數量 = `dividerDashCount(size, cols)`（`m`/`l` 減半）→ 永遠一行；`divider` 預設 `s`。（docs/114）
- **「廚房單正常、收據唔正常」多數唔係兩個 renderer 唔同** → 睇「線前面嗰行係乜 size」。
- **持續型提示唔可以照抄 `setToast`**（2.6s 自動清）；要 store-scope localStorage + 只喺 realtime `onOrderUpsert` 由 `isNewSelfOrder && source==="scan"` 觸發（backfill 會令已滑走嘅提示復活）。位置要 `top-20`（`top-4` 撞桌台總覽工具列）、容器 `pointer-events-none`。（docs/113）

## 硬性口徑（唔可以改）
- 收入認列 `isSaleCountable(o)`：只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`。
- 日期一律 Macau 邊界 ISO（`ledger/report-period.ts`），禁 UTC-naive 86400000。
- 雲端讀到 = 唯一可信源；雲端空 + 成功 = 空狀態，**唔 fallback 本機**（`debugInfo.dataSource` 會標示）。
- store 隔離：讀 strict `o.storeId === merchantId`；`merchantId` 缺失一律唔拉（寧空白唔跨店）。
- 報表 `dataReady = backfillDone && ledgerDone`；admin `loadOnlineByHour` early return **必須** setLedgerDone(true)。
- 取消線上單一律打 RPC `merchant_resolve_order_change`，**唔可以**用 `update_order_status('cancelled')`。
- 同步邊界：自動化**只推商家已做嘅事**，兩邊終態唔一致 → 標 `conflict` 交人。

## 命令
- `npm run typecheck` ／ `npm run test`（`node --test`；**測試檔內 import 一定要相對路徑 + `.ts`**，`@/` alias 會 `ERR_MODULE_NOT_FOUND`）。
- 本機 `next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 並喺沙箱外跑。
- 環境：Node 22.22.2-2、Python 3.13.12（managed）；Next.js 16.3.0 + Turbopack + Tailwind 4（見 AGENTS.md）。
