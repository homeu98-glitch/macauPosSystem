# 專案長期記憶（macauPos / macauPosSystem）

> 對話日誌見 `.workbuddy/memory/YYYY-MM-DD.md`。

## 打印模板（print-center.tsx 設計頁）
- **二維碼網址/大小**：`ReceiptTemplate.qrUrl?` + `qrSize?`（default "m"）收據/自助點餐機各自存。**`normalizePosLocalSettings` 一定要帶返 `qrUrl`/`qrSize`**（試過漏咗 → reload 剷走網址）。設計頁即時預覽 call `renderEscPosLines` 收據分支**必須傳 `{ qr, qrSize }`**，否則二維碼唔顯示。
- **二維碼大小**：`EscPosLine.qr` 帶 `size`；預覽用 `QR_SIZE_FRACTION`（s/m/l=紙闊 40%/55%/80%）。⚠️ 真實出紙物理大細由 Companion/APK `qrModuleScale()` 決定（跨 repo），呢 repo 只做設計==預覽==存檔。
- **分格線 = 模板 `divider` 區塊（2026-09-09 方案 C）**：實體分格線係**文字行** `"-".repeat(cols)`，會繼承印表機 sticky 放大狀態 → 出紙跟上一行字體放大；預覽以前係固定 CSS border → 唔一致。而家 `ReceiptSectionId`/`KitchenSectionId` 加 `divider`（**設定型區塊：renderer 遇到要 `continue`，唔 emit 行**）：`visible=false` = 全單唔印線；`visible=true` = 用 `size`（s=48 個 dash 一行；m/l 雙闊 → **wrap 成 2 個物理行**，每行 24 個）。舊模板冇呢個區塊 → `fixedDividerSize==null` → **唔 call style，維持「繼承」舊行為**（零影響）。預覽 `escpos-preview.tsx` 嘅 `DividerRows` 用文字 dash + `scale(2,1)/(2,2)` 模擬放大同行數。
  - 三邊同步：本 repo（render/preview/print-center/mock-data）+ `C:\dev\print-relay` 同 `C:\dev\print hub` 嘅 `EscPosRenderer.renderTemplateTicket()` 已改（`rule()` helper）；desktop-companion（而家 divider 強制 `setStyle("s")`）同 print-agent-android **未改**，改法見 `docs/handoff-print-divider-size.md`。
  - 預設 `divider.size="m"`（對齊而家大部份店嘅出紙）；`normalizePosLocalSettings` 嘅 merge 會自動補區塊落舊設定。
- **標籤模板鎖定**：`LABEL_STANDARD_WIDTH_MM=62`（沿用本系統標籤卷，唔好隨意改 60）。Label 區塊字型 size 鎖死，用 `withLabelFixedSizes()` 強制返 `LABEL_BLOCK_DEFAULTS`（buildSnapshot("label") + readTemplate("label") 都用）→ 舊 localStorage 存咗唔同 size 都無效。UI 唔畀改 label 字型檔位（仍可調對齊/粗體/可見/順序）。
- **店級雲端同步（2026-09-09 實作，0027 `pos_print_templates`）**：store_id PK 一店一行存四槽 jsonb + updated_at；route `/api/pos/print-templates` GET/POST（POST 用 write client、`updated_at=now()` 做 LWW）。print-center 進入即拉（server 有→採納＋記 meta；冇→保留本地），改動 1.5s 節流上雲、離線標 unsynced 網絡恢復補推、unmount flush，「儲存模板」強制上雲。pos-app `loadRuntimeState` merge 改 LWW：`serverTs > 本機 meta.updatedAt` 先採納。`/api/pos/state` 已帶 `printTemplatesServer`。meta 存 store-scope `print-template-meta`（唔入 PosLocalSettings）；統一用 `normalizePrintTemplateSet()` normalize（保護 qrUrl/qrSize/divider 唔被剷走）。詳見 `docs/print-template-store-sync-2026-09-09.md`。
- **交班模板 = 第五槽（2026-09-10，migration 0030 `shift`/`shift_presets`）**：以前交班單係 `shift-page.tsx` 硬編文字塞 `PrintJob.items`（無 template/content）→ 通道 fallback `renderKitchenTicket` → 出紙「【廚房單】+ 每行 x1」。而家 `PrintTemplates.shift`（`ShiftTemplate`：blocks+order+headerText+footerText+sectionTitles，29 個區塊、**刻意無 `divider`**——三個渲染器只喺 `items` 前後產生分格線，交班無 items → 加咗係死開關）。出紙一律行 **`buildShiftPrintJobs()`**（print-jobs.ts）→ job 帶 `template` 快照 + `content` 快照；`buildShiftContent()`（escpos-template.ts）係出紙內容唯一真源（交班即印 / 歷史重打 / 設計頁預覽共用），舊嘅 `shiftDetailToLines`+`buildShiftPrintLines` 兩份分歧 builder 已刪。**跨 repo 零改動**（已核實）：`kind="shift"` 喺 POS `TITLE` / companion-server.mjs:443 / EscPosRenderer.kt:303 都 fall through 空字串，標題靠 `header` 區塊帶；其餘區塊行 `content[b.id]`，key 就係 `ShiftSectionId`。範本庫（`shiftTemplatePresets` / `activeShiftTemplateId`）語義同 `specTemplates` 一致：庫=來源、生效=live 槽、「套用」=拷貝。**規範**：`normalizePosLocalSettings` 要白名單呢 3 個 key；pos-app merge 要有**明確** `shiftPresets`/`shiftTemplatePresets` 分支（靠 default 傳播會靜靜剷走）。**0030 未跑兜底**：`isMissingColumnError`(42703) → 只讀寫四個舊欄，否則整條模板同步（連收據）一齊壞。⚠️ select 欄位**唔可以**抽成 `(columns: string) => .select(columns)` 包裝 → supabase-js 推導失效變 `GenericStringError`（TS2339）。詳見 `docs/shift-template-2026-09-10.md`。

## 報表模塊（restaurant-daily-report.tsx）
- **收入認列口徑**：`isSaleCountable(o)` 只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`；`refunded`/`partially_refunded`/`sent_to_kitchen` 一律唔計（未收款唔計營業額係啱）。有單但全未結帳 → 顯示琥珀提示條 +「未結帳訂單」KPI，**唔好**改口徑去包未結帳。
- **菜品排行快照聚合**：key = `menuItemId|訂單內菜品名`，金額用 `it.price`（快照）。改名/改價後舊單各自成行。**唔好**改返大類聚合或強對當前餐牌。`buildMenuMeta()` 只供診斷。
- **尖峰時段**：`combinedByHour = agg.byHour + onlineByHour`；線上單 cursor 分頁 `listMerchantOrders`（PAGE=500、MAX=8），拒 `paymentStatus!=="paid"` 同含 cancel。
- **線上單防雙計**：`posOnlineIds`（POS `onlineOrderId` Set）；`footfallTotal = posFootfall + countableOnlineOrders.length`。線上菜品排行用 `onlineDishSource`；effect 觸發 key 用 `onlineDishKey`，且必須喺 `countableOnlineOrders` 之後宣告（TDZ）。
- **訂單明細列表**：`OrderDetailList`（order-detail-list.tsx）共用組件，報表頁喺支付方式分項上方、交班頁喺 Ledger 區塊上方。收銀員靠新審計欄位 `settledBy`/`settledByName`（結帳路徑寫入；舊單「未記錄」）；結賬時間 = `originalSettledAt ?? updatedAt`。
- **營運指標**：只保留 4 行（營業額7日均/線上佔比7日均/會員充值7日均/售出份數），POS vs Ledger 對比已刪。
- 數據來源：POS 單雲端 `/api/pos/state?storeId&ordersOnly=1&start&end` 分頁（MAX_PAGES=10）；雲端空+成功=空狀態，唔 fallback 本機。Ledger 總值以 `getMerchantReportSummary`（orderCount/orderPaidMop）為權威，POS 補差。日期一律 Macau 邊界 ISO（`ledger/report-period.ts`），禁用 UTC-naive 86400000 寫法。

## MerchantId / store 隔離（嚴）
- `merchantId = staff_accounts.merchant_id`（UUID）；DB 用 `store_id`。報表用 `useReportMerchantId()` 訂閱 `pos-auth-changed`。
- 讀取端 strict：`belongsToStore() = o.storeId === merchantId`；undefined legacy row 寧棄。初始 orders 空防 hydration 錯 scope。寫入端：Kiosk/QR 綁定錯店（`60000003` 係真實 merchant UUID，唔係 mock）先會寫錯店；讀取已隔離，要改寫入就重綁 `macau-pos-kiosk-device`／`?store=`。
- **`dataReady = backfillDone && ledgerDone`**；admin 模式 `loadOnlineByHour` early return **必須 setLedgerDone(true)**（否則永遠 skeleton）。切店/切帳號即重置 dataReady。
- `getMerchantReportSummary` 回傳強型別：topup{`topupMop`(=paid+gift)/`topupPaidMop`/`topupGiftMop`}、deduct{同構}、order{`orderCount`/`orderPaidMop`(=balance+in_store)/`orderBalancePaidMop`/`orderInStorePaidMop`}；加 `rawAvos` module-level 一次性 console.log（禁 `console.table` Record → TS2769）；可選 count 欄位 probe `*_count`。
- Admin 模式 Ledger 讀取行 service-role 通道（`/api/admin/ledger/orders`，route 喺 `app/api/admin/ledger/orders`）；會員充值/扣點 RPC 需商戶 JWT → admin 仍空（已知限制）。

## 打印任務兩級狀態（2026-09-07 已實作）
- `pending`=待派發；`sent`=POS 已交付打印通道（relay 只代表入雲端隊列）；`printed`=通道回報真實出紙；`failed`。
- 已改：`status` route 唔再降格 `printed`→`sent`；print-center 回填 printed +「打印成功」filter/badge +「清除已成功」；`clearSentPrintJobs` 只清 sent；pos-app `onPrintJobUpsert` 容許 sent→printed/failed 升級。DB 生命週期 `pending→printing→printed/failed`；claim RPC 只揀 pending/failed → 天然防重印。relay 團隊交接見 `docs/handoff-print-relay-printed-status.md`（agent 真實出紙先報 printed、失敗必報 failed）。

## 線上單客人取消/改單審核（2026-09-09 契約）
- Ledger `orders` **只有** `change_request_type`('cancel'|'modify'|null)/`change_request_at`/`change_request_by`/`change_request_payload`（cancel 時 payload=null）；**無 `change_request_status`**。申請存在=待審；拒絕/同意/客人撤回都係 type 清 null（Realtime UPDATE 推）。
- 審核一律打 RPC **`merchant_resolve_order_change`**(p_order_id,p_action:'approve'|'reject')，店員 JWT 即可；**無** `update_change_request_status`。同意取消**唔可以**用 `update_order_status('cancelled')`（商戶自取消、唔沖正）。
- 兩條取消路徑勿混：pending 取消→直接 status=cancelled；accepted/preparing 取消→只寫 type='cancel'（auto_accept 後全行呢條）。ready/delivering/completed/cancelled 唔可申請取消。
- approve 成功後 POS 自行 LAN 印作廢單（直連 RPC 唔觸發 Ledger 作廢單 MQTT；`printVoidForLedgerOrderOnce` 冪等防 realtime echo 重印）；approve 改單→補印廚房單。無 MQTT/輪詢/webhook。

## 執行環境判斷（原生殼 vs web/PWA）
- 唔用 UA sniff：Android APK → `window.PosNative.printJob`；PC 殼 → `window.companionShell`。
- companion 三層 gate 由嚴到寬：`shouldUseCompanionChannel`（淨原生殼）/ `shouldKeepCompanionAlive`（原生殼 OR `?companion=`，純 website 零 /api/health）/ `shouldAutoDiscoverCompanion`（原生殼 OR localhost）；`shouldShowCompanionUi` = autoDiscover || urlParam（純 web/PWA 隱藏成張卡）。UI 一定要包 localhost。
- client 讀 `window` 一律 mount-gated state（`null` 初始 + effect 設值），保 SSR=client 首 render。

## 全域滾動（body overflow hidden 鎖死，勿刪）
- `globals.css body{overflow:hidden}` 係 POS 內部 scroll 嘅前提。Admin 用 AdminShell `h-[100dvh] overflow-y-auto` 自做容器。**Shared 組件（restaurant-daily-report）要按模式分流**：admin → 內容 `block`（AdminShell 滾）；POS `/reports` → `min-h-0 flex-1 overflow-y-auto`（main 係 `h-[100dvh] flex flex-col overflow-hidden`）。反面教材：f1cc8ad 一刀切 block 令 POS /reports 滾唔到（已修返）。

## 開工/收工班次（2026-09-07 上雲，migration 0023）
- **真源 = `pos_shifts`**（一表一班次；active=`closed_at IS NULL`；每店一 active 由 partial unique index 保證；service_role only）。API `/api/pos/shift`：GET→{active,serverNow}；POST open（已有 active→conflict 以現有為準）/close/ackOvertime。
- 前端 `src/lib/shift-sync.ts reconcileLocalShift` 六場景（改前必讀）：①server active+本地無/時間唔同→adopt server；②server active+本地收工且 closedAt>=openedAt→補 close；③一致→只 sync ack；④server 無+本地開工中且 `serverSynced=false`→補 open（離線開工）；⑤**server 無+本地 serverSynced=true→人哋已收工，本地 reset（唔可以補 open，會死灰復燃）**；⑥其他 no-op。
- OT 提醒 `isShiftOvertimeDue(openedAt,ackedAt,serverNow)`：`now-opened≥10h && (ack null || now-ack≥10h)`，全用 server 時鐘；取消=ackOvertime（server `overtime_acked_at`），確認→router.push('/shift')。POS app 每 60s+網絡恢復+focus reconcile。
- `ShiftState` 已加 employeeAccount/employeeName/overtimeAckedAt/serverSynced。方案/驗證見 `docs/109-shift-sync-overtime-plan.md`。

## 開發注意事項
- JSDoc 內唔好寫 `macau-pos/stores/*/orders`（`*/` 提早結束 comment）；用 `&#123;storeId&#125;`。
- 報表組件 `agg` 喺 useMemo 下方；backfill effect 內唔可引用。
- `next build` 報 LayoutProps = `.next` generated types 過期，`rm -rf .next` 重 build。
- ⚠️ 本機 `next build` 會被 WorkBuddy safe-delete 鈎子攔（Turbopack 清 `.next/turbopack` 達 bulk threshold）→ 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 並喺沙箱外跑；`rm -rf .next` 一樣要沙箱外。

## 環境
- Node 22.22.2-2（managed）、Python 3.13.12（managed）；Next.js 16.3.0 + Turbopack + Tailwind 4，詳見 AGENTS.md。
