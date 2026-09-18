# macauPos 記憶索引（2026-09-18 更新）

> 必讀 `docs/113-agent-gotchas.md`。POS=`iyrywzormzisyppkokbi`、Ledger=`zymdemjflsckicwcinxl`。已跑 0016/0021/0041§1/**0043**，**未跑 0042**。

## 一、API 鑑權
- 加閘 `posRouteAuthGuard(request, storeId, tag)`，放喺「未配置 Supabase／缺 storeId」early-return **之後**；客戶端 `posDeviceAuthHeadersFresh()`。
- 🔴 `POS_REQUIRE_DEVICE_AUTH` **冇設＝開閘**（空值回 true）。「冇設」≠「關閉」。
- 🔴🔴 2026-09-17 09:26 實測**閘已 enforcing**：匿名打 state/device-config/print-jobs/status/orders 全 401。判閘＝`tools/_probe-auth-state-20260917.cjs`。
- **匿名端點（唔可加閘）**：bootstrap GET、sequence、sync 匿名通道、ledger/member-login、order-lookup、kds/*、print-agent/pair。
- 🔴 開閘擋唔到 DB：`NEXT_PUBLIC_POS_SUPABASE_ANON_KEY` 係公開變數 ⇒ anon 直打 PostgREST 就讀到 pos_orders 近 14 日明細。根治＝per-store token（0041§3 未做）。回歸＝`tools/_probe-anon-scope-20260917.cjs`。
- 簽名金鑰 `resolveSecret()`：POS_DEVICE_TOKEN_SECRET→ADMIN_SESSION_SECRET→SUPABASE_SERVICE_ROLE_KEY，TTL 12h。判簽發＝`POST /api/pos/device-token`（503＝env 缺；401「會話已失效」＝env 正常）。

## 二、DB
- 🔴 migration **唔可用 psql 專屬語法**（`:'var'`/`\set`）。
- 🔴 pos_orders/pos_print_jobs anon policy **冇 store_id 過濾**，唔可就咁加（收銀台/KDS/Hub 用 anon 訂 Realtime ⇒ 靜默失效）。
- ⚠️ pos_print_agents anon 冇 SELECT（42501）⇒ 睇心跳要 service_role。
- 一專案可多 store_id，每店一台中繼機。掃描：`select store_id, count(*) filter (where finished_at is null) from pos_print_jobs group by 1 order by 2 desc;`

## 三、打印
- 建單/接單後必須 `appendPrintJobsWithSync()`；淨 `savePrintJobs()`＝零出紙＋零紅標。
- 出紙只喺**內容事件**（新單/改單/加菜/結帳）；轉換/採納/排位唔出紙。去重靠 `job.orderId`。
- 「改咗但行為唔變」＝冇 re-build／冇擰 versionCode／收銀機載 Vercel 部署。
- `ttl`＝**絕對 epoch ms**；只喺 insert 寫 ⇒ 舊行恆 NULL＝永不過期。
- 0042（未跑）＝claim 分段：同機 6min／跨機 90s（純 90s → 搶自己長單 → 重複出紙）。
- 「重試打印」＝`POST /api/pos/print-jobs/retry`（冪等，成功回 409）；原因碼唯用 `print-job-failure.ts`。
- 🔴 判失敗真因睇 `last_error`：`兩種通道都失敗｜直連：failed to connect to /<印表機IP> from /<中繼IP>` ⇒ 網段不通。`兩種通道都失敗｜…`⇒跑 `print-relay`；`dispatch failed`⇒跑 `macau-ledger-merchant`（`PosJobRunner.kt:247` 硬編碼，源碼 `C:\dev\_ref-macau-ledger-merchant`）。
- 中繼機同印表機須同網段：192.168.31.x＝店內路由器；10.61.x／172.20.10.x＝熱點。
- APK dex 係 DEFLATE ⇒ 掃 .apk 假陰性；要解 zip + `zlib.inflateRawSync`（`tools/_apk-strings.cjs`）。
- ⚠️ 定時炸彈：`print-relay` `fetchDeviceConfig()`（`RelayApi.kt:221`）**冇帶憑證**。
- ⚠️ `/api/pos/sync` 只寫 printer_name/printer_id，`printer` jsonb 從未寫；`claim/route.ts:42` 硬編碼 `printers:[]` ⇒ APK 靠 device-config（60s）攞 IP。
- ⚠️ device-config 缺 storeId 時 early-return **200** ⇒ 唔可用 200 判店存在。`result/route.ts` 寫 failed 冇同時改 status ⇒ 行不一致。

### 中繼配對
- 🔴 `paired:true` 只＝DB 有 agent 列＝歷史事實，唔等於在線；在線睇 `last_seen_at`（~30s）。
- 🔴 `pair-status` 401 ⇒ panel 顯「配對失敗」⇒ 配對流程自停。正解＝**iPad 重新登入**。
- 🔴🔴 「配對失敗：POS 雲端未設定」＝垃圾桶文案。真兇＝`PosPairingManager.kt:65-68` restorePairing 要求 `status=="paired"`，agent 被撤銷⇒永遠回 pending⇒靜默 return false；文案由 `PosRelaySession.kt:219` `?:` 冒泡（三種無關原因同一句）。次序：GET /pair 回 pending⇒App 內重新配對；paired 但兩欄空⇒查 Vercel env；paired 有值⇒查 Ledger 登入態。**唔使改 Vercel／唔使重裝 APK**。
- 🔴 「能 claim」同「配對失敗」可同時為真：claim 唔需 Supabase 憑證，但 `PosRelayClient.init()` 失敗⇒client==null⇒Realtime 從不訂閱，只剩 60s 對賬。
- 🔴 徽章綠（localStorage `pairing`）同紅塊（`state.kind==="failed"`）係兩個獨立 state；`macau-pos-relay-auto-pair-stopped` 落 localStorage 後 reload 都唔重配。
- 🔴 merchant 配對五道防線（`PosPairingManager.kt:13-44`）：POS_URL 空即停／只認 ok:true／storeId≠merchantId 拒／URL 唔可等於 BuildConfig.SUPABASE_URL／url+key 成對非空。
- ⚠️ 「堂食測試印」（`PosRelaySession.kt:146-153`）繞過 runner 直接 sendRaw ⇒ 出紙 ≠ 配對正常。
- 判機死活＝有無 `claimed_by` 非 NULL 行；attempts=0 全 NULL＝從未 claim。
- 🔴 `resolveStoreId()`（`sync-flush.ts:308-314`）＝登入 session 嘅 merchantId；`print-center.tsx:419-424` 用佢叫 pair-status ⇒ banner 可能顯示別店心跳。先確認 iPad 登入邊個 merchantId。
- 🔴 判死活唔可睇 `/prints` 嗰句「N 分鐘前」（前端計算、會膨脹）；要打 `GET /api/pos/print-agent/pair-status?storeId=` 讀 lastSeenAt，對照 pos_print_jobs 最後 claimed_at；兩者同秒停⇒PosJobRunner 死（scope cancel）⇒只需叫醒 App（切前台→重啟→電池不限制＋自啟動）。
- 🔴 爆紙：修通道前必先 `select pos_void_stale_print_jobs('<storeId>')`。attempts>=5 安全（永不 claim）。但回 0 ≠ 清乾淨：0042:140-146 條件 `ttl is not null and ttl<=now` ⇒ **ttl IS NULL 永遠掃唔到**。驗證＝跑前後 `count(*) where finished_at is null and coalesce(attempts,0)<5` 比對。清 ttl=NULL 只可 UPDATE 退路，逐店跑。

### 孤兒單／隔離區
- 🔴 訂單號 `print-xxxxxxxx`＝本機孤兒單（`PosOrder.localOrderNo` 本身壞，建單誤寫 `uid("print")`），在「同步健康檢查」的「已隔離訂單」（`sync-health-modal.tsx:531`），reason `auto-full-pull`。
- 🔴 查雲端 `pos_orders` 掃 `print-%` 必然 0 rows；佢係 localStorage `QuarantinedOrderRow`（`storage.ts:989`），從未上雲。要睇就喺 App 內。
- 隔離三條件（`sync-reconcile.ts:260-264`）＋單齡 ≥10min（`ORPHAN_MIN_AGE_MS`）。上限 200 由最舊剷。
- 🔴 「還原」對孤兒單係陷阱（雲端永遠冇）⇒應「永久刪除」（寫 tombstone）。

## 四、訂單
- 結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱），唔准全店 find()。
- 已收款單加菜必須保留 `paid`，否則雲端拒收整條 ORDER_UPDATED。
- 「RPC 冇拋錯」≠ 遠端已改（`online-dinein-ladder.ts` 無效轉換跳過）。
- 狀態文案：只 pickup/takeaway＝「待取餐」，其餘「待交付」。列枱用 `buildDisplayFloors()`。Ledger 真欄 selected_specs/line_note。

## 四之二、交班／關店（2026-09-18 新增）
- 🔴 **三條互不相干軌道**：班次（`pos_shifts`，只擋收銀台）／線下接單（`pos_store_status.is_open`，擋掃碼+kiosk）／線上接單（Ledger `merchant_enabled`）。`closeShift()` 本身**唔碰**任何接單開關。
- 「關店總掣」＝`src/lib/pos/close-gate.ts`（純決策，**零 import**）＋`close-gate-run.ts`（執行層 `runCloseGate()`）。紀律：序列（先線下後線上）／線下失敗**唔 return**（否則連帶線上永遠關唔到）／`null`＝`skipped`（唔算失敗）／永遠唔 throw。
- 🔴 關店必須排喺 `closeShift()` 嘅**兩個 early return 之前**（`forceSyncBeforeClose` 失敗、`!isPrintContentEnabled("shift")`）——後者**會完成交班**。
- 🔴 **`pos_store_status` 同 `pos_shifts` 嘅 default 方向相反**：前者冇 row＝**營業中**（店主冇主動暫停過）；後者冇 open row＝**真係未開工**（事實記錄）。兩者都係「**查詢失敗**」才 fail-open。
- 🔴 `reason: "shop-closed"`（店主主動關門）同 `"shift-closed"`（未開工/已收工）**唔可撈埋**，客端文案分開（「商家不在營業中」vs「本店尚未開始營業」）。
- 殘留通道警示＝`src/lib/pos/residual-channel.ts`（純函式）。條件＝「一邊已關 + 另一邊仍然開」；**`null`（未讀到）永遠唔觸發**（否則斷網就出假警報）。寄生喺既有 pill（`merchant-open-pill.tsx` 嘅 `residual` prop），唔新增格子。
- ⚠️ 遺留：`/api/pos/store-status` 仍有 `DEFAULT_STORE_ID="macau-store-a"` 假店 fallback（GET 53 行/POST 117-119 行），未收緊。

## 四之三、返結（反結賬）≠ 退款（2026-09-18 新增）
- 🔴🔴 **`reopened` 唔喺任何狀態集合**（`TERMINAL`/`PAID`/`OPEN` 都冇）⇒ 寫 `reopened` 時 `isPaidDowngrade===false` ⇒ 放行。所以「保留 reopened」係正確，**唔可以改成 `paid`**。
- 🔴 `upsertCurrentOrder()` 嘅 `keepPaidStatus` 必須同時認 `paid` **同** `reopened`（`pos-app.tsx:2406`）。只認 `paid` ⇒ 返結單加菜被寫成 `sent_to_kitchen` ⇒ 付款階段單向閘拒收整條 `ORDER_UPDATED` ⇒ **items 永遠上唔到雲**，只剩 `ORDER_SETTLED` 金額 patch（唔重寫 items）⇒ 雲端「舊數量＋新金額」。
- 審計三欄 `reopen_count`/`reopened_at`/`reopen_reason`：**單調遞增、重結後唔清零**（「返結過」係歷史事實）。重結（`confirmPayment` / `settleCompOrder`）**原樣承襲**，唔准清。
- 標籤＝`src/lib/pos/reopen-badge.ts`（**零 import**，6 test）＋`components/reopen-badge.tsx`；判定**只看 `reopenCount`，唔看 `status`**。位置＝緊貼訂單號右側（同「線上」chip 同格）；色＝indigo（同狀態標籤「已返結」同色）。
- 覆蓋 5 面：訂單列表／訂單詳情／收據預覽（`local-orders-panel.tsx`）＋報表／交班明細（共用 `order-detail-list.tsx`）。
- 🔴🔴 **加 pos_orders 欄位要改「四條讀取路徑」**（本專案結構性風險）：`pos-order-mapper.ts`（realtime/KDS）／`pos-order-row.ts`（`/api/pos/state`＝交班）／`/api/pos/orders` **內聯手寫 mapper**（＝報表）／`sync/route.ts` `baseRecord`（寫入）。漏任何一條＝標籤靜默唔出。
- ⚠️ 遺留缺口：`reopenedBy` / `originalSettledAt` **一樣冇上雲**（0043 只做咗三欄）。標籤唔需要佢哋，故暫未補。
- ⚠️ 歷史資料唔會自動回溯：0043 只加欄（default 0），舊返結單雲端 `reopen_count` 仍係 0 ⇒ 標籤唔出。要出就需人手 `UPDATE`（工具 `tools/fix-order02-reopen-20260918.sql`，J 已決定唔用，改為叫商家自行重新返結一次）。

## 五、UI
- 🔴 `button { font: inherit }`（globals.css 無 layer）壓過 `text-*` ⇒ 按鈕字級寫喺仔元素；`p-[3px]` 同 `px-3 py-1.5` 唔可並存。
- 🔴 iPad standalone 撳輸入欄唔彈鍵盤。`print-center.tsx` 有 16 個既有 eslint error。

## 六、環境
- npm/npx 跑唔到；冇 coreutils → 用 Read/Glob/Grep 或 node fs；複雜 JS 寫 `.cjs`。
- 🔴🔴 **`npm test` ＝ `node --test`，唔認 `@/` 別名、唔行 bundler。** 可測模組必須**零 import**（`store-status.ts`、`date-range.ts`、`close-gate.ts`、`residual-channel.ts` 都係）。純邏輯同「有 import 嘅執行層」**一定要分檔**，否則測試即 `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`。
- 跑全測試：`node --test "src/**/*.test.ts"`（傳目錄會 fail，要 glob）。
- git 全路徑 `…/PortableGit/versions/1.2.0/cmd/git.exe`；push 加 `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never`。`.git` 易被沙箱破壞（skill `git-repo-rescue`）。
- 同檔唔可同一 message 發多個 Edit。Glob 唔索引工作區外。
- 🔴 Vercel 改 env 要 Redeploy 才生效。
- ⚠️ eslint 喺本機**極慢**（13 個檔 ≈ 3分48秒）→ 用 `run_in_background`。

## 七、口徑
- 收入 `isSaleCountable()`：只計 settled／帶 onlineOrderId 嘅 paid；日期用 Macau 邊界。
- 雲端讀到＝唯一可信源；store 隔離 `o.storeId === merchantId`。
- 快餐 `isQuickCounterOrder`；線上堂食 `isOnlineDineInOrder`（唔可改闊）／`isPaidDineInOrder`。
- 線上接單＝Ledger `merchant_enabled`／線下＝`pos_store_status.is_open`，唔准同名同色。
- 時間軸一律換算 Macau(+8)（GitHub commit 係 UTC）。

## 八、判別／取證
- 🔴 訂單 id 前綴＝邊個程式建單：`order-`＝收銀台/快餐（source 寫死 pos）／`staff-`＝店員手機／`kiosk-`＝自助機／`ledger-<id>`＝線上單鏡像。收銀台永遠唔出「自助點餐機」徽章。
- 🔴 訂單列表顯示時間＝最後更新，非建立時間；判建立睇 `pos_orders.created_at`。
- 🔴 事件 payload 兩形狀：裸 order vs `{order, addedItems}`；拆解唯用 `src/lib/pos/sync-order-payload.ts`（附迴歸測試），唔准 route 內再寫一份（曾致 6 張線上單 ORDER_CREATED 永久 400）。
- 🔴 `storeId` 係公開值（枱 QR `/menu?tableId=…&store=<merchantId>`）⇒ kiosk（`/order` 手動輸入 storeId）＝無密碼落單入口。
- 🔴 Vercel log CSV 冇 IP 欄，且一請求多行；要 IP 靠 `sync/route.ts:375` `console.info(ip=…)`（只在 auth 開著時執行）。
- 🔴 「按放棄又彈返」＝`sync-flush.ts:558-560` legacy-heal 只排除 failed、唔排除 skipped。
- 關「自助點餐機」模組擋唔到嘢：allowedModules 純 UI 導覽，`/order` 同 `/api/pos/sync` 都唔檢查。
