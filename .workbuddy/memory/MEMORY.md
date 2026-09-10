# 專案長期記憶（macauPos / macauPosSystem）

> 日誌見 `.workbuddy/memory/YYYY-MM-DD.md`。詳細方案見 `docs/*.md`（下列条目尽量只保留「坑」，完整設計查 docs）。

## 報表模塊（restaurant-daily-report.tsx）
- **收入認列口徑**：`isSaleCountable(o)` 只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`；`refunded`/`partially_refunded`/`sent_to_kitchen` 唔計。有單全未結帳 → 琥珀提示條 +「未結帳訂單」KPI，**唔好**改口徑包未結帳。
- **菜品排行**：key = `menuItemId|訂單內菜品名`，金額用快照 `it.price`；改名/改價舊單各自成行。
- **尖峰時段**：`combinedByHour = agg.byHour + onlineByHour`；線上單 cursor 分頁 `listMerchantOrders`（PAGE=500、MAX=8），拒 `paymentStatus!=="paid"` 同含 cancel。
- **防雙計**：`posOnlineIds`（POS `onlineOrderId` Set）；`footfallTotal = posFootfall + countableOnlineOrders.length`。`onlineDishKey` 必須喺 `countableOnlineOrders` 之後宣告（TDZ）。
- **數據來源**：POS 單 `/api/pos/state?storeId&ordersOnly=1&start&end` 分頁（MAX_PAGES=10），雲端空+成功=空狀態，唔 fallback 本機。Ledger 總值以 `getMerchantReportSummary`（`orderCount`/`orderPaidMop`）為權威。日期一律 Macau 邊界 ISO（`ledger/report-period.ts`），禁用 UTC-naive 86400000。
- **營運指標**：只 4 行（營業額7日均/線上佔比7日均/會員充值7日均/售出份數）。`OrderDetailList`（order-detail-list.tsx）共用，報表頁喺支付方式分項上方、交班頁喺 Ledger 區塊上方；結賬時間 = `originalSettledAt ?? updatedAt`。

## MerchantId / store 隔離（嚴）
- `merchantId = staff_accounts.merchant_id`；DB 用 `store_id`；報表用 `useReportMerchantId()` 訂閱 `pos-auth-changed`。
- 讀取 strict：`belongsToStore() = o.storeId === merchantId`；undefined legacy 寧棄；初始 orders 空防 hydration 錯 scope。寫入端錯店靠重綁 `macau-pos-kiosk-device`／`?store=`（`60000003` 係真實 UUID）。
- **`dataReady = backfillDone && ledgerDone`**；admin 模式 `loadOnlineByHour` early return **必須 setLedgerDone(true)**（否則永遠 skeleton）；切店/切帳號重置 dataReady。
- `getMerchantReportSummary` 強型別：topup{`topupMop`(=paid+gift)/`topupPaidMop`/`topupGiftMop`}、deduct 同構、order{`orderCount`/`orderPaidMop`(=balance+in_store)/…}。禁 `console.table` Record（TS2769）。Admin 模式 Ledger 經 service-role 通道 `/api/admin/ledger/orders`；會員充值/扣點 RPC 需商戶 JWT → admin 仍空（已知限制）。

## 打印模板
- **qrUrl/qrSize**：收據/自助點餐機各自存；`normalizePosLocalSettings` **必須**帶返（漏過 → reload 剷走網址）；設計頁 `renderEscPosLines` 收據分支要傳 `{ qr, qrSize }`。大小只影響預覽（`QR_SIZE_FRACTION`），實體出紙由 Companion/APK `qrModuleScale()` 決定（跨 repo）。
- **divider 區塊（2026-09-09 方案 C）**：分格線係文字行 `"-".repeat(cols)`，繼承 sticky 放大。`Receipt/KitchenSectionId.divider` 係**設定型區塊**（renderer `continue`）：`visible=false` 全單唔印線；`size` s=48 dash 一行、m/l 雙闊 wrap 成 2×24 行。舊模板冇此區塊 → `fixedDividerSize==null` → 唔 call style（維持舊行為）。本 repo + `print-relay` + `print hub` 已改；desktop-companion / print-agent-android **未改**（見 `docs/handoff-print-divider-size.md`）。預設 `size="m"`。
- **標籤紙尺寸（2026-09-10 已解鎖，取代舊「鎖死 62mm」）**：`LABEL_STANDARD_WIDTH_MM=62` 只係 fallback（**查證過唔係業界標準**，實為收銀紙卷規格誤植）。商家揀 `LabelTemplate.paperSize` = `LABEL_PAPER_PRESETS` id：40x30=21 / 50x30=28 / 58x40=32 / 60x40=34 / 70x50=41 / 80x50=48 / 100x75=61 字每行，+ 62mm=36 保留。`columns=floor((W−8mm導軌)/1.5mm)`。⚠️ 唔使 migration（jsonb）但**必須**喺 `normalizePosLocalSettings` label 逐欄重建度手動白名單。字型 size 仍由 `withLabelFixedSizes()` 鎖死；UI 只畀改對齊/粗體/可見/順序/紙尺寸。
- **預覽（2026-09-10）**：一律用 `src/lib/preview-fixtures.ts` 嘅固定範例單（**唔再用真實訂單**）+ force-visible snapshot clone（`divider` 例外）。`EscPosPreview` prop 係 `columns`（紙闊由字數反推 `cols*6.6+16`），**唔係** `paperWidthMm`。收據金額 fixture 要對得住數：`142+14+7−1−14===148`。dev 有 `assertPreviewCoverage()` 防漏填。**唔可以改 `if(!text) continue`**（三邊相同，會改埋出紙）。
- **`EscPosTemplateSnapshot.cols`（跨 repo 唯一真源）**：POS `buildSnapshot(kind,tpl,cols?)` 計一次寫入；`paperColumnsFromSize()` = `contains("58")?32:48`；標籤 `min(presetCols, 機頭cols)`。出紙逐**打印機**計（snapshot 要喺 loop 入面砌）。companion / print hub / print-relay / print-agent-android 四邊一律 `template.cols ?: paperColumns(printer)`，**唔好再各自判 paperSize**。共用 `toPrintItemLines()`（`escpos-render.ts`）→ 預覽同出紙同一份 items 映射。
- **廚房模板已剷 `server`/`customer_count`**（死區塊：`buildKitchenContent` 回硬編 `""` 且從未傳過資料）。`mergeTemplateOrder()` 自動 filter 舊 id。
- **店級雲端同步（0027 `pos_print_templates`）**：store_id PK 一店一行四槽 jsonb；`/api/pos/print-templates` GET/POST（write client、`updated_at=now()` LWW）；1.5s 節流上雲、離線 unsynced 補推、unmount flush。meta 存 store-scope `print-template-meta`（唔入 PosLocalSettings）；一律 `normalizePrintTemplateSet()`（保護 qrUrl/qrSize/divider）。詳見 `docs/print-template-store-sync-2026-09-09.md`。
- **交班模板 = 第五槽（0030 `shift`/`shift_presets`）**：出紙一律 `buildShiftPrintJobs()` + `buildShiftContent()`（唯一真源，29 區塊、**刻意無 divider**）。`kind="shift"` 三邊 fall through 空字串、標題靠 `header` 區塊；`content[b.id]` key = `ShiftSectionId`。`normalizePosLocalSettings` 要白名單 3 個 key；pos-app merge 要**明確** `shiftPresets`/`shiftTemplatePresets` 分支（靠 default 傳播會靜靜剷走）。**0030 未跑兜底**：`isMissingColumnError`(42703) → 只讀寫四舊欄，否則整條同步壞。⚠️ select 欄位唔好抽 `(columns: string) => .select(columns)`（supabase-js 推導失效 → TS2339）。詳見 `docs/shift-template-2026-09-10.md`。
- **兩級狀態**：`pending`→`sent`（已交付通道）→`printed`/`failed`。status route 唔降格 printed→sent；claim RPC 只揀 pending/failed（天然防重印）。見 `docs/handoff-print-relay-printed-status.md`。

## 線上單取消/改單審核（2026-09-09 契約）
- Ledger `orders` **只有** `change_request_type`('cancel'|'modify'|null)/`_at`/`_by`/`_payload`；**無 status 欄**。申請存在=待審；處理完 type 清 null（Realtime UPDATE 推）。
- 一律打 RPC **`merchant_resolve_order_change`**(p_order_id,p_action)；**唔可以**用 `update_order_status('cancelled')` 同意取消（商戶自取消、唔沖正）。pending→直接 cancelled；accepted/preparing→只寫 type='cancel'；ready 之後唔可申請。
- approve 取消 → POS 自印作廢單（`printVoidForLedgerOrderOnce` 冪等防 echo 重印）；approve 改單 → 補印廚房單。無 MQTT/輪詢/webhook。

## 掃碼點餐授權（雙通道 + POS 憑證）（2026-09-10 落地）
- 掃碼客本質匿名且 repo **無 `middleware.ts`** → 採**分通道**：已授權（POS device token / admin token）放行全部事件；**匿名只准** `ORDER_CREATED`/`ORDER_UPDATED` 且 `source ∈ {scan,kiosk}`。QR 已公開 `store=<merchantId>`，故驗證 ≠ 授權。
- 憑證 = HMAC-SHA256 無狀態（`pos/pos-device-token.ts`，仿 `admin-session-token.ts`），**TTL 12h**；密鑰 `POS_DEVICE_TOKEN_SECRET` → `ADMIN_SESSION_SECRET` → `SUPABASE_SERVICE_ROLE_KEY`。**fail-closed**，`POS_REQUIRE_DEVICE_AUTH=0` 係應急回滾。
- 續期：`/api/pos/device-token`（Ledger token 換發）+ `refreshPosDeviceTokenIfNeeded()`（剩 <10min 續期、`inflight` 去重、永不 throw）。`/api/ledger/login` 回 `session.posDeviceToken`；`AuthSession.posDeviceToken` **必須**經 `normalizeAuthSession` 帶返。**所有** `/api/pos/state`、`/api/pos/sync` 呼叫點都要先續期再帶 `posDeviceAuthHeaders()`。
- Kiosk 離線隊列 = `pos/kiosk-outbox.ts`（store-scoped `macau-pos/kiosk-pending-orders/{storeId}`，上限 20）；**唔可以重用 `pos/queue-outbox`**（其 flush 靠 `resolveStoreId()`，掃碼客冇 → 永遠推唔出）。
- 客人 resume 用 `GET /api/pos/order-lookup`（單張 + 欄位白名單 + UUID 精確匹配 + 60/min），**唔好**拉全店 `state`。字串拼接 select 要 `as unknown as PosOrderDbRow`。
- 售罄：`pos_soldout` 只 realtime 增量 → **必須** `fetchStoreSoldoutIds()` 拉初始集合；`soldoutRealtimeRef` 防舊快照蓋新變更；server 端落單校驗**刻意 fail-open**。
- 金額單一真源 = `lib/kiosk-cart.ts`（`lineSignature`/`mergeCartLine`/`changeCartQty`/`computeOrderTotals`，純函式可單測）；`computeOrderTotals` 唔四捨五入，浮點用 `money2()`/`toFixed(2)` 收口。測試：`npm run test`（= `node --test`，Node 22.18+ 自動 strip types + 探索 `**/*.test.ts`，唔使寫 glob）；`npm run typecheck`。

## 同步一致性：本地終態 → 雲端（2026-09-10 診斷，方案 docs/112）
- 症狀鐵證：本地 iPad `settled`、雲端仍 `sent_to_kitchen`（`updated_at = created_at`）。七個機制：①`ORDER_SETTLED` 要憑證但 `syncNow()` 冇先續期（只有 `doFlush` 有）②attempts≥5 → `failed` **永久唔重試**③server 對 stale/降級回 `ack(true)` → client 剷走事件 = **假成功**④LWW 用 **client 牆鐘** `client_updated_at` → NTP 回撥令結帳被判 stale（**唔關網絡事都會中**）⑤對賬只在手動開 Sync Health Modal 先跑 = 零自動驗證⑥終態只存單機 localStorage⑦`syncNow([...queue, ev])` 用 stale state + 新事件未 stamp → 被 store filter 剔走（實推係 flush worker）。
- 設計口徑：**「靠狀態收斂」唔係「靠事件送達」**——全量快照 + 單調 `clientRev`（0031 `pos_orders.client_rev`，rev 優先/terminalRank 守門）→ 回執 `{applied,rev,reason}` → **常駐對賬守護**（每 60s verify，分叉自動補推）→ `syncAck` 帳本 → IndexedDB + 心跳 + 雲端巡檢 SQL。
- 🚫 邊界：自動化**只負責推商家已做嘅事**，唔會自動把雲端 open 單改 `settled`；兩邊都終態但唔一致 → 標 `conflict` 交人。

## 執行環境（原生殼 vs web/PWA）
- 唔用 UA sniff：APK → `window.PosNative.printJob`；PC 殼 → `window.companionShell`。三層 gate：`shouldUseCompanionChannel`（淨原生殼）/ `shouldKeepCompanionAlive`（+`?companion=`）/ `shouldAutoDiscoverCompanion`（+localhost）；`shouldShowCompanionUi` = autoDiscover || urlParam。client 讀 `window` 一律 mount-gated state（保 SSR hydration）。

## 全域滾動（body overflow hidden 勿刪）
- Admin 用 AdminShell `h-[100dvh] overflow-y-auto`；Shared 組件要分流：admin → `block`，POS `/reports` → `min-h-0 flex-1 overflow-y-auto`。反面教材 f1cc8ad。

## 開工/收工班次（0023 `pos_shifts`）
- 真源 `pos_shifts`（active=`closed_at IS NULL`，partial unique index 保每店一 active，service_role only）。API `/api/pos/shift` GET/POST(open/close/ackOvertime)。
- `shift-sync.ts reconcileLocalShift` 六場景見 `docs/109-shift-sync-overtime-plan.md`：⑤ **server 無+本地 serverSynced=true → 本地 reset（唔好補 open，會死灰復燃）**。
- OT：`isShiftOvertimeDue(openedAt,ackedAt,serverNow)` = `now-opened≥10h && (ack null || now-ack≥10h)`，全用 server 時鐘。

## 開發注意事項
- JSDoc 內唔好寫 `macau-pos/stores/*/orders`（`*/` 提早結束 comment）；用 `&#123;storeId&#125;`。
- 報表 `agg` 喺 useMemo 下方；backfill effect 內唔可引用。
- `next build` 報 LayoutProps 錯 = `.next` types 過期，`rm -rf .next` 重 build。
- ⚠️ 本機 `next build` 會被 safe-delete 鈎子攔（Turbopack 清 `.next/turbopack`）→ 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 並喺沙箱外跑；`rm -rf .next` 一樣。

## 環境
- Node 22.22.2-2（managed）、Python 3.13.12（managed）；Next.js 16.3.0 + Turbopack + Tailwind 4（見 AGENTS.md）。
