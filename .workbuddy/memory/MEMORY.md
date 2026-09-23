# macauPos 記憶（2026-09-23 · 已去重壓縮）

> 開工前必讀 `docs/113-agent-gotchas.md`；常見流程已成 8 個 `pos-*` skills（見 Skill 列表）。
> POS=`iyrywzormzisyppkokbi`；Ledger=`zymdemjflsckicwcinxl`。Migration：**0050 已跑**（09-23 09:39）；
> **0051／0052／0053 已寫未部署**。
> ⚠️ 本檔已壓縮：細節／數據表抽到同目錄 `DETAIL-2026-09.md`（規則以本檔為準）。

## 0 訂單時間（唯一真源）
`src/lib/pos/order-event-time.ts` `orderEventInstant()`：reopenedAt → originalSettledAt → updatedAt → createdAt。
predicate ＋ 顯示全委派它（「顯示 updatedAt／篩選 createdAt」曾令同一筆錢計兩次）。
`fetchOrdersInRange()` 三腿（0044 索引）；⚠️ 7d/30d 邊界兩邊未統一。

## 1 數字夾唔埋
四載體：訂單（下單機）＝本機優先；訂單（第二台）＝純雲端 `/api/pos/state`；交班＝LWW；**報表＝純雲端永不 merge**。
商家「實收」＝毛 ⇒ `agg.paidTotal`。🔴 兩頁「淨」反向：交班 `netPaidTotal`（＋未退）vs 報表 `netRevenue`（−退款），
唔可互抄。`originalSettledAt`＝首次結帳永不改。唔可憑「差額合理」落結論，要逐張加總對 UI。

## 2 返結四鐵律
①同機正常≠已上雲（必查 `reopen_count`）②狀態須維持 `reopened`、`keepPaidStatus` 要認 `paid`+`reopened`
（否則加菜變 `sent_to_kitchen` ⇒ 付款閘拒收 ⇒ items 永不上雲）③reopen_count/at/reason 單調遞增
④🔴 加 `pos_orders` 欄位要改四條讀取路徑：`pos-order-mapper.ts`／`pos-order-row.ts`／`/api/pos/orders` 內聯 mapper／
`sync/route.ts` `baseRecord`（漏一條＝靜默唔出）。`reopen-badge.ts` 零 import、只看 `reopenCount`；
`reopenedBy`／`originalSettledAt` 冇上雲。

## 3 鑑權
閘＝`posRouteAuthGuard(request, storeId, tag)`，須放喺 early-return **之後**。
🔴 `POS_REQUIRE_DEVICE_AUTH` **冇設＝開閘**（「冇設」≠「關閉」）。憑證 TTL：POS token／admin session 皆 12h。
🔴🔴 **anon 可讀 `pos_orders`（72h，0041）／`pos_print_jobs`（24h，0021）係「刻意的時間窗 RLS」，唔係漏做，
唔可以移除。** 理由：三個 Realtime 消費者全部用 anon key 訂 `postgres_changes` —— `use-pos-realtime.ts`（收銀台）／
`use-kds-realtime.ts`（後廚）／中繼 APK（`resolveRelayRealtimeConfig()` 派 `SUPABASE_ANON_KEY`）。收緊＝
**一個事件都唔推，而 channel 照樣 SUBSCRIBED（零 error）** ⇒ 列印 1–3 秒退化成最長 180 秒、訂單唔再自動彈。
`0041` 檔頭明文禁止；窗口亦唔可再收短（Realtime UPDATE/DELETE 用 **row 自身 `created_at`** 過 policy）。
`pos_queue_events`／`pos_sessions`／`pos_print_agents`／`pos_device_configs`／`pos_egress_daily` 等 10 張表已 401。
守衛 `src/lib/pos/print-and-order-realtime-guard.test.ts`（**25 條**，同時守 0051／0052／0053）。

### 3b per-store token（09-23 評估；⏭️ 未部署）
⭐ 專案**已有** per-store token：`pos-device-token.ts` 嘅 `pv1`（HMAC、payload 帶 `storeId`、TTL 12h、
簽發 `/api/ledger/login`、續期 `/api/pos/device-token`）。缺嘅只係 **Supabase 認得嘅 JWT**。
🔴🔴 **自簽路已否決**：Supabase 已輪換到**非對稱簽名金鑰（ECC P-256）**，私鑰／shared secret 官方明文**無法取出**。
改行：①（推薦）Supabase Auth 簽發 —— `signInAnonymously()` 攞 `authenticated` JWT，server 用 Admin API 寫
`app_metadata.store_id`（只有 service_role 寫得入）⇒ policy 讀 `auth.jwt() -> 'app_metadata' ->> 'store_id'`；
②完全唔用 JWT（Realtime 只推無敏感信號表，客戶端再走 API）。
6 張 anon 可讀表，5 張可 store-scope；🔴 **`pos_soldout` 例外要保留 anon**（客人掃碼／kiosk 匿名讀，冇身份）。
🔴 四個必守（細節見伴檔 §A）：`supabase-client.ts` 要 `persistSession+autoRefreshToken: true`；
realtime hook 一律喺 `.channel(` **之前** `await ensureRealtimeAuth`（身份係**每條連線**）；
同步 module-level 函式要加 async 包裝＋世代守衛；`0053` 唔可以漏（否則靜默讀唔到 soldout）。
🔴 **驗收閘唔可以用 Supabase log `auth_user`（實測 1,000 筆全 `null`）** ⇒ 用 `pos_sessions.realtime_auth`／
`pos_print_agents.realtime_auth`；**最終判準係功能實測**（秒級彈窗／秒級出紙）。
導入次序（加性）：①政策 → ②Web 帶 JWT（留 anon fallback）→ ③中繼 APK → ④**drop anon（未做、唔可提早做）**。
⚠️ Realtime 授權係「每事件 × 每訂閱者」；**DELETE 事件唔受 RLS 保護** ⇒ client 側靠 payload `storeId` skip 外店嘅
L3 閘唔可以拆。詳見 `docs/reviews/per-store-token-assessment-2026-09-23.md`＋伴檔 §A。

## 4 打印／中繼
🔴🔴 **入隊只准一條路徑 `appendPrintJobsWithSync()`**（09-22 收口；事故時間線見伴檔 §E）。
守衛 `pos-app-queue-base.test.ts`。
🔴 `pushEvents()` base **一定要 `loadQueue()`**；同一 handler 兩次呼叫會用 stale state 冚走前一批（同 `syncNow()` 同病根）
⇒ 雲端單永遠停 `sent_to_kitchen`。`appendPrintJobs()` 同名反轉語義（09-11 `1e08343`）：新版**只寫本機**；
唯一合法用法＝`printKioskReceiptForOrder()`。去重靠 `onceKey`＋`claimOncePrintJobs()`（id 係 randomUUID，按 id merge 攔唔到）；
自動路徑必帶世代（收據 `receipt:${reopenCount}`）。
🔴 `paired:true`＝歷史事實，唔等於在線（看在線用 `last_seen_at`／`pair-status`）。
爆紙：`select pos_void_stale_print_jobs('<storeId>')`（回 0 ≠ 清乾淨）。
APK：TICK 60s；獨立心跳已刪；claim 由 `nextPollMs` 控（60→180s，上限 180s）。
出紙慢三源：`SUGGESTED_CLAIM_MS=180s`／claim 一次最多 5 張／結果回填 8s→30s；叫醒通＝1–3 秒。
🔴 落結論前用**生產 log／DB**核對，唔好憑本機 Kotlin 副本斷定。

## 5 訂單／交班
結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱）。孤兒單號 `print-xxxxxxxx`＝**PrintJob 漏入 orders**
（唔係訂單）⇒ 已由 `order-id-guard` 永久擋住；隔離機制已停用（見 §8），唔存在「還原／永久刪除」呢個抉擇。
🔴 三條互不相干軌道：`pos_shifts`（只擋收銀台）／`pos_store_status.is_open`（線下接單）／Ledger `merchant_enabled`
（線上接單）；`closeShift()` 唔碰任何接單開關。總掣＝`close-gate.ts`＋`close-gate-run.ts`：先線下後線上／
線下失敗唔 return／null＝skipped／永不 throw；須排喺 `closeShift()` 兩個 early return **之前**。
🔴 `pos_store_status` 冇 row＝營業中；`pos_shifts` 冇 open row＝未開工（方向相反）。`residual-channel.ts`：`null` 永不觸發。

## 6 UI／環境（硬性）
🔴 **路由**：`/` ＝統一入口「選擇工作台」；**收銀台係 `/pos`**；`/orders`＝訂單頁。深連結（查看未結堂食單／
返結後跳枱面）一律 `/pos?tableId=…&orderId=…`，**唔准推 `/`**；清 query 用
`history.replaceState(null,"",window.location.pathname)`（唔可以寫死 `"/"`，否則 reload 會跌返選擇頁）。
守衛 `src/lib/pos/pos-deeplink-path.test.ts`。
🔴 `local-orders-panel` 嘅「查看」設計（唔好亂改）：`settled`→收據預覽；冇枱／counter→小窗唯讀；
**未結堂食單→直接跳枱面編輯**。
🔴 KPI 帶固定 5 欄、格數須為 5 倍數 ⇒ 新指標寫入既有格 subtitle。🔴 `button { font: inherit }` 壓過 `text-*`
⇒ 字級寫喺仔元素。
🔴🔴 `npm test`＝`node --test`：唔認 `@/` 別名、唔支援 `.tsx` ⇒ 可測模組零 import、邏輯/執行分檔；
import 鏈用相對路徑＋顯式 `.ts`。跑法：`node node_modules/typescript/bin/tsc --noEmit`、`node --test`。
（其他環境陷阱見用戶級 MEMORY。）Vercel 改 env 要 **Redeploy**。

## 7 判別／取證
`isSaleCountable()`：只計 settled／帶 onlineOrderId 嘅 paid，日期用 Macau 邊界 ⇒ **未結帳單永遠唔會出現喺報表／交班**
（「搵唔到單」最常見嘅誤判）。id 前綴＝建單程式：`order-` 收銀台/快餐／`staff-` 店員手機／`kiosk-` 自助機／
`ledger-` 線上鏡像。列表顯示時間＝最後更新；建立睇 `pos_orders.created_at`。事件 payload 兩形狀 ⇒ `sync-order-payload.ts`。
`storeId` 係公開值（枱 QR `?store=`）⇒ kiosk 手動輸入＝無密碼落單入口。
⭐ 生產取證工具（指令見伴檔 §F）：`tools/log-recheck.cjs --both <vercel.csv> <supabase.csv>` ＋
`tools/probe-anon-exposure.cjs` ＋ 舊有 `tools/_probe-*.cjs`（唯讀）。
🔴 **三個量度陷阱**：① Vercel **一行 `console.log` = 一行 CSV**（同一請求共用 `requestId`）—— 實測 160 行＝
**只有 60 個唯一請求**，唔去重會高估 2.7 倍 ② 兩份 log 窗口通常唔重疊，只可比**速率**唔可逐項對質 ③ CSV 有引號內換行，
唔可以 `split('\n')`（1,220 行 → 實際 1,000 筆）。
🔴 多部中繼機混算 claim 間隔會被腰斬（2 部各 180s → 混算中位 94s）⇒ **一定逐 `agent_id` 拆開睇**。
Vercel log 冇 IP ⇒ route 內 `console.info(ip=…)`；時間換 Macau(+8)。真瀏覽器驗證用 `localhost`（唔可 127.0.0.1）。

## 8 Egress／版本／同步
計費＝Supabase → Vercel Function。⭐ 最快取證＝解析 Vercel `[egress]` 行（`tools/_egress-*.cjs`）。
最大來源＝**舊分頁跑舊 bundle**（903KB ⇒ 690MB/h；新版 412KB）⇒ 要「少拉」唔係「拉細」。
指紋：`limit=300`＝舊、`limit=0`＝新。⚠️ Supabase CSV 匯出上限 1000 行。
🔴🔴 **唔可以用「partial payload ＋ 一個新欄位」去保護舊 client**（09-22 P0b）：舊 client **唔會睇個新欄位**。
凡「可能令 `orders` 變空」嘅回應路徑，必須**要麼回真資料（至少未結帳單），要麼唔回 200**。實案：`legacyThrottled`
回空骨架 → 舊 bundle 照跑孤兒對賬 → **本機所有未結帳單被移入隔離區**（列表清空、每 3 秒重演）。已修。
🔴 **上游永遠係「仲有一部機跑舊 bundle」**：`[egress]` 見 `mode=legacyThrottled` 或 `[pos/state] 🔴 疑似舊版 bundle`
⇒ 即刻叫佢重新載入。
🔴 舊 bundle 冇 `skipped/server-newer` 終態 ⇒ 確定性拒收（stale／降級）**無限重推**（實測 924 行 warn／45 秒、77 張單）
＝ log 洗版＋持續 egress。**唔好手動重跑 migration。**
🚫 **「隔離」機制已整組停用**（09-22 商家拍板）：本機訂單**一律保留**直到 sync 上雲；舊隔離區由
`restoreAllQuarantinedOrders()` 開頁自動還原（垃圾直接丟棄）。
🔴 唔可以用 **partial payload**（空骨架／增量差量／投影子集）斷定「雲端冇呢張單」再刪本機資料。
🔴 `orders` store 只准放訂單 id：`loadOrders()` 過 `@/lib/pos/order-id-guard`（黑名單 `print-`/`evt-`/`q-`）。
實案：隔離區 111 張 `print-xxxxxxxx`（**PrintJob 漏入 orders**）＋ A03 枱卡「閃一下」消失。
🔴 增量水位只可以喺 `Array.isArray(payload.orders)` 時推進（否則失敗／降級回應會**永久漏單**）。
🔴 增量拉取保持**單腿零額外查詢**（兜底腿已移除）。
已落實清單／事故時間線見伴檔 §C／§D／§E。
🔴 兩道 server 閘刻意 fail-open；`urgent:true` 唔可擋。版本：`build-info.ts`（`NEXT_PUBLIC_BUILD_ID` 逐字面寫
`process.env.X`）；`x-pos-build` 標頭；只提示唔自動 reload。
✅ `build-stale-banner.tsx`／`pos-app-stale-banner.test.ts` 已上線；🔴 配套排版（外層 flex→flex-col、
根 `h-[100dvh]`→`min-h-0 flex-1`）唔改底部會被裁切。🔴 量度：唔可用全窗口平均 ⇒ 用 gap>20s 分段。

## 9 POS 工作階段
表 `pos_sessions`（0047）／註冊 `/api/ledger/login`／續期搭既有請求（`/api/pos/sync` 60s、`/api/pos/state` 5 分鐘；
**GET 只續期唔建立**）／client 標頭 `x-pos-session`＋`x-pos-build`。🔴 key 存 `sessionStorage`。
管理頁 `/admin/sessions`；強制關閉＝軟踢（只擋新生意、結帳放行）；門檻：使用中 ≤6 分／閒置 ≤30 分。
🔴🔴 **`account` 會被寫死值覆寫（09-23 發現）**：`/api/pos/device-token/route.ts:71` 硬編碼
`account: "ledger-session"`；`sync`／`state` 用 `deviceClaims.account` 餵 `touchPosSession()`，而
`session-registry-server.ts:215` `if (input.account) patch.account = input.account` **無條件覆寫** ⇒ admin 頁
「員工／裝置」由真電話變成 `ledger-session`、按電話搜尋失效。**只影響顯示／審計，唔影響授權**
（`claims.account` 從未參與授權判斷；授權靠 `storeId`＋簽名＋`exp`）。
✅ **已修（09-23 13:35）**：改用 `parsePhoneFromLedgerAuthEmail(user.email)`＋非空兜底（`|| email || uid:…`）
—— 🔴 `verifyPosDeviceToken()` 拒收空 `account`，故**唔可以**改傳 null（會令全店續期 401）。
守衛 `session-identity-guard.test.ts`（6 條，掃碼前要剝註解）。
⚠️ **唔係迴歸**：寫死值自 09-10 已在，09-22 才有 `pos_sessions` 顯示 ⇒ 症狀＝「**登入後正常，
跨過 12h TTL 就一定變 `ledger-session`**」（唔會自復原）—— 睇落似突然壞，其實係定時炸彈。
判別：存活 <12h 仍顯示電話。
⏭️ 未做：`pos_shifts` Realtime 訂閱、print-agent 配對驗真補 env、`pos_print_jobs.kind`、同日重複單號（訂單27 ×2）、
「同步健康」顯示舊 bundle 可見警告。

## 10 下載入口／版本控制（09-23，0050 已跑；全文 `docs/146-app-download-version-control.md`）
表 `pos_release_versions` ＋ bucket `macauposapk`（public，POS 專案）。`/login` 按 UA 出「下載 APK」（Android）／
「下載安裝包」（desktop）→ 公開 API `/api/release/versions/active`（免登入）。admin 頁 `/admin/versions`
＋`/api/admin/release-versions`（GET/POST/PATCH/DELETE）。核心 `release-core.ts`（**零 import**）。
🔴 **每平台最多一個 active ＝ partial unique index**；切換走 RPC `pos_activate_release_version`（先落閘後上位），
**唔可以**喺 route 分兩條 update。
🔴 **base URL 唔可以 fallback 去 `NEXT_PUBLIC_SUPABASE_URL`**（＝Ledger，冇 `macauposapk`）⇒ 派 404 死 link 而**零 log**。
次序：`RELEASE_DOWNLOAD_BASE_URL`→`SUPABASE_URL`→`NEXT_PUBLIC_POS_SUPABASE_URL`→`null`。砌路徑要**逐段 encode**。
🔴 DTO 分開 `downloadUrl`（解析後）／`explicitDownloadUrl`（DB 原值）——admin 編輯表單用後者，否則「由路徑砌」會被寫死。
🔴 裝置偵測要喺 `useEffect` 做（SSR 冇 navigator ⇒ hydration mismatch）；偵測失敗／冇 active 版本一律**靜默唔出按鈕**。
iPhone／iPad 刻意歸 `desktop`；新版本預設**唔 active**。
🚫 **冇檔案上傳 UI ＝ 商家 09-23 明確決定**（只要「喺頁面管理 link」，檔案自己經 Supabase Dashboard 放）。
**唔係漏做，唔好自作主張加**（真要做要先解決 Vercel body 4.5 MB 上限＋Supabase 免費層 50 MB）。刪版本唔刪 Storage 檔案。

## 11 egress 現況（09-23 覆核，關店時段）
✅ 舊分頁大戶消失（`legacy=1`／`queue=300`／`limit=300` 全部 0 次）；`pos/state` 單次 34,989 B；claim 中位 180s；
stale 拒收 924 行 → 79 行。**下一個下手位＝待機 2.17 請求/分（79% 係中繼機「輪詢三角」⇒ 可合併成 1–2 round trip）**。
⚠️ `incr=1`／`orders=0` 下 `pos/state` **仍回 35 KB 全量 config**（觸發源＝realtime 每 11.8 分鐘重連）
⇒ resubscribe 路徑應帶 `?fields=`。⚠️ **未喺「營業中開 POS」窗口覆核**。
數據表／細節見伴檔 §B；報告 `docs/reviews/recheck-2026-09-23-egress-and-relay.md`。
