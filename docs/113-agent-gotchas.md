# 專案「坑」總表（macauPos / macauPosSystem）

> 呢個檔係 `.workbuddy/memory/MEMORY.md` 嘅**完整版**（該檔有注入上限，只留摘要）。
> 由 AI 助手維護：發現新「坑」就加落對應章節；日誌見 `.workbuddy/memory/YYYY-MM-DD.md`。
> 建立：2026-09-10（由 MEMORY.md 拆分）；內容涵蓋 2026-09-04 ～ 2026-09-10。

## 報表（`restaurant-daily-report.tsx`）
- 收入認列 `isSaleCountable(o)`：只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`。有未結帳 → 琥珀提示 + KPI，**唔好改口徑**。
- 菜品排行 key = `menuItemId|單內菜名`，金額用快照 `it.price`。尖峰 `combinedByHour = agg.byHour + onlineByHour`；線上單 cursor 分頁（PAGE=500/MAX=8），拒 `paymentStatus!=="paid"`。
- 防雙計 `posOnlineIds`；`footfallTotal = posFootfall + countableOnlineOrders.length`。`onlineDishKey` 必須喺 `countableOnlineOrders` **之後**宣告（TDZ）。
- 來源 `/api/pos/state?storeId&ordersOnly=1&start&end` 分頁（MAX_PAGES=10）。雲端空 + 成功 = 空狀態，**唔 fallback 本機**。日期一律 Macau 邊界 ISO（`ledger/report-period.ts`），禁 UTC-naive 86400000。結賬時間 = `originalSettledAt ?? updatedAt`。
- **數據來源可見**：`debugInfo.dataSource` ∈ `idle|cloud|cloud-partial|local-fallback|empty` → UI 警示條。任何一頁失敗即 `cloudFailed` → `status:"error"`（「部分成功」以前**靜默出偏少數字**）。
- **自動刷新**：外殼每 3 分鐘 + 回前景即刷（去抖），離線唔刷。⚠️ **唔可以用 `key` remount**（admin「重新載入」嗰套）：remount 令 `dataReady` 歸 false → 11 張卡每 3 分鐘一齊閃 skeleton，兼丟滾動位置／inline edit。改用 `refreshToken` 加落**三條 fetch effect**（backfill / 線上單 / Ledger 彙總）；**唔可以**加落「切店／切範圍重置」effect（會清 orders → 閃）。
- **`dataReady = backfillDone && ledgerDone`**；admin `loadOnlineByHour` early return **必須 setLedgerDone(true)**；切店/切帳號重置。
- ⚠️ **admin 面板一律唔可以行 `/api/pos/state`（2026-09-10 修）**：該 API 自 P0-4 起要求 POS 終端憑證（或 admin token），但 admin 裝置冇 POS 登入 → `posDeviceAuthHeaders()` 係空 → **401**。症狀：admin「營業報表」**一選商家**（單店模式）就彈「POS 訂單：HTTP 401」，而「全部商家」正常。
  - 修法：`admin/reports/page.tsx` 單店分支**都要**傳 `adminOrderFetcher`，`adminOrderFetcher({ storeId })` 帶 `storeId` → 走 `GET /api/admin/orders?storeId=`（service-role + admin token，本身已支援單店）。`allStoresMode` 則**唔帶** `storeId` = 跨店彙總。
  - `/api/pos/state` 嘅 401 係「可以接受 `readAdminSessionFromRequest`」嘅，所以理論上帶 admin token 都通；但 admin 面板走 admin 通道係更一致嘅做法（同「全部商家」同一條 code path）。
  - 順手改善：`!res.ok` 時**讀 response body 嘅 `error`** 再拼落 `lastError`，唔好只出 `HTTP 401`（今次就係因為只見到一句 HTTP 401，白排查一輪，仲誤導去查 admin token／Supabase env）。

## store 隔離（嚴）
- `merchantId = staff_accounts.merchant_id`；DB 用 `store_id`；`useReportMerchantId()` 訂 `pos-auth-changed`。讀 strict `o.storeId === merchantId`，undefined legacy 寧棄；初始 orders 空防 hydration 錯 scope。錯店靠重綁 `macau-pos-kiosk-device`／`?store=`（`60000003` 係真 UUID）。
- `getMerchantReportSummary` 強型別 topup{`topupMop`(=paid+gift)/`topupPaidMop`/`topupGiftMop`}、order{`orderCount`/`orderPaidMop`(=balance+in_store)}。禁 `console.table` Record（TS2769）。admin Ledger 走 `/api/admin/ledger/orders`；會員充值/扣點 RPC 需商戶 JWT → admin 仍空（已知）。

## 單號（2026-09-10 修：同一單號出現兩次）
- 兩個獨立計數器：server `next_daily_sequence`（0022，store/kind/Asia-Macau 日原子）+ 本機 `localDailySeq` fallback。取號失敗／iOS 清 localStorage → fallback 由細號重數 → 撞號（實例 `訂單03` 兩條 row）。
- 純函式拆去 **`src/lib/pos/daily-order-seq.ts`（零 import ＋ 9 個 `node --test` 測試）** —— `storage.ts` 用 `@/` alias，單測加載唔到。`maxUsedDailyOrderSeq` 只係注入 `macauDateKey` 嘅薄包裝。
- 雙閘：①`maxDailySeqFromOrders` 由眼前訂單推下限（只計**同一 Macau 日**；冇時間戳保守計入；前綴精確匹配）；②`computeNextDailySeq = max(本機計數器, 下限) + 1`。
- ⚠️ `nextLocalDailyOrderNo` **只可喺真正派新號時叫**（`pos-app.tsx`：`existingOrder ? "" : ...`）—— 改單都叫會白燒號，令本機計數器跑贏 server → 更易撞。

## 打印模板（詳見 `docs/print-*.md`、`docs/shift-template-*.md`）
- ⚠️ **`normalizePosLocalSettings` 係白名單重建，漏欄即靜靜剷走**（`qrUrl`/`qrSize`、`LabelTemplate.paperSize`、`shiftPresets` 都中過招）→ 加欄必須手動加白名單。
- **`EscPosTemplateSnapshot.cols` 係跨 repo 唯一真源**：POS `buildSnapshot(kind,tpl,cols?)` 計一次；四邊（companion / print hub / print-relay / print-agent-android）一律 `template.cols ?: paperColumns(printer)`，**唔好再各自判 paperSize**。出紙逐打印機計。
- 其他不可改：`EscPosPreview` prop 係 `columns`（**唔係** `paperWidthMm`）；**`if(!text) continue` 唔可以改**（會改埋出紙）；62mm 只係 fallback。店級 0027 四槽 + 0030 第五槽 LWW，**0030 未跑兜底** `isMissingColumnError`(42703) → 只讀寫四舊欄；狀態 `pending`→`sent`→`printed`/`failed`，claim RPC 只揀 pending/failed。

## 線上單取消/改單審核
- Ledger `orders` **無 status 欄**，只有 `change_request_type`('cancel'|'modify'|null) + `_at`/`_by`/`_payload`。申請存在 = 待審。
- 一律打 RPC **`merchant_resolve_order_change`**；**唔可以**用 `update_order_status('cancelled')` 同意取消。pending→直接 cancelled；accepted/preparing→只寫 type='cancel'；ready 後唔可申請。
- approve 取消 → POS 自印作廢單（`printVoidForLedgerOrderOnce` 冪等防 echo 重印）；改單 → 補印廚房單。無 MQTT/輪詢/webhook。

## 掃碼點餐授權 + Kiosk 離線
- repo **無 `middleware.ts`** → **分通道**：有 POS device token / admin token 放行全部事件；**匿名只准** `ORDER_CREATED`/`ORDER_UPDATED` 且 `source ∈ {scan,kiosk}`。QR 已公開 `store=<merchantId>`，驗證 ≠ 授權。
- 憑證 = HMAC-SHA256 無狀態（`pos/pos-device-token.ts`），**TTL 12h**；密鑰 `POS_DEVICE_TOKEN_SECRET` → `ADMIN_SESSION_SECRET` → `SUPABASE_SERVICE_ROLE_KEY`；**fail-closed**，`POS_REQUIRE_DEVICE_AUTH=0` 係應急回滾。
- 續期 `refreshPosDeviceTokenIfNeeded()`（剩 <10min、`inflight` 去重、永不 throw）；`AuthSession.posDeviceToken` **必須**經 `normalizeAuthSession` 帶返。**所有** `/api/pos/state`、`/api/pos/sync` 呼叫點都要先續期再帶 `posDeviceAuthHeaders()`。
- Kiosk 離線隊列 = `pos/kiosk-outbox.ts`（store-scoped，上限 20）；**唔可以重用 `pos/queue-outbox`**（其 flush 靠 `resolveStoreId()`，掃碼客冇 → 永遠推唔出）。客人 resume 用 `GET /api/pos/order-lookup`（單張 + 60/min），**唔好**拉全店 `state`。
- 售罄 `pos_soldout` 只 realtime 增量 → **必須** `fetchStoreSoldoutIds()` 拉初始集合；server 校驗**刻意 fail-open**。⚠️ 但 `pos_soldout` 喺生產兩個 Supabase 專案都唔存在、**全 repo 冇寫入點**（POS 沽清 = 本機 localStorage + `/api/inventory/soldout` TODO stub）→ 客人端售罄**未接通**，要先做「店級售罄上雲」。
- 金額真源 = `lib/kiosk-cart.ts`（純函式）；`computeOrderTotals` 唔四捨五入，用 `money2()`/`toFixed(2)` 收口。`npm run test`（`node --test` 自動探索 `**/*.test.ts`；**測試檔內 import 一定要相對路徑 + `.ts`**，`@/` alias 會 `ERR_MODULE_NOT_FOUND`）；`npm run typecheck`。

## 同步一致性：本地終態 → 雲端（設計 `docs/112-*.md`）
- 症狀：本地 iPad `settled`、雲端仍 `sent_to_kitchen`（`updated_at = created_at`）。七機制：①`ORDER_SETTLED` 要憑證但 `syncNow()` 冇先續期 ②attempts≥5 永久放棄 ③stale/降級回 `ack(true)` = **假成功** ④LWW 用 **client 牆鐘** → NTP 回撥就中（**唔關網絡事**）⑤對賬只在手動開 modal 先跑 ⑥終態只存單機 localStorage ⑦`syncNow([...queue, ev])` 用 stale state → 被 store filter 剔走。
- 口徑：**「靠狀態收斂」唔係「靠事件送達」**。**2026-09-10 17:51 首次生產實證**：重開 APP 後守護自動補推 3 張殭屍單 → admin「未結帳」3 → 1。**驗證守護有冇跑：查 `pos_queue_events.payload->>'action' = 'reconcile_repush'`。**
- 新檔：`sync-acks.ts`（回執帳本 + 健康燈；**刻意唔 import `sync-flush`** 避循環）、`sync-reconcile-daemon.ts`（常駐；60s + flush 後 8s + 訂單變更後 20s；一致→寫 ack、兩邊終態唔同→`blocked` conflict、雲端冇且 >24h→`blocked` missing、其餘自動補推；裝喺 `pos-sync-flush-worker.tsx`）。
- `sync-flush.ts`：`isRetryableEvent` 取代永久放棄（15min 慢速重試）；`ok && !applied` → `skipped`/`server-newer`。`api/pos/sync/route.ts`：`EventAck` 加 `applied`/`reason`；**終態升級豁免** `isTerminalUpgrade`（根治 M4）。`app-sidebar.tsx`：**「在線」徽章 = 網絡 + 同步健康合併**，底色最壞優先 blocked紅 / pending琥珀 / offline琥珀 / 正常才用網絡色；正常文案仍係「在線／離線」，有嘢未上雲則變「N 張待傳」「同步受阻」；`level==="ok"` 時 `disabled`＝純狀態徽章。
- ✅ **回執帳本 TTL（2026-09-10 已修）**：`RECONCILE_ACK_TTL_MS = 10 分鐘`。`isOrderAcked(order, index?, maxAckAgeMs = 0, nowMs)`／`listUnackedTerminalOrders(nowMs, maxAckAgeMs = 0)` —— **守護必須傳 TTL**，**健康燈必須唔傳（0＝永久）**，否則每 10 分鐘閃一次「N 張待傳」。修復前病：`isOrderAcked` 寫過就永久有效 → 雲端被回水永遠唔再 verify（燈綠、後台錯）。
- ⚠️ **iPad 分頁唔會自動換 JS**：診斷「明明修好但仲唔同步」第一步一定係叫用戶**強制 reload**。免 DevTools 入口：POS 設定頁「同步健康」掣（`pos-app.tsx:3910`）開 `SyncHealthModal`。
- 待做 P1：`clientRev` 單調修訂號 + `pos_orders.client_rev`(0031) + `/api/pos/orders/verify`。P2：IndexedDB、`/api/pos/sync-heartbeat`(0032)、後台同步健康／告警頁、雲端巡檢 job。
- 🚫 邊界：自動化**只推商家已做嘅事**，唔會自動把雲端 open 單改成 `settled`；兩邊終態唔一致 → 標 `conflict` 交人。

## 加單（ORDER_UPDATED）鐵律（2026-09-10 事故後）
- **payload 形狀**：`ORDER_UPDATED` **必須**送 `{ order, addedItems }`（`ORDER_CREATED` 才送裸 order）。送裸 order → server 攞唔到 id → 拒單（舊版掃碼加單 100% 必敗：客人見「落單成功」，收銀端零反應）。已做形狀相容，**但新 code 一律照送 `{order, addedItems}`**。`addedItems` = 新增菜品差額（`pos/order-item-diff.ts` 純函式，同 `pos-app.itemIdentity()` 同口徑）。
- **失敗分類**：`/api/pos/sync` 只可用「業務拒絕 → 4xx + `retryable:false`」／「基建失敗 → 500 + `retryable:true`」。**唔可以**再「任何 `ack(false)` 都回 500」—— client 規矩係「4xx（非429）= 永久，其餘 = 可重試」，回 500 會令永久拒絕被當網絡抖動 → 重試 → 入本地隊列 → **假成功**。`pos_queue_events` 寫入失敗只可降級 warning。
- **LWW 加菜豁免**：`incoming 項目數 > 現有` 時唔受時間戳判 stale（收銀端用**收銀機時鐘**更新 `client_updated_at`，快過客人手機時加單會被靜默 skip）。匿名寫入一律沿用 DB 現有 `status`/`fulfillment_status`。
- **收銀端出單守門**：`onOrderUpsert` 嘅「新單出廚房／標籤／小票」用 `isNewSelfOrder` 守門 → **加單唔出單**。加單另出 `ticketType:"addon"` + `itemsOverride`，差額簽名去重（`printedAddonSignatures`）。**唔重印**顧客小票。
- ⚠️ 場內所有機共用同一 NAT 公網 IP → **rate limit 唔可以淨靠 IP**（會自我 DoS）。已授權按 `storeId`（600/min）、匿名按 IP（300/min）。
- ⚠️ **待確認**：部署包 `NEXT_PUBLIC_SUPABASE_URL` 疑似指向 **Ledger 專案**（冇任何 `pos_*` 表），而 `getPosSupabaseClient()`（瀏覽器 Realtime + 售罄）用嘅正是佢 → 若屬實，POS Realtime 全部訂錯專案。見 `docs/reviews/qr-self-order-audit-2026-09-10.md` 附錄 B.6。

## 掃碼 vs Kiosk 分家（詳見 `docs/reviews/qr-self-order-audit-2026-09-10.md` 附錄 C）
- **入口**：`/order`（店內平板）→ `useKioskOrder()`；`/menu`（客人掃 QR）→ **`useScanOrder()`**。共用內核 `useOrderingCore(variant)`；`useScanOrder()` 刻意唔暴露 `returnToHome`。
- **掃碼冇單號**：掃碼路徑**唔打 `/api/pos/sequence`、唔叫 `nextLocalDailyOrderNo()`**，直接寫**台名**落 `local_order_no`（唔可以留空：必填 string、收銀端要印，server `text("")` 會變 NULL → 顯示 `#null`）。查詢鍵 = 台號：`fetchUnsettledKioskOrder()` = orderId 快路（sessionStorage）→ `GET /api/pos/order-lookup?storeId=&tableId=`。
- **⚠️ 台號查詢只認 `source="scan"`**：收銀端「自助單確認/拒絕」同「**加單補印廚房單**」全靠 `isSelfOrder()`（`source ∈ {kiosk,scan}`）分流。客人改到 `source="pos"` 嘅單 → 收銀端唔補印 → **廚房靜默漏單**。放寬前須先改收銀端補印閘。
- **落單成功要回讀 DB**：掃碼 ack 成功後即 `fetchScanOrderById(order.id)` → fallback `fetchScanTableOrder()`（離線入隊時**唔回讀**）。**狀態文案**用 `customerOrderStatusLabel()`，**唔好**用收銀端 `pos-order-filters.ts` 嗰套。

## 執行環境 / 版面 / 班次
- 唔用 UA sniff：APK → `window.PosNative.printJob`；PC 殼 → `window.companionShell`。client 讀 `window` 一律 mount-gated state（保 SSR hydration）。
- 全域滾動：Admin 用 AdminShell `h-[100dvh] overflow-y-auto`；Shared 分流 admin → `block`，POS `/reports` → `min-h-0 flex-1 overflow-y-auto`。反面教材 f1cc8ad。`body { overflow: hidden }` **勿刪**。
- 班次（0023 `pos_shifts`）：active = `closed_at IS NULL`，partial unique index 保每店一 active，service_role only。`reconcileLocalShift` 六場景見 `docs/109-*.md`：⑤ **server 無 + 本地 serverSynced=true → 本地 reset（唔好補 open，會死灰復燃）**。

## 開發注意事項 / 環境
- JSDoc 內唔好寫 `macau-pos/stores/*/orders`（`*/` 提早結束 comment）；用 `&#123;storeId&#125;`。
- 報表 `agg` 喺 useMemo 下方；backfill effect 內唔可引用。
- `next build` 報 LayoutProps 錯 = `.next` types 過期 → `rm -rf .next`。
- ⚠️ 本機 `next build` 會被 safe-delete 鈎子攔 → 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 並喺沙箱外跑。
- Node 22.22.2-2、Python 3.13.12（managed）；Next.js 16.3.0 + Turbopack + Tailwind 4（見 AGENTS.md）。

## 列表表格版面（2026-09-10 iPad 事故）
- 🔴 **`overflow-hidden` + `min-w-[1080px]` + `table-fixed` + 固定 px 欄寬 = 最右「操作」欄被剪走**。症狀：iPad 上「查看／返結帳／重打整單」等掣只剩半粒或全消失，用戶以為係權限／功能問題。
  - **成因**：`table-fixed` 下表格闊度 = `max(容器闊, 各欄指定闊相加)` → 8 欄指定闊相加 ≈ 1080px 必然大過 iPad 內容區（iPad 10.2" 橫向 1080 − 側欄 72 − padding ≈ 976）。上層再係 `overflow-hidden`（本來只想剪圓角）→ 溢出部分**直接消失**，唔會出滾動條。中間嗰層 `overflow-auto` 睇唔到溢出（子 div 闊度＝容器闊），所以冇 scrollbar 可以救。
  - **修法（4 個檔，2026-09-10）**：`local-orders-panel.tsx` / `online-orders.tsx` / `print-center.tsx` / `order-detail-list.tsx`：
    1. 外層 `overflow-hidden` → **`overflow-x-auto`**（保證永遠唔剪，窄到爆都只係滾動）。
    2. `<table>` 固定 px 欄寬 → **百分比**（保持 `table-fixed`；**只留一個欄唔指定**，例如「菜品／失敗原因」自動食剩餘，令百分比唔使加夠 100%）。
    3. `min-w-[1080px]` → **`min-w-[860px]`**（實測下限：可用闊 <844px 就開始有 cell 溢位；860 保證零溢位，只喺 <860 先滾動）。
    4. 操作掣加 `whitespace-nowrap`（配 `flex flex-wrap justify-end` 換行，唔會爆出格）。
  - **驗收口徑**：`table.scrollWidth == wrapper.clientWidth` 且每格 `cell.scrollWidth <= cell.clientWidth`。實測（headless Chrome）1400/1180/1024/976px 全部 PASS、溢出 cell = 0；舊寫法喺 976px 就 `table=1080 vs wrapper=960` FAIL。
  - ⚠️ **12 欄嘅「交班歷史」表唔可以用同一招**（`shift-page.tsx`）：6 個金額欄就算各 12% 都已經 72%，12 欄一定裝唔落。呢張表**保留橫向滾動**（本身係 `overflow-auto`，冇剪到嘢），只把「備註」欄 `min-w-[220px]` 收窄到 `150px`。
  - ⚠️ 已知限制：wrapper 一旦有 `overflow-*`（包括 `overflow-x-auto`，因另一軸 `visible` 會計算成 `auto`）就成為 scroll container → 表頭 `sticky top-0` 相對「唔會滾嘅嗰層」定位，等同失效。要 sticky 生效就要將 overflow 交返畀外層 `overflow-auto`（但會冇圓角裁剪）。現階段選「保住圓角 + 唔剪走操作欄」。
  - 驗證工具：`.workbuddy/tmp/table-responsive-check.html`（量測）+ `before-after.html`（前後對照截圖），headless Chrome `--dump-dom` / `--screenshot` 可重跑。

## 列印：分格線「一條變兩條」＋菜品名字體異常（2026-09-10 實紙事故，詳見 docs/114）
- 🔴 **分格線係純 ASCII 行，會繼承上一行嘅中文放大狀態**。`ESC/POS` 嘅 `GS ! n` / `FS ! n`（中文放大）係**打印機常駐狀態**，喺 Gprinter / 商頌系機器上 `ESC ! n` **清唔走**佢、兩者仲係**相乘**（docs/80 B2、docs/99 §1）。
  - 病徵：`items.size = 中/大` 嘅菜品名行發過 `GS ! 0x01` → 緊接嗰條 `"-".repeat(cols)` 跟住變雙闊 → 一行只裝 24 格 → 打印機**自動折行** → **一條邏輯線變兩條實體線**。菜品清單**之前**嗰條線前面係細字標頭（`GS ! 0x00`）→ 仍然一條 → 所以係「上有一條、每件菜下面兩條」嘅不對稱樣。
  - **修法契約（四個 repo 一樣）**：① 印線前**先清放大殘留**（`GS ! 0x00` + `ESC ! 0x00` + `FS ! 0x00`），唔好靠上一行；② dash 數量 = `dividerDashCount(size, cols)`（`m`/`l` 減半）→ **任何 size 都只佔一行**，`size` 淨係控制粗細。
  - POS 側唯一真源：`src/lib/escpos-render.ts` `dividerDashCount()`；`divider` 預設 size 已由 `m` 改為 **`s`**（一條幼線）。⚠️ 改完要**重 build APK 並裝機**，iPad 端仲要**強制 reload**。
- ⚠️ **「廚房單正常、收據唔正常」唔代表兩個 renderer 唔同**——佢哋係同一份算法。分別淨係「上一行嘅放大倍數」／模板 size。診斷同類問題要先問「呢條線前面嗰行係乜 size」。
- ⚠️ 預覽（`escpos-preview.tsx`）**冇模擬 CJK 放大**：`fontSize = SIZE_PX[size]`（`m` = 14px = 1.27×），實機 `GS ! 0x01` 係 2×2 → 「後台睇落大少少、出紙大一倍」係預期會再出現嘅落差，唔好淨靠預覽斷症。
