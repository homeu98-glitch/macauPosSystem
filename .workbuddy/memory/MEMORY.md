# macauPos 記憶（2026-10-07 · 精簡版）

> 開工前必讀 `docs/113-agent-gotchas.md`；流程已成 `pos-*` skills（先睇 `pos-task-router`）。
> 細節／數據／時間線 → `DETAIL-2026-09.md` §A–§H。**本檔只放「唔可以違反嘅規則」。**
> POS=`iyrywzormzisyppkokbi`；Ledger=`zymdemjflsckicwcinxl`。0050 已跑；0051–0057 已寫未部署。

## 0 訂單時間（唯一真源）
`order-event-time.ts` `orderEventInstant()`＝settledAt→reopenedAt→originalSettledAt→updatedAt→createdAt。篩選＋顯示全委派它。雲端冇 `original_settled_at` ⇒ 舊單靠 `updated_at` ⇒ 🔴 週期性推前 `updated_at` 會令單**跨日漂移**。`fetchOrdersInRange()` 四腿（0044／0057）。

## 1 數字夾唔埋
下單機＝本機優先／第二台＝純雲端 state／交班＝LWW／**報表＝純雲端永不 merge**。實收＝毛＝`agg.paidTotal`。🔴 交班 `netPaidTotal`（＋未退）vs 報表 `netRevenue`（−退款）方向相反，唔可互抄；要逐張加總對 UI，唔可憑「差額合理」落結論。
🔴 admin 總覽用 `created_at`（`.gte` **冇上限**），報表／交班用 `orderEventInstant()` ⇒ 同一日可差幾張。真兇＝**澳覓單 `created_at` 被 +8h**（`aomi-bridge.js` 傳本地時間字串 → `grabber-order.ts` 直寫 `timestamptz`）。判別：`settled_at` 早過 `created_at` ＝資料錯，此時**報表嗰邊才對**。
🔴🔴 **退款口徑（J 拍板）**：交班頁資金卡 **2 張**（應收／實收，都係線下＋線上，範圍對稱）；實收大數＝**毛**，卡內方框只列「退款（線下）−X」＋「淨實收（落袋）」。報表頁營業額大數改**淨額** `totalRevenueNetMop` ＝ 線下收款 − 退款 ＋ 線上收款，線下分拆同步扣退款。
🔴🔴 **Ledger 側完全冇退款資料源**（`LedgerOrderRow` 冇退款欄，`refunded_amount` 只在 POS `pos_orders`）⇒ 線上退款 POS 睇唔到；唯一見到嘅線上退款本身已計入線下。✅ **退款只從線下扣** ＋ UI 標明「Ledger 純線上退款未計入」。⚠️ 兩處 `{false ? …}` 隱藏區含**舊文案**，還原前必須先更新。

## 2 返結四鐵律
①同機正常≠已上雲（查 `reopen_count`）②維持 `reopened`＋`keepPaidStatus` ③reopen_count/at/reason 單調遞增 ④🔴 加 `pos_orders` 欄位要改**四條**讀取路徑（`pos-order-mapper`／`pos-order-row`／`/api/pos/orders` 內聯 mapper／`sync` `baseRecord`）。
🔴🔴 **跨機返結失聯**：`createReopenTempTable()` 嘅 temp 枱**只寫本機**，上 server 時刻意 `stripReopenTempTables()` 剝走 ⇒ 另一部機冇重結入口。J 拍板＝桌台總覽另開「返結帳（N）」區塊、唔依賴枱、整卡**條件 render**。
🔴🔴 同一病灶第二 bug（未修）：`reopenOriginalTableId/Name` **冇上雲** ⇒ 跨機重結唔還原原枱，單永久卡 `temp-reopen-xxx`。修＝加 migration ＋ 改四條路徑。
✅ `reopened` 唔計營業額係**正確口徑**，唔好當 bug 亂改。

## 3 鑑權
閘＝`posRouteAuthGuard()`，須放喺 early-return **之後**。🔴 `POS_REQUIRE_DEVICE_AUTH` **冇設＝開閘**。TTL 12h。🔴🔴 anon 讀 `pos_orders`(72h)、`pos_print_jobs`(24h) 係**刻意時間窗 RLS**，不可移除／收短（三個 Realtime 消費者靠 anon 訂 `postgres_changes`；收緊＝零事件但照 `SUBSCRIBED`）⇒ 出紙 1–3 秒變 180 秒。

## 4 打印／中繼
🔴🔴 入隊只准 `appendPrintJobsWithSync()`；`appendPrintJobs()` **只寫本機**。`pushEvents()` base 一定要 `loadQueue()`。去重靠 `onceKey`（id 係 randomUUID）。`paired:true`≠在線。爆紙用 `pos_void_stale_print_jobs()`。落結論前用生產 log／DB 核對。
🔴🔴 **「本地有 job」帳本全部 per-瀏覽器** ⇒ 多終端同時開，後掛載嗰台會為已出紙嘅線上單**再造廚房 job**（商家口徑「寧多一張」）。根治＝補印前喺伺服器按 `order_id` 查 `pos_print_jobs`。
🔴 `/api/pos/state` printJobs 映射剝走 `template`／`content` ⇒ 該類 job 預覽落兜底分支。**預覽唔等於出紙**。

## 4.5 Realtime 重連（四個 hook 同一寫法）
🔴🔴 **subscribe callback 第一行一定要有**：`if (cancelled || channel !== ch) return;`。移除舊 channel 前**先清空變數**。
病（2026-09-27 配額事故）：`subscribe()` 開頭自己 `removeChannel(舊)` ⇒ supabase-js 對舊 channel 送 `CLOSED`，四個 hook 都當斷線 ⇒ 死循環，一台 iPad 一日約 **1,980 次** `list_merchant_orders`。**回前景一次就循環到關頁。**
🔴「先清空變數再 await」**治洩漏唔治回授**。🔴 `CLOSED` **唔可以**為修迴圈而刪。🔴 `await removeChannel` 之後**一定要**再判 `if (cancelled) return;`。🔴 清 `reconnectTimer` 順序＝先 `if (subscribeInFlight) return;` 才清。🔴 同 topic 兩條 channel 會互相踩死，一頁只准一個。守衛 `realtime-resubscribe-loop.test.ts`。

## 5 訂單／交班
結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱）。🔴 三軌互不相干：`pos_shifts`／`pos_store_status.is_open`／Ledger `merchant_enabled`。總掣 `close-gate.ts`＋`close-gate-run.ts`：先線下後線上／線下失敗唔 return／null＝skipped／永不 throw；須排喺 `closeShift()` early return **之前**。🔴 `pos_store_status` 冇 row＝營業中；`pos_shifts` 冇 open row＝未開工（**方向相反**）。

## 6 UI／環境
收銀台＝`/pos`；深連結一律 `/pos?tableId=&orderId=`，**唔准推 `/`**；清 query 用 `replaceState(null,"",location.pathname)`。KPI 帶固定 5 欄。`button{font:inherit}` 壓過 `text-*` ⇒ 字級寫仔元素。🔴 `npm test`＝`node --test`：唔認 `@/`／`.tsx` ⇒ 可測模組**零 import**。
🔴🔴 **條件式警示卡要「整卡條件 render」**，唔可以留空殼（冇異常時會剩常年空卡）。要保留底層邏輯用 `{false ? … : null}` ＋ eslint-disable ＋ 註解。
🔴 **JSX 內唔可以用 Markdown `**` 或 `<b>`/`<strong>`** ⇒ 用 `<span className="font-semibold">`。`InfoBubble` 內層係 `<span>` ⇒ 只可用 `<span className="block">` 分行。🔴 JSX 屬性位置用 `/* */` 塊註解。
🔴 **氣泡／浮層唔可以靠 CSS class 死定位**：KPI 卡右上角嘅提示球向右伸展會出界（2026-10-07 實拍）。已抽純函式 `src/lib/pos/tooltip-placement.ts`（`computeTooltipPlacement()`，先水平後垂直：預設→翻→夾）＋ `InfoBubble` 用 `position:fixed` + JS 算 `left/top/maxWidth/maxHeight`；範圍讀 `visualViewport`（唔係 `innerHeight`）＋ safe-area 探針。守衛 `tooltip-placement.test.ts`（含網格掃描不變量）。

### 6.1 守衛測試設計（2026-10-07 血淚）
🔴🔴 **守「行為不變量」，唔好守「代碼字串」**。寫死整句代碼 ⇒ 無害重構就爆，真正壞掉時反而可能唔爆。✅ 改為逐欄／逐行為檢查。
🔴 唔好斷言「**剛好 N 個**」⇒ 守「每個寫入點都有就夠」。
🔴 **Tailwind 只為「實際用過」嘅 class 生成 CSS** ⇒ 首次用某 utility 會完全冇 CSS、元素原樣顯示、零 error。✅ 要**量實際 bounding box**。
🔴 **檔案係 CRLF**：多行 regex 前要**先 `replace(/\r\n/g,"\n")`**。
🔴 抽函式體唔可以「搵第一個 `{`」⇒ 由宣告處逐個試配對、**取內容最長者**。門檻唔可以太細。

### 6.2 i18n（英文版）三層分離（2026-10-08 修正）
🔴 只有**第 1 層**（UI 顯示文案）翻譯。**第 2 層**（持久化資料值：`tableName`／`zoneId`／打印機 `brand`／付款方式名／店名／菜品名／枱號區名）**絕對唔譯**。**第 3 層**（實體紙單）**唔跟 UI 語言**。
🔴🔴 **真正不變式唔係「資料值唔可以做字典 key」，而係「唔好將 `t()` 套用喺會流入持久化／打印嘅值上面」。** 「雙用值」（`堂食`／`自取`／`外賣`／`快餐`／`訂單`／`免單`／`已完成`／`收銀` …）**同時**係字典 key **同**持久化值，係合法嘅。守衛用可執行嘅全 `src/` 掃描：`/\bt\(\s*[^,()]*\.(tableName|paymentMethod|brand|zoneId)\b/`（🔴 用 `[^,()]*`，`[^)]*` 會對 placeholder 插值假報）。
🔴 `src/lib` 嘅**純顯示 helper**（`orderSourceLabel()`／`describePosRealtimeProbe()`）：**lib 保持純中文**（可照做 unit test），喺**顯示位**包 `t(helper(x))`。改 lib 回傳英文會連**未做 i18n** 嘅 KDS 螢幕一齊變英文。同一個 helper 有未翻譯消費者時，只喺已翻譯嘅消費者包。
🔴 **`t` 係 `useCallback([lang])`** ⇒ 切語言時係另一個 function。喺 `useEffect(…, [])` 用 `t` 兩邊都錯 ⇒ 用 `tRef`（`const tRef = useRef(t); useEffect(() => { tRef.current = t; }, [t]);`）。
🔴🔴 **字典插入錨點**：兩個字典檔各有 **3 個** top-level object（`EN_DICT` → `SHORT_EN_DICT` → `SIDEBAR_EN_DICT`）。用 `indexOf("\r\n};")`（**第一個** = 主字典）；用 `lastIndexOf` 會靜靜落咗**側欄字典**（守衛 `#33`／`#44` 捉到）。落盤後驗：`grep -n "^export const\|^};"` 對行號範圍。字典檔係 **CRLF**。
🔴 **`clip: []` 捉唔到「細 toast 撐高」**（`fixed` 浮層超出係正常）⇒ **11px 級提示文案，英文目標 ≤70 字**。
🔴 未定政策：`orders-hub.tsx` 嘅 `downloadCsv()` 表頭／值暫定**唔譯**（匯出文件 ≈ 第 3 層，商家對帳用）——**動之前要問用戶**。
🔴🔴 **標籤層標準做法**：`src/lib` 嘅標籤函式（`getOrderStatusBadge().label`／`getPaymentBadge().label`／`localOrderStatusLabel()`／`quickCompletionLabel()`／`orderSourceLabel()`／`describePosRealtimeProbe()`）**一律保持純中文**（語言無關、可單測），由 consumer 喺**顯示位**包 `t(helper(x))`。原因：同一個 `.label` 同時餵畫面（要譯）**同** CSV 匯出（唔譯）⇒ 改 lib = 兩邊一齊變。
🔴 動態標籤（`t(badge.label)`）靜態掃描睇唔到 ⇒ 有守衛 `🔴 訂單狀態／付款徽章標籤`。⚠️ `quickCompleteLabel()`（已交付/已取餐/已完成）係**持久化 payload**，唔可以當顯示標籤。
🔴🔴 **最隱蔽嘅漏譯：`t()` 一個「已填值」字串。** helper 回 `取餐碼 005`（已填值），字典 key 係 `取餐碼 {code}`（模板）⇒ 永遠唔相等，`lookup()` 靜靜 fallback 中文（唔 throw、唔報錯、測試全綠）。同類：`scheduledPickupRelativeText()`（`18 分鐘後`）、`autoAcceptToast().message`。**解法 = 加 `*Parts()` 回 `{ key, vars }`，顯示位 `t(parts.key, parts.vars)`，舊函式由 parts 砌返（DRY）。** 已有 `orderCodeLabelParts()` / `scheduledPickupRelativeParts()`。判斷法：回傳字串**含動態值**就唔可以直接餵 `t()`；純固定字串（`ledgerStatusLabel`/`tabLabel`/`kitchenHintText`）冇事。守衛 `🔴 唔可以 t() 一個「已填值」字串`（`BANNED` 清單，新增同類 helper 要自己補）。
🔴 **`ToastPayload.message` 係字典 key（＋`vars`）**，唔可以係砌好嘅句子。兩個 consumer 翻譯時機唔同：`pos-app.tsx` 存**已翻譯**（顯示位 `{toast.message}`），`online-orders.tsx` 存**原文**（顯示位 `{t(toast.message, toast.vars)}`）⇒ 改 payload 形狀兩邊都要跟。
🔴 **Pill 嘅 prop 係字典 key**：`MerchantOpenPill`/`AutoAcceptPill` 內部已 `t(label)`/`t(enabledLabel)`/`t(busyHint)` ⇒ call site **傳原文**，唔好包 `t()`（雙重翻譯；zh 睇唔出、en 靠 fallback 僥倖）。收尾 `grep 'label={t('` 應該冇命中。
🔴 **`i18n-layer-guard` 有假守衛**：舊「紙單 label 唔准入 UI 字典」硬編 8 個字串（含 `菜品明細`）——但 `菜品明細` 係 `escpos-template.ts` 區塊名（只喺 print-center 設定頁顯示，`escpos-render.ts` 冇印過）＋ `online-orders` 彈窗標題；而真印上紙嘅 `總計`/`折扣`/`服務費` 本身已喺字典 ⇒ 前提同現實矛盾。已改成守真不變量：`escpos-render.ts`/`escpos-template.ts`/`receipt-ticket-preview.tsx` 一律唔可以 import `lang-provider`/`i18n-dict`/`useT`。
🔴 `setToast("…")` 存嘅係字典 key，render 期 `t(toast)` ⇒ ① render 位一定要包 `t(toast)`；② 每個字面值要入字典；③ template literal toast 要手動合併 `t("… {n}", {n})`。
🔴 `pos-order-filters.ts` 嘅 `default: String(order.status)` 同 `localOrderStatusLabel` 尾行 `return order.status` 會漏**原始英文 enum** 出畫面（加新 status 要記得補 case）。
工具：`tools/_wrap-t-{ast,jsxtext,jsstr}.cjs`（三支 codemod，`EXCLUDE_BY_FILE` 係 **per-file** 行號地雷表）、`_apply-map.cjs`（template 對照）、**`_add-i18n-keys.cjs`（加字典 key 唯一正確入口：`indexOf` 第一個 `"\r\n};"` + 寫入後自我驗證位置；唔好用 `lastIndexOf` —— 會中側欄字典）**、`_gen-i18n-batch.cjs`、`_t-keys-missing.cjs`（兼報動態 key）、`_cjk-audit.cjs`（strip 註解＋已包 `t()` 後列出仍含中文嘅行）、`_check-keys.cjs`（加 key 前睇 coverage）。權威守衛 `src/lib/i18n-layer-guard.test.ts`（**49 條**）。
🔴 手改批次腳本（`tools/_online-orders-*.cjs` 等）嘅**多行 old/new 一定要先 `\r\n → \n` 比對、寫入前轉返** —— 字典同元件檔都係 CRLF。
🔴 **同一條 message 唔好同時放兩個 Edit 呼叫**（同一個檔會 race，後寫嘅會靜靜覆蓋前一個）⇒ 同一檔嘅多處改動一律寫入一支 assert 命中次數嘅 script。
🔴 診斷頁面殘留要**開新 page 再 `goto`**；靠 HMR 會攞到半新半舊嘅 render（會見到假殘留）。`tools/_probe-orders-cjk.mjs` 可以 dump「含中文嘅葉節點＋className」定位係邊個元件。
🔴 `npm run lint`（bare `eslint`）**本身已紅**：`tools/` 144 個 tracked `.cjs` 撞 `no-require-imports`。專案慣例係 `npx eslint <指定檔>`。

## 7 判別／取證
`isSaleCountable()`：只計 settled／帶 `onlineOrderId` 嘅 paid，Macau 日界。id 前綴＝建單程式。`storeId` 係公開值。⭐ `tools/log-recheck.cjs --both`、`probe-anon-exposure.cjs`。🔴 量度陷阱：Vercel 一行 log＝一行 CSV 且倍數可變 ⇒ 按 `requestId` 去重；多部中繼機混算會被腰斬 ⇒ **逐 `agent_id` 拆**。🔴 anon 探測只有 24h 窗 ⇒ **睇唔到跨日行**，唔可據此斷定「DB 冇呢一行」。

## 8 Egress／版本／同步
最大來源＝舊分頁跑舊 bundle（`limit=300`）⇒ 要「少拉」唔係「拉細」。🔴🔴 唔可用 partial payload 保護舊 client：凡可能令 `orders` 變空嘅回應，**要麼回真資料、要麼唔回 200**。🔴 水位只可喺 `Array.isArray(payload.orders)` 時推進；增量拉取保持**單腿**。`orders` store 只准放訂單 id。🔴 版本偵測**唔可以加請求** ⇒ 搭 `state`／`sync`(30s)／`shift`(180s) 回應標頭（`buildJson()` ），守衛 `build-header-contract.test.ts`；橫幅只喺 `/pos` 頁頂。

## 9 POS 工作階段
`pos_sessions`(0047)；續期搭 `sync`(60s)＋`state`(5 分)；標頭 `x-pos-session`／`x-pos-build`；key 存 `sessionStorage`。🔴 `account` **唔可以**傳空/null（⇒ 全店 401）。

## 10 庫存／帳目（expenseRecorder 跨專案）
🔴🔴 `merchants.name` 有**全表唯一**約束（`supabase_schema.sql:7`）＝供應商 duplicate key 根因。J 決定保持全表唯一，POS 端只做優雅提示（`ALREADY_EXISTS` 自動選用／`NAME_TAKEN` **唔可回 id**）。
🔴 expenseRecorder 設定偷藏喺 `merchants` 表用保留名 KV（`__shop_settings__:<uid>`／`__global_settings__`，內容放 `address`）。真實供應商名唔會 `__` 開頭 ⇒ 一律濾走（**唔可以用 `.not("name","like","__%")`**：SQL `_` 係通配符）。`__global_settings__` 一條列裝多 key ⇒ 寫入**一定要 merge**。
🔴 支付方式主檔＝expenseRecorder `/admin/payment-methods`；POS 讀 `GET /api/inventory/payment-methods`，`scope` 分 purchase/checkout/both。**「未設定」vs「空清單」用 `Array.isArray` 分**。
🔴 `normalizePosLocalSettings()` 逐欄重建 ⇒ 新欄位漏白名單會被**靜靜剷走**。
🔴 **「庫存・設置」係彈窗**：5 chips **多選**、最少開一個、**冇「保存」按鈕**（即時寫入）；「支付方式顯示」唯讀。顯示次序存 `invSupplierOrder`／`invCategoryOrder`／`invUnitOrder`（**用名做 key**），純函式喺 `inventory-order.ts`（零 import）。新項目排最後。
🔴 篩選 chips 零筆數嘅唔可以刪 ⇒ 收喺「＋N 個未用過」展開器，當前選中嘅唔准收埋。
🔴 同一元件兩處 render＝兩個獨立 state，要 `onMutated` ＋ `key={productsVersion}`。
✅🔴🔴 **門店層設定（品類／單位／排序）上雲已修（2026-10-07）**。三個病灶，**任何一個未修都會呈現為「已保存但另一台機睇唔到」**：
① `patchLocalSettings()` 只寫 localStorage ⇒ 已加 `POST /api/pos/device-config`（**必須** `posDeviceAuthHeadersFresh()` ＋ **推前 `stripReopenTempTables()`**，唔剝會令返結暫存枱永久變真枱；body 要 `{...deviceConfig, storeId, localSettings}` —— 只送 `{storeId, localSettings}` 會令 `device_id` 變 null 而炸；失敗只 warn 唔 throw）。
② `device-settings.tsx` 原本 `needLocalSettings = !cachedLocalSettings` 係**死條件**（`loadPosLocalSettings()` 永遠回 normalized 物件、唔會 null）⇒ 永遠唔採用雲端。✅ 改 `!hasPosLocalSettings()`（raw key）。🔴 唔可以用 `adoptedFromDb` flag 代替：雲端只有 deviceConfig 時會令 guard 恆 false ⇒ 每次 render 重複打 API。
③ ②嘅閘只覆蓋**全新裝置** ⇒ 庫存頁另加一次性雲端補值：**逐欄只補空、絕不覆寫**，本地齊全時**零請求**（唔增日常 egress），唔經 `patchLocalSettings`（避免兩台互推）。
守衛 8 條喺 `inventory-contract-guard.test.ts`（已做「改壞→紅燈→還原」反證）。
🔴 `GET /api/inventory/master-usage` **只拉 `merchant_id`**、`SCAN_LIMIT=1500`、lazy；**唔可以拉 `raw_ocr_data`**（mg 級 egress）。
🔴🔴 **品項建議（新增收據）按供應商過濾（2026-10-08）**：`GET /api/inventory/receipt-items` 加 optional `merchantId`，**兩步查詢**＝先 `merchants(id,user_id)` 驗歸屬（唔驗＝可讀其他店進貨史）→ `receipts(merchant_id)` 取 id（cap 200）→ `receipt_items(...).in("receipt_id", ids)`；回傳加 `unit`（＝最近一次 `quantity_unit`）。**唔用 PostgREST embedding**（唔賭 FK 偵測）。聚合純函式喺 `src/lib/inventory-item-suggestions.ts`（**零 import**，可被 `node --test` 直接測）。
🔴 前端（`inventory-view.tsx` `ReceiptFormModal`）：per-supplier 快取 `scopedItems{key,items,ready}`；**已揀供應商時唔准 fallback 落全店清單**（loading 都唔准，否則閃出無關品項）；零歷史 ⇒ 空狀態 ＋「顯示全部品項」逃生門（改供應商即重置）。`applySuggestion` 帶入單位，**只喺空白時**（同單價口徑）。
🔴🔴 **單位由「選填」改「必填」（2026-10-08 J 拍板，推翻 10-07 決定，且含編輯模式）**：六個必填＝供應商／品項／數量／單位／付款方式／付款狀態。驗證**一律喺 `save()` 明文寫**，**唔可以用 HTML `required`**（modal 唔係 `<form>`，原生 required 根本唔觸發；守衛會掃 `CUSTOM_UNIT` 後 2600 字內有冇 `required`）。逐欄標紅用 `ring-2 ring-red-300`，**唔可以用 `border-*`**（同 `fieldCls` 嘅 `border-slate-200` 係同一 property，勝負睇產生次序）。數量驗證唔可以靠 `Number(x) || 1`（空字串會靜靜變 1）。
🔴 守衛測試寫 regex 時：**`/,/g` 唔可以塞入 regex literal**（會令整個測試檔 lexing 爆 `Expected ',', got '<lexing error>'`）⇒ 改用 `view.includes('...')` 字串比對。
🔴 expenseRecorder `next@16.2.9` 安裝不完整 ⇒ 本機 build 必掛；要 `npm i next@16.3.0`。

## 11 交班頁庫存支出
🔴 列印單早已有買貨成本，零改動（`escpos-template.ts` `section_purchase`／`purchase_paid` 預設可見）。紙單印「今日買貨成本（已付）：MOP 0」＝當日真係冇已付收據，**唔係 bug**。
🔴 **「已付支出」係獨立參考數**，唔可以同「應收／實收」加減。三卡同行用 **`lg:grid-cols-3`**（md 級要疊放）。
🔴 `purchaseToday` **唔喺 `pageReady` 閘內** ⇒ 唔可以做 loading 判斷，null ⇒ 出空狀態。🔴 未付支出**一律唔顯示**（J 拍板），資料照抓。
