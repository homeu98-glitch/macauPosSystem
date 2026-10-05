# macauPos 記憶（2026-09-24 · 壓縮）

> 開工前必讀 `docs/113-agent-gotchas.md`；流程已成 `pos-*` skills。
> **細節／數據／時間線 → `DETAIL-2026-09.md` §A–§H**；本檔只放「唔可以違反嘅規則」。
> POS=`iyrywzormzisyppkokbi`；Ledger=`zymdemjflsckicwcinxl`。0050 已跑；**0051–0053 已寫未部署**。
> 09-24 營業中 egress 覆核（0.06／250 GB）→ §G；下載入口／版本控制 → §H。

## 0 訂單時間（唯一真源）
`order-event-time.ts` `orderEventInstant()`：**settledAt**→reopenedAt→originalSettledAt→updatedAt→createdAt（0057 後 `settled_at` 排最前）；篩選＋顯示全委派它。雲端冇 `original_settled_at` ⇒ 舊單靠 `updated_at` ⇒ 🔴 週期性推前 `updated_at` 會令單**跨日漂移**（DETAIL §G.1）。`fetchOrdersInRange()` 四腿（0044／0057）。

## 1 數字夾唔埋
下單機＝本機優先／第二台＝純雲端 state／交班＝LWW／**報表＝純雲端永不 merge**。實收＝毛＝`agg.paidTotal`。🔴 交班 `netPaidTotal`（＋未退）vs 報表 `netRevenue`（−退款）方向相反，唔可互抄。要逐張加總對 UI，唔可憑「差額合理」落結論。
🔴🔴 2026-09-30：**admin 總覽同報表嘅日歸屬字段唔同** ⇒ 同一日永遠可能差幾張。總覽 `/api/admin/merchants` 用 `created_at`（`.gte` 更**冇上限**）；報表／交班用 `orderEventInstant()`。實案 21 單/1,407 vs 20 單/1,294。真兇＝**澳覓單 `created_at` 被 +8h**（插件 `aomi-bridge.js` 傳澳門本地時間字串 → `grabber-order.ts:539-542` 直寫 `timestamptz` → Postgres 當 UTC）；mfood 冇事（`timeline.created` 自帶 offset）。判別法：`settled_at` **早過** `created_at` ＝ 資料錯，此時**報表嗰邊才對**。
🔴🔴 **2026-10-01 退款口徑（J 拍板，兩頁）**：
- **交班頁**：資金卡帶 **2 張**（應收／實收，**都係線下＋線上**，範圍對稱 ⇒ 可直接「應收 − 實收 ＝ 全單優惠折扣＋抹零」對數）。實收大數＝**毛**；卡內方框只列「**退款（POS 線下）** − X」與「**淨實收（落袋）**」兩行（原本嘅「毛實收」行已刪 —— 同大數重複）。
- **報表頁**：營業額大數改為**淨額**（`totalRevenueNetMop` ＝ 線下收款 − 退款 ＋ 線上收款）；副標題線下分拆**必須同步扣退款**（否則分拆加總 ≠ 大數）；提示球唔再出退款拆解算式，只講「營業額不包含退款金額」。
- 🔴🔴 **Ledger 側完全冇退款資料源**（已查證）：`list_merchant_orders` 只回 `total_avos`/`discount_avos`/`subtotal_avos`；`LedgerOrderRow` 冇任何退款欄；`orders.ts` 全文 `refund` 出現 **0 次**；`refunded_amount` 只存在 POS 自己嘅 `pos_orders`（遷移 0049）。
  ⇒ 「Ledger 純線上單嘅退款」**POS 根本睇唔到**。唯一睇得到嘅線上退款係「本地投影單」嗰批，而佢哋**本身就係 POS 單、早已計入線下** ⇒ 硬標「線下＋線上」＝**重複計算**。✅ 正解：**退款只從線下扣**，並喺 UI 標明「Ledger 純線上退款未計入」。
  （數學上 `毛 − 退款` ≡ `(線下收款 − 退款) + 線上收款`；用 `agg.netRevenue` 係錯嘅 —— 佢唔含 `ledgerOnlyPaidTotal`。）
- ⚠️ 專案內有兩處 `{false ? …}` 隱藏區含**舊文案**（報表舊退款橫幅／交班「會員通線上（Ledger）」區塊）—— 還原前**必須先更新文案**，否則同新口徑打架。

## 2 返結四鐵律
①同機正常≠已上雲（查 `reopen_count`）②維持 `reopened`＋`keepPaidStatus` 認 `paid`/`reopened`（否則 items 永不上雲）③reopen_count/at/reason 單調遞增 ④🔴 加 `pos_orders` 欄位要改**四條**讀取路徑：`pos-order-mapper`／`pos-order-row`／`/api/pos/orders` 內聯 mapper／`sync` `baseRecord`。
🔴🔴 **2026-10-05 跨機返結失聯**：`createReopenTempTable()`（`pos-orders.ts:94`）嘅 temp 枱**只寫本機** `localSettings.floors`，`device-settings.tsx:633/909` 推上 server 時刻意 `stripReopenTempTables()` 剝走（寫入 `bootstrap.tables` 會永久升級做真實枱）。⇒ **另一部機唔會見到「返結」枱，商家喺該機完全冇重結入口**（A01 顯示空閒＝已搬去 temp 枱，屬設計）。J 拍板解法＝**桌台總覽另開「返結帳（N）」區塊、唔依賴枱**（零雲端風險、免 migration），整卡**條件 render**（§6 教訓）。
🔴🔴 同一病灶的第二個 bug（未修）：`reopenOriginalTableId`/`Name` **完全冇上雲**（`pos_orders` 由 0043 起只有 reopen_count/at/reason；四條讀取路徑 0 hit）⇒ 跨機重結時 `isReopenRestore` 為 false ⇒ **唔會還原原枱**，張單永久卡喺 `temp-reopen-xxx`（該機冇呢張枱）＝枱面空枱、單懸空。修＝加 migration 寫 `reopen_original_table_id`/`_name` ＋ 改四條路徑。
✅ `reopened` **唔計營業額、唔入訂單明細係正確口徑**（`isSaleCountable()` 只認 settled/paid；錢未收）。J 拍板維持，靠 KPI「未結帳訂單 … 已重開 N 張」睇。唔好當成 bug 亂改報表。

## 3 鑑權
閘＝`posRouteAuthGuard()`，須放喺 early-return **之後**。🔴 `POS_REQUIRE_DEVICE_AUTH` **冇設＝開閘**。TTL 12h。🔴🔴 anon 讀 `pos_orders`(72h/0041)、`pos_print_jobs`(24h/0021) 係**刻意時間窗 RLS**，唔可移除或收短（三個 Realtime 消費者靠 anon 訂 `postgres_changes`；收緊＝零事件但照 `SUBSCRIBED`）⇒ 出紙 1–3 秒變最長 180 秒。守衛 `print-and-order-realtime-guard.test.ts`（25 條）。per-store token 見 DETAIL §A（自簽已否決：ECC P-256 私鑰取唔到）。

## 4 打印／中繼
🔴🔴 入隊只准 `appendPrintJobsWithSync()`；`appendPrintJobs()` **只寫本機**（唯一用途 `printKioskReceiptForOrder()`）。`pushEvents()` base 一定要 `loadQueue()`。去重靠 `onceKey`（id 係 randomUUID ⇒ 按 id merge 攔唔到）。`paired:true`≠在線。爆紙用 `pos_void_stale_print_jobs()`。claim 60s（有 job）／180s 封頂（idle）。🔴 落結論前用生產 log／DB 核對。
🔴🔴 2026-09-24 舊病：DB `once_key` 曾存 **client 原始 `PrintJob.onceKey`** ⇒ 自動收據全店共用 `receipt:0`、其餘 23505 被 `ack(true)` 靜默吞掉（本地永遠「已發送」、冇紙、冇紅標）。**✅ 2026-09-25 已核實修好並上線**：生產 `once_key` 係 composed `orderId|onceScope|printerId`；`/api/pos/state` 亦用 `printOnceScopeFromDbKey()` 還原原始鍵＋補 `printerId`，跨終端去重才生效。
🔴🔴 2026-09-25：**「本地有 job」帳本全部係 per-瀏覽器**（`printedOnceKeys`／`printedLedgerOrders`／`loadPrintJobs()`／`kitchenBackfillAttempted` in-memory）。**多終端（iPad＋桌面）同時開 ⇒ 後掛載嗰台會為「已經出過紙嘅線上單」再造一條廚房 job**（`ledger-pos-bridge.ts` L515-519 明文承認此邊界，商家口徑「寧多一張」）。雲端 DB 內容唯一鍵只擋得住 **relay 路徑**；若該台有 **Companion／native** 就會**本機直接出紙、完全繞過唯一鍵**（＝真・第二張紙）。根治方向（註釋自認「未做」）＝補印前喺**伺服器按 `order_id` 查一次 `pos_print_jobs`**。
🔴 `/api/pos/state` 嘅 printJobs 映射**剝走 `template` 同 `content`**（egress 考量），而 `pos-app.tsx` `persistPrintJobs(payload.printJobs)` 會把雲端 job 種入本機 ⇒ 該類 job 喺預覽落兜底分支：硬寫店名**「門店」**、冇時間／預約時間／全單備註。**預覽唔等於出紙**，唔可以憑預覽差異推論印咗兩張。

## 4.5 Realtime 重連（四個 hook 同一寫法）
🔴🔴 **subscribe callback 第一行一定要有「現用 channel」守衛**：`if (cancelled || channel !== ch) return;`（`ch` ＝ 建立時 `const ch = supabase.channel(...)...`，之後 `channel = ch`）。亦有移除舊 channel 前**先清空變數**（`const stale = channel; channel = null; await removeChannel(stale)`）。
病（2026-09-27 Ledger 配額事故）：`subscribe()` 開頭自己 `removeChannel(舊)` ⇒ supabase-js 會對**舊 channel** 送 `CLOSED`；四個 hook 都把 `CLOSED` 當斷線 ⇒ 死循環（移除→CLOSED→3 秒重連→再移除健康 channel→…），每圈 `SUBSCRIBED` 後 debounce 3 秒打一次增量 ⇒ 正式環境同一台 iPad 一日約 **1,980 次** `list_merchant_orders`（晚市每 6 秒一次）。**只要回前景一次就循環到關頁。**
🔴 教訓：`use-pos-realtime`／`use-kds-realtime` 2026-09-15 已用「先清空變數再 await」**仍然中招** —— 清空只治**洩漏**，唔治**回授**；根治必須 callback 自比 `channel !== ch`。
🔴 `CLOSED` **唔可以**為修迴圈而刪走（2026-09-15 加固：唔判 `CLOSED` ⇒ channel 一死就永久靜默、零 error）。
🔴 `await supabase.removeChannel(stale)` 之後**一定要**再判 `if (cancelled) return;`（2026-09-27）：`channel` 已係 null ⇒ cleanup 唔會清 ⇒ 留下冇人清嘅訂閱。四個 hook 一致。
🔴 `subscribe()` 開頭清未觸發嘅 `reconnectTimer` 時，**順序**＝先 `if (subscribeInFlight) return;` 才清（反過來會殺死有效重連排程 ⇒ 永久唔再連）。
守衛 `realtime-resubscribe-loop.test.ts`（29 條，含行為模擬＋對照組＋topic 唯一性＋上述兩條）。
🔴 topic 唯一性：`pos-ledger-orders:<merchantId>` 只有兩個消費者（`quick-online-orders-panel` 只喺 `/pos`／`online-orders` 只喺 `/orders`）⇒ **當前路由下唔會同頁**；同 topic 兩條 channel 會互相 `removeChannel` 踩死，一頁只准掛一個。

## 5 訂單／交班
結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱）。`print-xxxxxxxx`＝PrintJob 漏入 orders，已由 `order-id-guard` 擋住。🔴 三軌互不相干：`pos_shifts`（擋收銀台）／`pos_store_status.is_open`（線下）／Ledger `merchant_enabled`（線上）。總掣 `close-gate.ts`＋`close-gate-run.ts`：先線下後線上／線下失敗唔 return／null＝skipped／永不 throw；須排喺 `closeShift()` early return **之前**。🔴 `pos_store_status` 冇 row＝營業中；`pos_shifts` 冇 open row＝未開工（**方向相反**）。

## 6 UI／環境
收銀台＝`/pos`；`/`＝工作台選擇。深連結一律 `/pos?tableId=&orderId=`，**唔准推 `/`**；清 query 用 `replaceState(null,"",location.pathname)`（守衛 `pos-deeplink-path.test.ts`）。KPI 帶固定 5 欄。`button{font:inherit}` 壓過 `text-*` ⇒ 字級寫仔元素。🔴 `npm test`＝`node --test`：唔認 `@/`／`.tsx` ⇒ 可測模組零 import、邏輯與執行分檔。
🔴🔴 **條件式警示卡要「整卡條件 render」，唔可以留空殼**（2026-10-01 教訓）：刪一張卡時，卡內「有價值嘅內容」若係**條件式**（例如「N 張線上單未標記完成」提示＋補推掣），唔應該保留外殼改成中性標題 —— 冇異常時會剩一張**常年空卡**（只有「已計入左邊某某」嗰種廢話），商家會直接問「這又是什麼?」。✅ 正解：整卡連標題一齊條件 render（同 `onlineReconcile.unadoptedCount > 0` 慣例一致）。⚠️ 若真要保留底層邏輯（唔想刪 function），用 `{false ? … : null}` 收埋渲染路徑 ＋ `eslint-disable-next-line` ＋ 明文註解「**有意為之，唔係遺漏**」，避免 ESLint unused 警告變噪音。
🔴 **JSX 內唔可以用 Markdown `**粗體**` 或 `<b>`／`<strong>`**（會原樣顯示／不符慣例）⇒ 用 `<span className="font-semibold">`。`InfoBubble` 氣泡內層係 `<span>` ⇒ 內容只可以用 `<span className="block">` 分行，唔可以放 `<div>`／`<p>`。
🔴 **JSX 屬性位置用 `/* */` 塊註解**（`{/* */}` 只可以喺 children 位置）；`//` 單行註解喺屬性之間會爆語法錯。

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
