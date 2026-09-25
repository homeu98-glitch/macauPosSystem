# macauPos 記憶（2026-09-24 · 壓縮）

> 開工前必讀 `docs/113-agent-gotchas.md`；流程已成 `pos-*` skills。
> **細節／數據／時間線 → `DETAIL-2026-09.md` §A–§H**；本檔只放「唔可以違反嘅規則」。
> POS=`iyrywzormzisyppkokbi`；Ledger=`zymdemjflsckicwcinxl`。0050 已跑；**0051–0053 已寫未部署**。
> 09-24 營業中 egress 覆核（0.06／250 GB）→ §G；下載入口／版本控制 → §H。

## 0 訂單時間（唯一真源）
`order-event-time.ts` `orderEventInstant()`：reopenedAt→originalSettledAt→updatedAt→createdAt；篩選＋顯示全委派它。雲端冇 `original_settled_at` ⇒ 靠 `updated_at` ⇒ 🔴 週期性推前 `updated_at` 會令單**跨日漂移**（DETAIL §G.1）。`fetchOrdersInRange()` 三腿（0044）。

## 1 數字夾唔埋
下單機＝本機優先／第二台＝純雲端 state／交班＝LWW／**報表＝純雲端永不 merge**。實收＝毛＝`agg.paidTotal`。🔴 交班 `netPaidTotal`（＋未退）vs 報表 `netRevenue`（−退款）方向相反，唔可互抄。要逐張加總對 UI，唔可憑「差額合理」落結論。

## 2 返結四鐵律
①同機正常≠已上雲（查 `reopen_count`）②維持 `reopened`＋`keepPaidStatus` 認 `paid`/`reopened`（否則 items 永不上雲）③reopen_count/at/reason 單調遞增 ④🔴 加 `pos_orders` 欄位要改**四條**讀取路徑：`pos-order-mapper`／`pos-order-row`／`/api/pos/orders` 內聯 mapper／`sync` `baseRecord`。

## 3 鑑權
閘＝`posRouteAuthGuard()`，須放喺 early-return **之後**。🔴 `POS_REQUIRE_DEVICE_AUTH` **冇設＝開閘**。TTL 12h。🔴🔴 anon 讀 `pos_orders`(72h/0041)、`pos_print_jobs`(24h/0021) 係**刻意時間窗 RLS**，唔可移除或收短（三個 Realtime 消費者靠 anon 訂 `postgres_changes`；收緊＝零事件但照 `SUBSCRIBED`）⇒ 出紙 1–3 秒變最長 180 秒。守衛 `print-and-order-realtime-guard.test.ts`（25 條）。per-store token 見 DETAIL §A（自簽已否決：ECC P-256 私鑰取唔到）。

## 4 打印／中繼
🔴🔴 入隊只准 `appendPrintJobsWithSync()`；`appendPrintJobs()` **只寫本機**（唯一用途 `printKioskReceiptForOrder()`）。`pushEvents()` base 一定要 `loadQueue()`。去重靠 `onceKey`（id 係 randomUUID ⇒ 按 id merge 攔唔到）。`paired:true`≠在線。爆紙用 `pos_void_stale_print_jobs()`。claim 60s（有 job）／180s 封頂（idle）。🔴 落結論前用生產 log／DB 核對。
🔴🔴 2026-09-24 舊病：DB `once_key` 曾存 **client 原始 `PrintJob.onceKey`** ⇒ 自動收據全店共用 `receipt:0`、其餘 23505 被 `ack(true)` 靜默吞掉（本地永遠「已發送」、冇紙、冇紅標）。**✅ 2026-09-25 已核實修好並上線**：生產 `once_key` 係 composed `orderId|onceScope|printerId`；`/api/pos/state` 亦用 `printOnceScopeFromDbKey()` 還原原始鍵＋補 `printerId`，跨終端去重才生效。
🔴🔴 2026-09-25：**「本地有 job」帳本全部係 per-瀏覽器**（`printedOnceKeys`／`printedLedgerOrders`／`loadPrintJobs()`／`kitchenBackfillAttempted` in-memory）。**多終端（iPad＋桌面）同時開 ⇒ 後掛載嗰台會為「已經出過紙嘅線上單」再造一條廚房 job**（`ledger-pos-bridge.ts` L515-519 明文承認此邊界，商家口徑「寧多一張」）。雲端 DB 內容唯一鍵只擋得住 **relay 路徑**；若該台有 **Companion／native** 就會**本機直接出紙、完全繞過唯一鍵**（＝真・第二張紙）。根治方向（註釋自認「未做」）＝補印前喺**伺服器按 `order_id` 查一次 `pos_print_jobs`**。
🔴 `/api/pos/state` 嘅 printJobs 映射**剝走 `template` 同 `content`**（egress 考量），而 `pos-app.tsx` `persistPrintJobs(payload.printJobs)` 會把雲端 job 種入本機 ⇒ 該類 job 喺預覽落兜底分支：硬寫店名**「門店」**、冇時間／預約時間／全單備註。**預覽唔等於出紙**，唔可以憑預覽差異推論印咗兩張。

## 5 訂單／交班
結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱）。`print-xxxxxxxx`＝PrintJob 漏入 orders，已由 `order-id-guard` 擋住。🔴 三軌互不相干：`pos_shifts`（擋收銀台）／`pos_store_status.is_open`（線下）／Ledger `merchant_enabled`（線上）。總掣 `close-gate.ts`＋`close-gate-run.ts`：先線下後線上／線下失敗唔 return／null＝skipped／永不 throw；須排喺 `closeShift()` early return **之前**。🔴 `pos_store_status` 冇 row＝營業中；`pos_shifts` 冇 open row＝未開工（**方向相反**）。

## 6 UI／環境
收銀台＝`/pos`；`/`＝工作台選擇。深連結一律 `/pos?tableId=&orderId=`，**唔准推 `/`**；清 query 用 `replaceState(null,"",location.pathname)`（守衛 `pos-deeplink-path.test.ts`）。KPI 帶固定 5 欄。`button{font:inherit}` 壓過 `text-*` ⇒ 字級寫仔元素。🔴 `npm test`＝`node --test`：唔認 `@/`／`.tsx` ⇒ 可測模組零 import、邏輯與執行分檔。

## 7 判別／取證
`isSaleCountable()`：只計 settled／帶 `onlineOrderId` 嘅 paid，Macau 日界 ⇒ 未結帳單永不入報表。id 前綴＝建單程式。`storeId` 係公開值。⭐ `tools/log-recheck.cjs --both`、`probe-anon-exposure.cjs`（DETAIL §F）。🔴 量度陷阱：Vercel 一行 log＝一行 CSV 且倍數**可變** ⇒ 按 `requestId` 去重；兩份 log 窗口通常唔重疊，只比速率；CSV 有引號內換行。多部中繼機混算 claim 會被腰斬 ⇒ **逐 `agent_id` 拆**。🔴 anon 唯讀探測只有 24h 窗（`pos_orders` 72h）⇒ **睇唔到跨日行**，唔可以據此斷定「DB 冇呢一行」（2026-09-24 靠呢點漏咗一條 3 日前嘅阻塞行，要靠商家跑 SQL Editor 才見到）。

## 8 Egress／版本／同步
最大來源＝舊分頁跑舊 bundle（`limit=300`）⇒ 要「少拉」唔係「拉細」。🔴🔴 唔可用 partial payload 保護舊 client：凡可能令 `orders` 變空嘅回應，**要麼回真資料、要麼唔回 200**。🔴 水位只可喺 `Array.isArray(payload.orders)` 時推進；增量拉取保持**單腿**。`orders` store 只准放訂單 id（`order-id-guard`）。🔴 版本偵測**唔可以加請求** ⇒ 搭 `state`／`sync`(30s)／`shift`(180s) 回應標頭（`buildJson()` 包裝），守衛 `build-header-contract.test.ts`；橫幅只喺 `/pos` 頁頂 in-flow。

## 9 POS 工作階段
`pos_sessions`(0047)；續期搭 `sync`(60s)＋`state`(5 分，GET 只續期)；標頭 `x-pos-session`／`x-pos-build`；key 存 `sessionStorage`。🔴 `account` **唔可以**傳空/null（`verifyPosDeviceToken` 拒收 ⇒ 全店 401）。

## 10 庫存／帳目（expenseRecorder 跨專案）
🔴🔴 **供應商 duplicate key 根因＝`merchants.name` 有「全表唯一」約束**（`supabase_schema.sql:7`），同時 `(user_id,name)` 亦唯一 ⇒ `onConflict:"user_id,name"` 唔會報 42P10，但新行撞 `merchants_name_key` 報 23505 ⇒ **兩店唔可以同名**。J 2026-09-25 決定**保持全表唯一**，POS 端只做優雅提示（`ALREADY_EXISTS` 自動選用／`NAME_TAKEN` **唔可回 id**）。
🔴 expenseRecorder 將設定**偷藏喺 `merchants` 表**用保留名做 KV：`__shop_settings__:<uid>`／`__global_settings__`（全域單位＋支付方式主檔），內容放 `address`。真實供應商名唔會 `__` 開頭 ⇒ 一律濾走（**唔可以用 PostgREST `.not("name","like","__%")`**：SQL `_` 係通配符，會濾走全部）。
🔴 `__global_settings__` 一條列裝多個 key ⇒ 寫入**一定要 merge**（`patchGlobalSettings`），整份覆蓋會靜靜蓋走另一邊。
🔴 支付方式主檔真源＝expenseRecorder `/admin/payment-methods`（admin 帳號 60000000／0000）；POS 讀 `GET /api/inventory/payment-methods`，`scope` 分 `purchase`／`checkout`／`both`。兩 repo 各有一份預設，靠 `payment-method-defaults-parity.test.ts` 對齊。**「未設定」vs「空清單」一律用 `Array.isArray` 分**（否則 admin 清唔走）。
🔴 `normalizePosLocalSettings()` 逐欄重建 ⇒ 新欄位漏白名單會被**靜靜剷走**（今次 `invCategories`／`invSupplierOrder`／`invCategoryOrder` 已補）。
🔴 **「庫存・設置」係彈窗（J 2026-09-26 拍板，唔可以改成全頁）**：4 個 chips 係**多選**（供應商／品類／庫存品／支付方式顯示），最少開一個；供應商＋品類預設並排。**冇「保存」按鈕**（每項即時寫入，加「保存」會誤導）。「支付方式顯示」**唯讀**（主檔歸 expenseRecorder admin）。
🔴 主檔顯示次序存 `PosLocalSettings.invSupplierOrder`／`invCategoryOrder`（**用名做 key，唔用 id**）；純函式喺 `inventory-order.ts`（**零 import** 才可被 `node --test` 直接 import）。新項目一定要排最後（唔可以因排序設定而消失）。
🔴 篩選 chips「只顯示有資料嘅」＝確認稿要求，但**零筆數嘅唔可以刪**（2026-09-25 原 bug：月結 0 張 ⇒ chip 唔出現 ⇒ 商家以為冇呢個功能）。做法＝收埋喺「＋N 個未用過」展開器，且**當前選中嘅 key 唔准收埋**。
🔴 同一元件兩處 render（主頁 `InventoryTable` ＋ 設置 panel）＝**兩個獨立 state**，要 `onMutated` ＋ `key={productsVersion}` 強制換 instance 才同步。
🔴 `GET /api/inventory/master-usage`（供應商「用過 N 次」）**只拉 `merchant_id` 一個欄**、`SCAN_LIMIT=1500`、**lazy（只喺設置面板開住時叫）**；**唔可以拉 `raw_ocr_data`**（mg 級 egress）。品類冇佔比統計（靠收據反推成本太高）。
🔴 expenseRecorder `node_modules/next@16.2.9` 安裝**唔完整**（缺 `types.d.ts`／`dist/types`）⇒ 本機 `next build` 型別檢查必掛喺 Next 自己生成嘅 `.next/{dev/,}types/validator.ts`（TS7016）。**與代碼無關**；要 `npm i next@16.3.0`（同 POS 對齊）才修得好。
