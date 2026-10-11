# macauPos 記憶（2026-10-11 精簡）

> 開工前必讀 `docs/113-agent-gotchas.md`；先睇 `pos-task-router` skill。細節→`DETAIL-2026-09.md`。
> POS=`iyrywzormzisyppkokbi`；Ledger=`zymdemjflsckicwcinxl`。0050 已跑；0051–0057 已寫未部署。

## 同步／數字口徑
- 下單機＝本機優先／第二台＝純雲端 state／交班＝LWW／報表＝純雲端永不 merge。實收＝毛＝`agg.paidTotal`。
- 訂單時間唯一真源＝`orderEventInstant()`（settledAt→reopenedAt→originalSettledAt→updatedAt→createdAt）。澳覓單 `created_at` +8h（aomi-bridge）⇒ admin 總覽（created_at 無上限）同報表可差幾張。
- 退款口徑（J 拍板）：交班 2 張資金卡（應收/實收＝線下+線上對稱）；實收大數＝毛，卡內列「退款（線下）−X」＋「淨實收（落袋）」；報表營業額＝淨額 `totalRevenueNetMop`。退款只從線下扣＋標明「Ledger 純線上退款未計入」。⚠️ 兩處 `{false ? …}` 隱藏區有舊文案。
- 交班 `netPaidTotal`（＋未退）vs 報表 `netRevenue`（−退款）方向相反，唔可互抄；要逐張加總對 UI。

## 返結
- 四鐵律：同機正常≠上雲（查 reopen_count）；維持 reopened+keepPaidStatus；reopen_count/at/reason 單調遞增；加 `pos_orders` 欄位要改**四條**讀取路徑（pos-order-mapper／pos-order-row／/api/pos/orders 內聯 mapper／sync baseRecord）。
- temp-reopen 枱只寫本機（`stripReopenTempTables()`）⇒ 跨機返結失聯（J 拍板：桌台總覽另開「返結帳(N)」區塊、整卡條件 render）；`reopenOriginalTableId/Name` 未上雲（未修）。reopened 唔計營業額＝正確口徑。

## 鑑權／Realtime／打印
- `posRouteAuthGuard()` 放 early-return 之後；`POS_REQUIRE_DEVICE_AUTH` 冇設＝開閘；TTL 12h。
- 🔴 anon 時間窗 RLS（pos_orders 72h／pos_print_jobs 24h）係刻意，唔可收緊（三個 Realtime 消費者靠 anon）⇒ 收緊＝出紙 1–3 秒變 180 秒。
- 入隊只准 `appendPrintJobsWithSync()`；`pushEvents()` base 一定要 `loadQueue()`；去重靠 `onceKey`。「本地有 job」帳本 per-瀏覽器 ⇒ 後掛載台會為已出紙線上單再造廚房 job。`/api/pos/state` printJobs 冇 template/content ⇒ 預覽≠出紙。
- Realtime hook 四個同一寫法：subscribe callback 首行 `if (cancelled || channel !== ch) return;`；`await removeChannel` 後必再判 `if (cancelled) return;`；CLOSED 唔可為修迴圈而刪；清 reconnectTimer 前先 `if (subscribeInFlight) return;`；同 topic 一頁只准一條 channel。守衛 `realtime-resubscribe-loop.test.ts`。

## 訂單／交班
- 結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱）。三軌互不相干：pos_shifts／pos_store_status.is_open／Ledger merchant_enabled。pos_store_status 冇 row＝營業中；pos_shifts 冇 open row＝未開工（**方向相反**）。總掣 `close-gate.ts` 排喺 `closeShift()` early return 之前，永不 throw。

## UI／i18n／守衛測試
- 收銀台＝/pos；深連結 `/pos?tableId=&orderId=`，唔准推 `/`；清 query 用 replaceState。JSX 唔好用 `<b>`/Markdown ⇒ `<span className="font-semibold">`。條件警示卡要整卡條件 render。浮層用 `tooltip-placement.ts`（fixed＋JS 定位＋visualViewport）。
- i18n 三層：只有 UI 顯示文案譯；持久化值（tableName/brand/菜品名…）同紙單唔譯。lib 標籤函式（getOrderStatusBadge().label 等）保持純中文，顯示位包 `t(helper(x))`；含動態值字串要 `*Parts()` 回 {key,vars}（BANNED 清單守衛）。ToastPayload.message＝字典 key+vars（兩個 consumer 形狀要一致）。Pill prop 傳原文唔好包 t()。
- 字典錨點＝`indexOf("\r\n};")` **第一個**（lastIndexOf 會中側欄字典）；檔案係 CRLF。守衛 `i18n-layer-guard.test.ts`（49 條）。工具 `tools/_add-i18n-keys.cjs`／`_cjk-audit.cjs`／`_t-keys-missing.cjs`。
- 守衛測試守「行為不變量」唔守代碼字串；唔好斷言「剛好 N 個」；Tailwind 未用過嘅 class 冇 CSS ⇒ 量 bounding box；regex 前 `\r\n→\n`。`node --test` 唔認 @/／.tsx。
- `npm run lint` 本身已紅（tools/ .cjs）；慣例 `npx eslint <指定檔>`。

## Egress／同步機制／版本
- 最大來源＝舊分頁舊 bundle（limit=300）。🔴 唔可用 partial payload 保護舊 client：凡可能令 orders 變空嘅回應，要麼回真資料要麼唔回 200。水位只喺 `Array.isArray(payload.orders)` 推進；增量拉取單腿；orders store 只放 id。
- 版本偵測唔可以加請求 ⇒ 搭 state/sync(30s)/shift(180s) 標頭（`buildJson()`），守衛 `build-header-contract.test.ts`；橫幅只喺 /pos 頁頂。
- pos_sessions(0047)：續期搭 sync(60s)+state(5分)；標頭 x-pos-session/x-pos-build；`account` 唔可以傳空/null（⇒ 全店 401）。

## 庫存／expenseRecorder
- `merchants.name` 全表唯一（J 拍板）；NAME_TAKEN 唔可回 id。設定藏 merchants 表保留名 KV（`__shop_settings__:<uid>`／`__global_settings__`，寫入必 merge；唔可以用 `.not("name","like","__%")`）。支付方式主檔＝expenseRecorder `/admin/payment-methods`；「未設定」vs「空清單」用 Array.isArray 分。
- 門店層設定上雲已修（2026-10-07，三病灶）：`patchLocalSettings()` 加 POST /api/pos/device-config（要 `posDeviceAuthHeadersFresh()`＋推前 `stripReopenTempTables()`＋body 帶完整 deviceConfig+storeId+localSettings）；`needLocalSettings` 用 `!hasPosLocalSettings()`；庫存頁一次性逐欄補值。守衛 `inventory-contract-guard.test.ts`。
- 單位必填（含編輯模式，10-08 拍板）；驗證寫喺 save()，唔用 HTML required；標紅用 `ring-2 ring-red-300` 唔用 border-*。品項建議兩步查詢驗 merchant 歸屬；聚合純函式 `inventory-item-suggestions.ts`（零 import）。
- `GET /api/inventory/master-usage` 只拉 merchant_id、SCAN_LIMIT=1500、唔可以拉 raw_ocr_data。expenseRecorder 要 next@16.3.0 先 build 到。

## 取證
- `isSaleCountable()`：settled／帶 onlineOrderId 嘅 paid，Macau 日界。id 前綴＝建單程式。storeId 係公開值。工具：`tools/log-recheck.cjs --both`、`probe-anon-exposure.cjs`。量度陷阱：Vercel log 按 requestId 去重、逐 agent_id 拆。anon 探測只有 24h 窗。
- 🔴「寫得入」≠「讀得出」：新增欄位入庫＋出庫都要端到端驗證。

## 環境（本機）
- bash/npm/coreutils 已恢復正常（09-24 實測）；jq 冇。`node -e` 寫檔危險（反引號被靜默食）⇒ 用 Write/Edit 或寫 .cjs 再跑。git push 曾因 GCM 掛住，要 push 先試普通 git push。`next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。eslint 逐指定檔跑。診斷頁面殘留要開新 page 再 goto（HMR 會有假殘留）。
