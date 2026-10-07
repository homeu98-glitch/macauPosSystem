# macauPos 記憶（2026-10-05 · 精簡）

> 開工前必讀 `docs/113-agent-gotchas.md`；流程已成 `pos-*` skills。
> **細節／數據／時間線 → `DETAIL-2026-09.md` §A–§H**；本檔只放「唔可以違反嘅規則」。
> POS=`iyrywzormzisyppkokbi`；Ledger=`zymdemjflsckicwcinxl`。0050 已跑；**0051–0057 已寫未部署**。

## 0 訂單時間（唯一真源）
`order-event-time.ts` `orderEventInstant()`：**settledAt**→reopenedAt→originalSettledAt→updatedAt→createdAt（0057 後 `settled_at` 排最前）；篩選＋顯示全委派它。雲端冇 `original_settled_at` ⇒ 舊單靠 `updated_at` ⇒ 🔴 週期性推前 `updated_at` 會令單**跨日漂移**（DETAIL §G.1）。`fetchOrdersInRange()` 四腿（0044／0057）。

## 1 數字夾唔埋
下單機＝本機優先／第二台＝純雲端 state／交班＝LWW／**報表＝純雲端永不 merge**。實收＝毛＝`agg.paidTotal`。🔴 交班 `netPaidTotal`（＋未退）vs 報表 `netRevenue`（−退款）方向相反，唔可互抄。要逐張加總對 UI，唔可憑「差額合理」落結論。
🔴 2026-09-30：**admin 總覽同報表嘅日歸屬字段唔同** ⇒ 同一日永遠可能差幾張。總覽 `/api/admin/merchants` 用 `created_at`（`.gte` 更**冇上限**）；報表／交班用 `orderEventInstant()`。真兇＝**澳覓單 `created_at` 被 +8h**（插件 `aomi-bridge.js` 傳澳門本地時間字串 → `grabber-order.ts:539-542` 直寫 `timestamptz`，Postgres 當 UTC）；mfood 冇事。判別：`settled_at` **早過** `created_at` ＝資料錯，此時**報表嗰邊才對**。
🔴🔴 **2026-10-01 退款口徑（J 拍板）**：
- **交班頁**：資金卡 **2 張**（應收／實收，**都係線下＋線上**，範圍對稱 ⇒ 可「應收 − 實收 ＝ 優惠折扣＋抹零」對數）。實收大數＝**毛**；卡內方框只列「**退款（POS 線下）** − X」＋「**淨實收（落袋）**」兩行（「毛實收」行已刪，同大數重複）。
- **報表頁**：營業額大數改**淨額**（`totalRevenueNetMop` ＝ 線下收款 − 退款 ＋ 線上收款）；副標題線下分拆**必須同步扣退款**；提示球只講「營業額不包含退款金額」。
- 🔴🔴 **Ledger 側完全冇退款資料源**：`LedgerOrderRow` 冇任何退款欄；`refunded_amount` 只存在 POS `pos_orders`（0049）⇒「Ledger 純線上退款」POS 睇唔到。唯一睇得到嘅線上退款＝本地投影單，而佢哋本身就係 POS 單（已計入線下）⇒ 硬標「線下＋線上」＝**重複計算**。✅ 正解：**退款只從線下扣** ＋ UI 標明「Ledger 純線上退款未計入」。（不可用 `agg.netRevenue` —— 佢唔含 `ledgerOnlyPaidTotal`。）
- ⚠️ 兩處 `{false ? …}` 隱藏區含**舊文案**（報表舊退款橫幅／交班「會員通線上（Ledger）」區塊）—— 還原前**必須先更新文案**。

## 2 返結四鐵律
①同機正常≠已上雲（查 `reopen_count`）②維持 `reopened`＋`keepPaidStatus` 認 `paid`/`reopened`（否則 items 永不上雲）③reopen_count/at/reason 單調遞增 ④🔴 加 `pos_orders` 欄位要改**四條**讀取路徑：`pos-order-mapper`／`pos-order-row`／`/api/pos/orders` 內聯 mapper／`sync` `baseRecord`。
🔴🔴 **2026-10-05 跨機返結失聯**：`createReopenTempTable()`（`pos-orders.ts:94`）嘅 temp 枱**只寫本機** `localSettings.floors`，`device-settings.tsx:633/909` 推上 server 時刻意 `stripReopenTempTables()` 剝走 ⇒ **另一部機唔見「返結」枱，商家喺該機冇重結入口**（A01 顯示空閒＝已搬 temp 枱，屬設計）。J 拍板＝**桌台總覽另開「返結帳（N）」區塊、唔依賴枱**（零雲端風險、免 migration），整卡**條件 render**（§6）。
🔴🔴 同一病灶第二個 bug（未修）：`reopenOriginalTableId`/`Name` **完全冇上雲** ⇒ 跨機重結 `isReopenRestore` 為 false ⇒ **唔還原原枱**，單永久卡 `temp-reopen-xxx`＝枱面空枱、單懸空。修＝加 migration ＋ 改四條路徑。
✅ `reopened` **唔計營業額、唔入訂單明細係正確口徑**（`isSaleCountable()` 只認 settled/paid）。J 拍板維持，靠 KPI「未結帳訂單 … 已重開 N 張」睇。唔好當 bug 亂改。

## 3 鑑權
閘＝`posRouteAuthGuard()`，須放喺 early-return **之後**。🔴 `POS_REQUIRE_DEVICE_AUTH` **冇設＝開閘**。TTL 12h。🔴🔴 anon 讀 `pos_orders`(72h/0041)、`pos_print_jobs`(24h/0021) 係**刻意時間窗 RLS**，唔可移除或收短（三個 Realtime 消費者靠 anon 訂 `postgres_changes`；收緊＝零事件但照 `SUBSCRIBED`）⇒ 出紙 1–3 秒變最長 180 秒。守衛 `print-and-order-realtime-guard.test.ts`。

## 4 打印／中繼
🔴🔴 入隊只准 `appendPrintJobsWithSync()`；`appendPrintJobs()` **只寫本機**（唯一用途 `printKioskReceiptForOrder()`）。`pushEvents()` base 一定要 `loadQueue()`。去重靠 `onceKey`（id 係 randomUUID ⇒ 按 id merge 攔唔到）。`paired:true`≠在線。爆紙用 `pos_void_stale_print_jobs()`。claim 60s／180s 封頂。🔴 落結論前用生產 log／DB 核對。
🔴 2026-09-24 舊病（**09-25 已修並上線**）：DB `once_key` 曾存 client 原始值 ⇒ 全店共用 `receipt:0`，其餘 23505 被 `ack(true)` 靜默吞。現生產為 composed `orderId|onceScope|printerId`。
🔴🔴 2026-09-25：**「本地有 job」帳本全部 per-瀏覽器**（`printedOnceKeys`／`printedLedgerOrders`／`loadPrintJobs()`）。多終端同時開 ⇒ 後掛載嗰台會為已出紙嘅線上單**再造廚房 job**（`ledger-pos-bridge.ts` L515-519 承認此邊界，商家口徑「寧多一張」）。唯一鍵只擋 relay 路徑；有 Companion／native 就**本機直出紙、繞過唯一鍵**＝真第二張。根治＝補印前喺伺服器按 `order_id` 查 `pos_print_jobs`。
🔴 `/api/pos/state` printJobs 映射**剝走 `template`／`content`**，`persistPrintJobs` 會種入本機 ⇒ 該類 job 預覽落兜底分支（店名「門店」、冇時間／備註）。**預覽唔等於出紙**。

## 4.5 Realtime 重連（四個 hook 同一寫法）
🔴🔴 **subscribe callback 第一行一定要有**：`if (cancelled || channel !== ch) return;`。移除舊 channel 前**先清空變數**（`const stale = channel; channel = null; await removeChannel(stale)`）。
病（2026-09-27 Ledger 配額事故）：`subscribe()` 開頭自己 `removeChannel(舊)` ⇒ supabase-js 對舊 channel 送 `CLOSED`；四個 hook 都當斷線 ⇒ 死循環，每圈 debounce 3 秒打增量 ⇒ 一台 iPad 一日約 **1,980 次** `list_merchant_orders`。**回前景一次就循環到關頁。**
🔴 「先清空變數再 await」**治洩漏唔治回授**；根治必須 callback 自比 `channel !== ch`。守衛 `realtime-resubscribe-loop.test.ts`（29 條）。
🔴 `CLOSED` **唔可以**為修迴圈而刪（刪咗 channel 一死就永久靜默、零 error）。
🔴 `await supabase.removeChannel(stale)` 之後**一定要**再判 `if (cancelled) return;`。四個 hook 一致。
🔴 清 `reconnectTimer` 時**順序**＝先 `if (subscribeInFlight) return;` 才清（反過來殺死有效重連 ⇒ 永久唔再連）。
🔴 topic 唯一性：`pos-ledger-orders:<merchantId>` 只有兩個消費者（`/pos`／`/orders`）⇒ 當前路由唔會同頁；同 topic 兩條 channel 會互相踩死，一頁只准一個。

## 5 訂單／交班
結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱）。`print-xxxxxxxx`＝PrintJob 漏入 orders，已由 `order-id-guard` 擋。🔴 三軌互不相干：`pos_shifts`／`pos_store_status.is_open`／Ledger `merchant_enabled`。總掣 `close-gate.ts`＋`close-gate-run.ts`：先線下後線上／線下失敗唔 return／null＝skipped／永不 throw；須排喺 `closeShift()` early return **之前**。🔴 `pos_store_status` 冇 row＝營業中；`pos_shifts` 冇 open row＝未開工（**方向相反**）。

## 6 UI／環境
收銀台＝`/pos`；`/`＝工作台選擇。深連結一律 `/pos?tableId=&orderId=`，**唔准推 `/`**；清 query 用 `replaceState(null,"",location.pathname)`。KPI 帶固定 5 欄。`button{font:inherit}` 壓過 `text-*` ⇒ 字級寫仔元素。🔴 `npm test`＝`node --test`：唔認 `@/`／`.tsx` ⇒ 可測模組零 import、邏輯與執行分檔。
🔴🔴 **條件式警示卡要「整卡條件 render」，唔可以留空殼**（2026-10-01）：刪卡時，卡內有價值內容若係條件式（如「N 張線上單未標記完成」＋補推掣），唔應保留外殼改中性標題 —— 冇異常時會剩**常年空卡**。✅ 整卡連標題一齊條件 render。⚠️ 若真要保留底層邏輯，用 `{false ? … : null}` ＋ `eslint-disable-next-line` ＋ 註解「有意為之，唔係遺漏」。
🔴 **JSX 內唔可以用 Markdown `**粗體**` 或 `<b>`／`<strong>`** ⇒ 用 `<span className="font-semibold">`。`InfoBubble` 內層係 `<span>` ⇒ 只可用 `<span className="block">` 分行，唔可放 `<div>`／`<p>`。
🔴 **JSX 屬性位置用 `/* */` 塊註解**（`{/* */}` 只可喺 children 位置）；`//` 單行註解喺屬性之間會爆語法錯。

### 6.1 守衛測試設計（2026-10-07 血淚）
🔴🔴 **守「行為不變量」，唔好守「代碼字串」**。寫死一整句代碼 ⇒ 任何無害重構都爆，
而**真正壞掉時反而可能唔爆**。實例：斷言 `body: JSON.stringify({store, account})` 整句，
加一個 `mode` 就爆（但契約其實冇壞）；斷言 `hit.baseline_unit_cost !== null` 逐字，
抽出 helper 後變 `shouldWriteBaseline(hit?.…)` 就爆。✅ 改為逐欄／逐行為檢查。
🔴 亦唔好斷言「**剛好 N 個**」（如 `onMutated?.()` 剛好 4 個）—— 要守「每個寫入點都有就夠」。
🔴 **Tailwind 只為「實際用過」嘅 class 生成 CSS**：首次用某 utility（如 `sr-only`）會**完全冇 CSS**
⇒ 元素原樣顯示、零 error。✅ 唔可只驗 class 名，要**量實際 bounding box**。
🔴 **檔案係 CRLF**：守衛測試做多行 regex（`^…$`）前要**先 `replace(/\r\n/g,"\n")`**，否則對唔上。
🔴 **抽函式體唔可以「搵第一個 `{`」** —— 參數本身可能係 destructure／型別字面量
（`async ({mode, silent}: {…}) => {`）。✅ 由宣告處逐個 `{` 試配對、**取內容最長者**
（見 `inventory-contract-guard.test.ts` `functionBody()`）。門檻唔可以太細：
`{ mode, silent }: { mode: "auto" | "manual"; silent: boolean }` 本身就 44 字。

## 7 判別／取證
`isSaleCountable()`：只計 settled／帶 `onlineOrderId` 嘅 paid，Macau 日界 ⇒ 未結帳單永不入報表。id 前綴＝建單程式。`storeId` 係公開值。⭐ `tools/log-recheck.cjs --both`、`probe-anon-exposure.cjs`（DETAIL §F）。🔴 量度陷阱：Vercel 一行 log＝一行 CSV 且倍數**可變** ⇒ 按 `requestId` 去重；兩份 log 窗口通常唔重疊，只比速率；CSV 有引號內換行。多部中繼機混算會被腰斬 ⇒ **逐 `agent_id` 拆**。🔴 anon 唯讀探測只有 24h 窗（`pos_orders` 72h）⇒ **睇唔到跨日行**，唔可據此斷定「DB 冇呢一行」。

## 8 Egress／版本／同步
最大來源＝舊分頁跑舊 bundle（`limit=300`）⇒ 要「少拉」唔係「拉細」。🔴🔴 唔可用 partial payload 保護舊 client：凡可能令 `orders` 變空嘅回應，**要麼回真資料、要麼唔回 200**。🔴 水位只可喺 `Array.isArray(payload.orders)` 時推進；增量拉取保持**單腿**。`orders` store 只准放訂單 id。🔴 版本偵測**唔可以加請求** ⇒ 搭 `state`／`sync`(30s)／`shift`(180s) 回應標頭（`buildJson()` 包裝），守衛 `build-header-contract.test.ts`；橫幅只喺 `/pos` 頁頂 in-flow。

## 9 POS 工作階段
`pos_sessions`(0047)；續期搭 `sync`(60s)＋`state`(5 分，GET 只續期)；標頭 `x-pos-session`／`x-pos-build`；key 存 `sessionStorage`。🔴 `account` **唔可以**傳空/null（`verifyPosDeviceToken` 拒收 ⇒ 全店 401）。

## 10 庫存／帳目（expenseRecorder 跨專案）
🔴🔴 **供應商 duplicate key 根因＝`merchants.name` 有「全表唯一」約束**（`supabase_schema.sql:7`）。J 2026-09-25 決定**保持全表唯一**，POS 端只做優雅提示（`ALREADY_EXISTS` 自動選用／`NAME_TAKEN` **唔可回 id**）。
🔴 expenseRecorder 將設定**偷藏喺 `merchants` 表**用保留名 KV：`__shop_settings__:<uid>`／`__global_settings__`（內容放 `address`）。真實供應商名唔會 `__` 開頭 ⇒ 一律濾走（**唔可以用 `.not("name","like","__%")`**：SQL `_` 係通配符）。
🔴 `__global_settings__` 一條列裝多個 key ⇒ 寫入**一定要 merge**（`patchGlobalSettings`）。
🔴 支付方式主檔真源＝expenseRecorder `/admin/payment-methods`（admin 60000000／0000）；POS 讀 `GET /api/inventory/payment-methods`，`scope` 分 `purchase`／`checkout`／`both`。兩 repo 各有一份預設，靠 `payment-method-defaults-parity.test.ts` 對齊。**「未設定」vs「空清單」一律用 `Array.isArray` 分**。
🔴 `normalizePosLocalSettings()` 逐欄重建 ⇒ 新欄位漏白名單會被**靜靜剷走**。
🔴 **「庫存・設置」係彈窗（J 2026-09-26 拍板）**：4 chips **多選**，最少開一個；**冇「保存」按鈕**（即時寫入）；「支付方式顯示」**唯讀**。
🔴 顯示次序存 `PosLocalSettings.invSupplierOrder`／`invCategoryOrder`（**用名做 key**）；純函式喺 `inventory-order.ts`（**零 import** 才可被 `node --test` import）。新項目一定排最後。
🔴 篩選 chips「只顯示有資料嘅」＝確認稿要求，但**零筆數嘅唔可以刪** ⇒ 收喺「＋N 個未用過」展開器，且**當前選中嘅唔准收埋**。
🔴 同一元件兩處 render（主頁 `InventoryTable` ＋ 設置 panel）＝**兩個獨立 state**，要 `onMutated` ＋ `key={productsVersion}` 才同步。
🔴 `GET /api/inventory/master-usage` **只拉 `merchant_id` 一個欄**、`SCAN_LIMIT=1500`、**lazy**；**唔可以拉 `raw_ocr_data`**（mg 級 egress）。
🔴 expenseRecorder `node_modules/next@16.2.9` 安裝**唔完整** ⇒ 本機 `next build` 必掛喺 Next 自己生成嘅 validator.ts（TS7016）；要 `npm i next@16.3.0`（同 POS 對齊）。

## 11 交班頁庫存支出（2026-10-05）
🔴 **列印單早已有買貨成本，零改動**：`escpos-template.ts` 嘅 `section_purchase`／`purchase_paid` 預設可見；
`shift-page.tsx:1105` 早已寫 `purchase:{paid,unpaid}`；`escpos-template.ts:1226-1231` 早已 render。
紙單印「今日買貨成本（已付）：MOP 0」＝ 當日真係冇已付收據，**唔係 bug**（已核實，唔好再改）。
🔴 **「已付支出」係獨立參考數**，唔可以同「應收／實收」加減（收入卡只計銷售訂單；貨款尤其月結唔係當日營業額扣減）。
🔴 三卡同行用 **`lg:grid-cols-3`**（唔用 `md:`）：md 級 768–1023px 要疊放，因為實收卡內嘅退款區唔夠位。
🔴 `purchaseToday` **唔喺 `pageReady` 閘內** ⇒ 唔可以用佢做 loading 判斷（API 失敗會永久卡 loading），null ⇒ 出空狀態。
🔴 未付支出**一律唔顯示**（J 拍板），資料照抓。
