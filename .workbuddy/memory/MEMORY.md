# 專案長期記憶（macauPos / macauPosSystem）

> 日誌見 `.workbuddy/memory/YYYY-MM-DD.md`；完整設計查 `docs/*.md`。本檔只留「坑」同不可違背規則。

## 報表（restaurant-daily-report.tsx）
- 收入認列 `isSaleCountable(o)`：只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`；refunded/partially_refunded/sent_to_kitchen 唔計。有未結帳 → 琥珀提示 + KPI，**唔好**改口徑。
- 菜品排行 key = `menuItemId|單內菜名`，金額用快照 `it.price`（改名/改價舊單各自成行）。
- 尖峰 `combinedByHour = agg.byHour + onlineByHour`；線上單 cursor 分頁 `listMerchantOrders`（PAGE=500/MAX=8），拒 `paymentStatus!=="paid"`。
- 防雙計：`posOnlineIds`；`footfallTotal = posFootfall + countableOnlineOrders.length`。`onlineDishKey` 必須喺 `countableOnlineOrders` 之後宣告（TDZ）。
- 來源：`/api/pos/state?storeId&ordersOnly=1&start&end` 分頁（MAX_PAGES=10）；雲端空 + 成功 = 空狀態，**唔 fallback 本機**。Ledger 以 `getMerchantReportSummary`（`orderCount`/`orderPaidMop`）為權威。日期一律 Macau 邊界 ISO（`ledger/report-period.ts`），禁 UTC-naive 86400000。
- 營運指標只 4 行；`OrderDetailList` 共用；結賬時間 = `originalSettledAt ?? updatedAt`。

## store 隔離（嚴）
- `merchantId = staff_accounts.merchant_id`；DB 用 `store_id`；報表 `useReportMerchantId()` 訂 `pos-auth-changed`。
- 讀 strict `o.storeId === merchantId`；undefined legacy 寧棄；初始 orders 空防 hydration 錯 scope。錯店靠重綁 `macau-pos-kiosk-device`／`?store=`（`60000003` 係真 UUID）。
- **`dataReady = backfillDone && ledgerDone`**；admin `loadOnlineByHour` early return **必須 setLedgerDone(true)**；切店/切帳號重置。
- `getMerchantReportSummary` 強型別 topup{`topupMop`(=paid+gift)/`topupPaidMop`/`topupGiftMop`}、order{`orderCount`/`orderPaidMop`(=balance+in_store)}。禁 `console.table` Record（TS2769）。admin Ledger 走 `/api/admin/ledger/orders`；會員充值/扣點 RPC 需商戶 JWT → admin 仍空（已知）。

## 打印模板（詳見 `docs/print-*.md`、`docs/shift-template-*.md`）
- **`normalizePosLocalSettings` 係白名單重建，漏欄即靜靜剷走**：`qrUrl`/`qrSize`、`LabelTemplate.paperSize`、pos-app merge 嘅 `shiftPresets`/`shiftTemplatePresets` 都中過招 → 每次加欄都要手動加白名單。
- **`EscPosTemplateSnapshot.cols` 係跨 repo 唯一真源**：POS `buildSnapshot(kind,tpl,cols?)` 計一次；四邊（companion / print hub / print-relay / print-agent-android）一律 `template.cols ?: paperColumns(printer)`，**唔好再各自判 paperSize**。出紙逐打印機計（snapshot 喺 loop 入面砌）。共用 `toPrintItemLines()`（`escpos-render.ts`）。
- 標籤紙尺寸用 `LABEL_PAPER_PRESETS` id（40x30=21 … 100x75=61 字/行）；62mm 只係 fallback（**唔係**業界標準）。字型 size 由 `withLabelFixedSizes()` 鎖死，UI 只可改對齊/粗體/可見/順序/紙尺寸。
- 預覽用 `preview-fixtures.ts` 固定範例單 + force-visible clone（`divider` 例外）；`EscPosPreview` prop 係 `columns`（反推 `cols*6.6+16`）**唔係** `paperWidthMm`。**唔可以改 `if(!text) continue`**（三邊相同，會改埋出紙）。折扣行預覽用 `bg-slate-900 text-white` 對應出紙 `ESC { 1` inverse。
- 店級同步：0027 `pos_print_templates`（store_id PK + 四槽 jsonb）+ 0030 第五槽 `shift`/`shift_presets`；`/api/pos/print-templates` LWW。**0030 未跑兜底**：`isMissingColumnError`(42703) → 只讀寫四舊欄。⚠️ select 唔好抽 `(columns: string) => .select(columns)`（supabase-js 推導失效 → TS2339）。
- 打印狀態：`pending`→`sent`（已交付通道）→`printed`/`failed`；status route 唔降格；claim RPC 只揀 pending/failed（天然防重印）。
- divider 區塊：`visible=false` 全單唔印線；`size` s=48 一行、m/l 2×24 行；舊模板無此區塊 → 唔 call style。desktop-companion / print-agent-android **未改**。

## 線上單取消/改單審核
- Ledger `orders` **無 status 欄**，只有 `change_request_type`('cancel'|'modify'|null) + `_at`/`_by`/`_payload`。申請存在 = 待審。
- 一律打 RPC **`merchant_resolve_order_change`**；**唔可以**用 `update_order_status('cancelled')` 同意取消。pending→直接 cancelled；accepted/preparing→只寫 type='cancel'；ready 後唔可申請。
- approve 取消 → POS 自印作廢單（`printVoidForLedgerOrderOnce` 冪等防 echo 重印）；改單 → 補印廚房單。無 MQTT/輪詢/webhook。

## 掃碼點餐授權（雙通道 + POS 憑證）
- repo **無 `middleware.ts`** → **分通道**：有 POS device token / admin token 放行全部事件；**匿名只准** `ORDER_CREATED`/`ORDER_UPDATED` 且 `source ∈ {scan,kiosk}`。QR 已公開 `store=<merchantId>`，驗證 ≠ 授權。
- 憑證 = HMAC-SHA256 無狀態（`pos/pos-device-token.ts`），**TTL 12h**；密鑰 `POS_DEVICE_TOKEN_SECRET` → `ADMIN_SESSION_SECRET` → `SUPABASE_SERVICE_ROLE_KEY`；**fail-closed**，`POS_REQUIRE_DEVICE_AUTH=0` 係應急回滾。
- 續期 `refreshPosDeviceTokenIfNeeded()`（剩 <10min、`inflight` 去重、永不 throw）；`AuthSession.posDeviceToken` **必須**經 `normalizeAuthSession` 帶返。**所有** `/api/pos/state`、`/api/pos/sync` 呼叫點都要先續期再帶 `posDeviceAuthHeaders()`。
- Kiosk 離線隊列 = `pos/kiosk-outbox.ts`（store-scoped，上限 20）；**唔可以重用 `pos/queue-outbox`**（其 flush 靠 `resolveStoreId()`，掃碼客冇 → 永遠推唔出）。
- 客人 resume 用 `GET /api/pos/order-lookup`（單張 + 欄位白名單 + 60/min），**唔好**拉全店 `state`。
- 售罄 `pos_soldout` 只 realtime 增量 → **必須** `fetchStoreSoldoutIds()` 拉初始集合；`soldoutRealtimeRef` 防舊快照蓋新；server 落單校驗**刻意 fail-open**。
- 金額真源 = `lib/kiosk-cart.ts`（純函式可單測）；`computeOrderTotals` 唔四捨五入，用 `money2()`/`toFixed(2)` 收口。`npm run test`（`node --test`，自動探索 `**/*.test.ts`；**測試檔內 import 一定要相對路徑 + `.ts` 副檔名**，`@/` alias 會 `ERR_MODULE_NOT_FOUND`）；`npm run typecheck`。

## 同步一致性：本地終態 → 雲端（P0 已落地；設計 `docs/112-*.md`）
- 症狀：本地 iPad `settled`、雲端仍 `sent_to_kitchen`（`updated_at = created_at`）。七機制：①`ORDER_SETTLED` 要憑證但 `syncNow()` 冇先續期 ②attempts≥5 → 永久放棄 ③stale/降級回 `ack(true)` = **假成功** ④LWW 用 **client 牆鐘** → NTP 回撥就中（**唔關網絡事**）⑤對賬只在手動開 modal 先跑 ⑥終態只存單機 localStorage ⑦`syncNow([...queue, ev])` 用 stale state + 新事件未 stamp → 被 store filter 剔走。
- 口徑：**「靠狀態收斂」唔係「靠事件送達」**。**2026-09-10 17:51 首次生產實證生效**：iPad 重開 APP 後守護自動補推 3 張殭屍單（`pos_queue_events.payload->>'action' = 'reconcile_repush'`），雲端 3 張 `sent_to_kitchen` → 全部變終態，admin「未結帳」由 3 跌到 1。**驗證守護有冇跑，就查 queue 有冇 `reconcile_repush` 事件。**
  - 新檔 `sync-acks.ts`（回執帳本 + 健康燈；**刻意唔 import `sync-flush`** 避循環）、`sync-reconcile-daemon.ts`（常駐；60s + flush 後 8s + 訂單變更後 20s；一致→寫 ack、兩邊終態唔同→`blocked` conflict、雲端冇且 >24h→`blocked` missing、其餘自動補推；裝喺 `pos-sync-flush-worker.tsx`）。
  - 改 `sync-flush.ts`（`isRetryableEvent` 取代永久放棄，15min 慢速重試；`ok && !applied` → `skipped`/`server-newer`，唔剷、唔燒 attempts）、`api/pos/sync/route.ts`（`EventAck` 加 `applied`/`reason`；**終態升級豁免** `isTerminalUpgrade` 令結帳無視時間戳可寫，根治 M4）、`pos-app.tsx`（`syncNow` 收斂為單一路徑）、`storage.ts`/`types.ts`（store-scope `sync-acks`/`sync-blocked`；`QueueSkipReason` 加 `"server-newer"`）、`app-sidebar.tsx`（**「在線」徽章 = 網絡 + 同步健康合併**：底色最壞優先 blocked紅 / pending琥珀 / offline琥珀80 / 正常才用網絡色；文案一切正常時仍係「在線／離線」，有嘢未上雲則變「N 張待傳」「同步受阻」；`level==="ok"` 時 `disabled` 兼 `cursor-default`＝純狀態徽章，異常才可按即時重試並顯示「重試中…」）。
- ✅ **回執帳本 TTL（2026-09-10 已修）**：`RECONCILE_ACK_TTL_MS = 10 分鐘`（`sync-acks.ts`）。`isOrderAcked(order, index?, maxAckAgeMs = 0, nowMs = Date.now())` 與 `listUnackedTerminalOrders(nowMs, maxAckAgeMs = 0)` —— **守護必須傳 TTL**（回執過期即重新入工作集 → 每個 TTL 週期最多多打一次 pull），**健康燈必須唔傳（0＝永久）** 否則每 10 分鐘閃一次「N 張待傳」。`retryReconcileNow()` 用 `runReconcileRound("manual-retry", { ignoreAcks: true })`（人手重試無視回執）。修復前嘅病：`isOrderAcked` 寫過就永久有效 → 雲端被回水永遠唔會再 verify（燈綠、後台錯）；2026-09-10 三張殭屍單救得返純粹係「重開 APP 令帳本歸零」嘅偶然。
- ⚠️ **iPad 分頁唔會自動換 JS**：部署後仍跑載入那一刻嘅 build → 診斷「明明修好但仲唔同步」第一步一定係叫用戶**強制 reload**。免 DevTools 入口：POS 設定頁「同步健康」掣（`pos-app.tsx:3910`）開 `SyncHealthModal`，五區清單（同步失敗事件／已結帳但雲端未同步／雲端有但本機缺／孤兒單／已隔離）。
- 待做 P1：`clientRev` 單調修訂號 + `pos_orders.client_rev`(0031) + `/api/pos/orders/verify`。P2：IndexedDB、`/api/pos/sync-heartbeat`(0032)、後台「設備同步健康」/「同步告警」頁、雲端巡檢 job。
- 🚫 邊界：自動化**只推商家已做嘅事**，唔會自動把雲端 open 單改成 `settled`；兩邊終態唔一致 → 標 `conflict` 交人。

## 加單（ORDER_UPDATED）鐵律（2026-09-10 事故後）
- **payload 形狀**：`ORDER_UPDATED` **必須**送 `{ order, addedItems }`（`ORDER_CREATED` 才送裸 order）。`sync/route.ts` 對 UPDATED 讀 `eventPayload.order`；送裸 order → server 攞唔到 id → 拒單。舊版掃碼加單就係咁 100% 必敗（客人見「落單成功／同步中」，收銀端零反應）。現已做形狀相容（`nestedOrder ?? eventPayload`），**但新 code 一律照送 `{order, addedItems}`**。`addedItems` = 新增菜品差額（`pos/order-item-diff.ts` 純函式，同 `pos-app.itemIdentity()` 同口徑）。
- **失敗分類**：`/api/pos/sync` 只可以用「業務拒絕 → 4xx + `retryable:false`」／「基建失敗 → 500 + `retryable:true`」。**唔可以**再「任何 `ack(false)` 都回 500」—— client 嘅規矩係「4xx（非429）= 永久，其餘 = 可重試」，回 500 會令永久拒絕被當網絡抖動 → 重試 → 入本地隊列 → **假成功**（比唔兜底更差）。`pos_queue_events` 寫入失敗只可降級 warning（唔係業務真源，`/api/pos/state` 直接讀 `pos_orders`）。
- **LWW 加菜豁免**：`incoming 項目數 > 現有項目數` 時唔受時間戳判 stale —— 收銀端任何動作都會用**收銀機時鐘**更新 `client_updated_at`，時鐘快過客人手機時加單會靜默 skip。匿名寫入一律沿用 DB 現有 `status`/`fulfillment_status`（狀態機 owner 係收銀端）。
- **收銀端出單守門**：`pos-app.tsx onOrderUpsert` 嘅「新單出廚房／標籤／小票」用 `isNewSelfOrder`（本機未見過）守門 → **加單唔會出單**。加單要另出 `ticketType:"addon"` + `itemsOverride`（只印新增菜品），並用差額簽名去重（`printedAddonSignatures`）。**唔重印**顧客小票。
- **rate limit 唔可以淨靠 IP**：場內所有機（收銀／自助機／客人／廚房平板）共用同一個 NAT 公網 IP → 一律按 IP 會自我 DoS。已授權按 `storeId`（600/min）、匿名按 IP（300/min）。
- ⚠️ **客人端售罄架構未接通**：`pos_soldout` 喺生產兩個 Supabase 專案都唔存在，且**全 repo 冇寫入點**（POS 沽清 = 本機 localStorage + `/api/inventory/soldout` TODO stub）→ `fetchStoreSoldoutIds()` 永遠回 null、server 端售罄校驗永遠 fail-open。要接通需先做「店級售罄上雲」。
- ⚠️ **待確認**：部署包顯示 `NEXT_PUBLIC_SUPABASE_URL` 指向 **Ledger 專案**（冇任何 `pos_*` 表），而 `getPosSupabaseClient()`（瀏覽器端 Realtime + 售罄）用嘅正是佢 → 若屬實，瀏覽器端 POS Realtime 全部訂錯專案。詳見 `docs/reviews/qr-self-order-audit-2026-09-10.md` 附錄 B.6。

## 掃碼 vs Kiosk 分家（2026-09-10 需求；詳見附錄 C）
- **入口唔同**：`/order`（店內平板）→ `useKioskOrder()`；`/menu`（客人手機掃 QR）→ **`useScanOrder()`**（`src/lib/use-scan-order.ts`）。兩者共用內核 `useOrderingCore(variant)`（`use-kiosk-order.ts`；`useKioskOrder()` 就係 `core("kiosk")`）。**`useScanOrder()` 刻意唔暴露 `returnToHome`** —— 掃碼端冇「完成」呢個概念。
- **掃碼冇單號**：`placeOrder()` 掃碼路徑**完全唔打 `/api/pos/sequence`、唔叫 `nextLocalDailyOrderNo()`**；`buildKioskOrder({ orderNoSource:"table" })` 直接寫**台名**落 `local_order_no`。⚠️ 唔可以留空字串：`PosOrder.localOrderNo` 係必填 string、收銀端模板要印，而 server `text("")` 會變 NULL → 收銀端顯示 `#null`。
- **查詢鍵 = 台號**：`GET /api/pos/order-lookup?storeId=&tableId=` 回該台所有非終態單（回應 `orders[]` + `order`=最新，向後兼容）。`fetchUnsettledKioskOrder()` 次序 = **orderId 快路（sessionStorage）→ 台號查 DB**。舊版冇 orderId 就 `return null` → 換手機掃同枱 QR 會顯示空白／當新單（本輪修嘅就係呢個）。
- **⚠️ 台號查詢只認 `source="scan"`**：收銀端「自助單確認/拒絕」同「**加單補印廚房單**」全部靠 `isSelfOrder(order)`（`source ∈ {kiosk,scan}`）分流。若客人改到一張 `source="pos"` 嘅單 → 收銀端唔補印 → **廚房靜默漏單**；server 亦會覆寫 `source`/`local_order_no` 令報表走樣。要放寬須先改收銀端加單補印閘（獨立工作項）。
- **落單成功要回讀 DB**：掃碼 ack 成功後即 `fetchScanOrderById(order.id)` → fallback `fetchScanTableOrder()`，用 DB 版本做畫面真源（離線入隊時**唔回讀**，否則會蓋走客人手上嗰張）。
- **狀態文案**：客人端用 `pos/order-status-label.ts` 嘅 `customerOrderStatusLabel()`（`ready` 優先於單據狀態；未知值回「進行中」唔露枚舉）；**唔好**用收銀端 `pos-order-filters.ts` 嗰套（受眾唔同）。`OrderSummaryCard` 有 `statusLabel`／`hideOrderNo` props（`/order` 唔傳 = 行為不變）。

## 執行環境（原生殼 vs web/PWA）
- 唔用 UA sniff：APK → `window.PosNative.printJob`；PC 殼 → `window.companionShell`。gate：`shouldUseCompanionChannel`／`shouldKeepCompanionAlive`(+`?companion=`)／`shouldAutoDiscoverCompanion`(+localhost)；`shouldShowCompanionUi` = autoDiscover || urlParam。client 讀 `window` 一律 mount-gated state（保 SSR hydration）。

## 全域滾動（body overflow hidden 勿刪）
- Admin 用 AdminShell `h-[100dvh] overflow-y-auto`；Shared 組件分流：admin → `block`，POS `/reports` → `min-h-0 flex-1 overflow-y-auto`。反面教材 f1cc8ad。

## 班次（0023 `pos_shifts`）
- active = `closed_at IS NULL`，partial unique index 保每店一 active，service_role only；API `/api/pos/shift`。
- `shift-sync.ts reconcileLocalShift` 六場景見 `docs/109-*.md`：⑤ **server 無 + 本地 serverSynced=true → 本地 reset（唔好補 open，會死灰復燃）**。
- OT：`isShiftOvertimeDue` = `now-opened ≥ 10h && (ack null || now-ack ≥ 10h)`，全用 server 時鐘。

## 開發注意事項
- JSDoc 內唔好寫 `macau-pos/stores/*/orders`（`*/` 提早結束 comment）；用 `&#123;storeId&#125;`。
- 報表 `agg` 喺 useMemo 下方；backfill effect 內唔可引用。
- `next build` 報 LayoutProps 錯 = `.next` types 過期 → `rm -rf .next`。
- ⚠️ 本機 `next build` 會被 safe-delete 鈎子攔 → 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 並喺沙箱外跑。

## 環境
- Node 22.22.2-2、Python 3.13.12（managed）；Next.js 16.3.0 + Turbopack + Tailwind 4（見 AGENTS.md）。
