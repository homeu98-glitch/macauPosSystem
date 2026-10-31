# macauPos 記憶（2026-10-20 精簡）

> 開工前睇 `docs/113-agent-gotchas.md` ＋ `pos-task-router` skill。舊全文→`DETAIL-2026-10.md`／`DETAIL-2026-09.md`；逐日細節見 log。
> POS=`iyrywzormzisyppkokbi`；Ledger=`zymdemjflsckicwcinxl`。示範店 storeId=`d564b932-0c91-45e9-86fd-0ec8e2711f13`。

## 🔴 反覆踩嘅坑
- `normalizeMenuItem`／`normalizeBootstrapPayload.rules`／`normalizePosLocalSettings` 都係 **whitelist**：加欄位唔改佢＝靜靜剷走（客人端永遠見唔到）。2026-10-20 已補 `discountRate`／`originalPrice`／`memberPrice`（price≤0 時唔再剷）。
- 「寫得入」≠「讀得出」：新欄位要端到端驗（入庫＋出站正規化＋每條讀取路徑）。
- **後台表單靜默丟資料**係高頻 bug：打完嘅值喺 save 路徑被覆寫成 0／undefined，UI 零提示。改表單必問「呢個 state 有冇被 save 忽略」。
- 加 `pos_orders` 欄位要改**四條**讀取路徑（pos-order-mapper／pos-order-row／`/api/pos/orders` 內聯 mapper／sync baseRecord）。
- **刪「父組件」會連子節點陪葬**：2026-10-20 為刪「掃碼點餐模式卡」而刪 `scan-mode-panel.tsx`，QR 面板寫在同檔 ⇒ 商家完全冇入口印枱貼紙，兩日後才發現（2026-10-21 復原為 `scan-qr-section` + `kiosk-qr-panel` + `quick-scan-qr-panel` + `qr-svg`）。刪 UI 前先問「呢個檔仲有冇**其他**用途」。
- 掃碼 QR **冇 storeId 唔可以出碼**：`scan-order-page.tsx` 冇 storeId 直接擋，貼紙會白印。
- **缺欄檢測唔可以只認 `42703`**：PostgREST 對 `.insert()` 未知欄多回 **`PGRST204`**（"Could not find the 'x' column … schema cache"），對 `.select()` 兩種都可能。要同時認 code（42703/PGRST204）＋訊息 regex，否則降級分支永不觸發、靜默失敗（2026-10-22 庫存開通中招）。查詢本身亦要包 try/catch，唔可以假設「欄一定存在」。
- **登入時觸發嘅副作用 ≠ 對已登入 session 生效**：POS session 存 localStorage，部署前已登入嘅商戶只按「重新整理」唔會再打 `/api/ledger/login` ⇒ 登入時開通／上報永遠唔 fire，要登出再登入。
- **新增 `t("…")` key 必須同時加落 `i18n-dict-zh.ts` 同 `i18n-dict-en.ts`**：只加英文 → `i18n-layer-guard.test.ts` 報「孤兒 key + 繁中缺 key」連續 fail 兩輪（2026-10-23 權限控制踩）。
- **加字典 key 前一定要 grep 舊 key**（兩種寫法都要搵：`  key:` **同** `  "key":`）。重複 key 會 `tsc` TS1117 直接 fail；而 CJK key 唔一定係合法識別字 —— 含 `…`／標點（例如 `儲存中…`）**必須加引號**，否則 `node --test` 連字典都載入唔到（報 `ERR_INVALID_TYPESCRIPT_SYNTAX`，唔會話你知缺邊個 key）。
- **新頁面若店員手機要開得到，必須加入 `ORDER_ONLY_ALLOWED_PATHS`**（`src/lib/pos/order-only-terminal.ts`）：落單專用終端白名單會無聲擋走，直接彈返 `/staff`（2026-10-23 `/operator` 中招）。
- **`/admin/*` 冇 `LangProvider`**：該區組件用 `useT()` 會 throw 白屏 ⇒ admin 專用面板文案直接寫繁中，唔好 `t()`。
- 🔴 **全 app shell 靠 `h-[100dvh]` 量高捲動**（body `overflow:hidden` 鎖死文件捲動）：Android PWA（standalone + viewport-fit=cover）實測 `100dvh` 會大過可見視窗 ⇒ 所有 dvh 容器「裝得落」⇒ 全頁零捲動、fold 下內容遙不可及；側欄因 `fixed inset-y-0` 倖存（2026-10-29 診斷，未修）。新頁面 shell 要用 `fixed inset-0` 唔好再用 dvh；修 shell 記得內層 `max-h-[calc(100dvh-150px)]` 分區一齊改。

## 員工權限（2026-10-23 上線，docs/160）
- **Ledger 冇權限模型**（契約級）：`merchant_staff.staff_role` 只有 `owner|staff`，RPC 閘只有 `is_merchant_staff()` boolean ⇒ 權限一律 POS 本地做，勿再打 Ledger 主意。
- 分層：L1 裝置登入（Ledger 8 位電話+PIN）／L2 操作員簽到（POS 本地 `staff_no`+4 位 PIN，簽 `sv1` token 12h）。`sv1` 同 `pv1` 共用 secret 但 kind 互不通用。
- 權限真源 `src/lib/pos/staff-core.ts`：加頁面／操作必須同步加落 `POS_STAFF_PAGE_IDS`／`POS_STAFF_ACTION_IDS`（白名單，漏加＝UI 勾咗但讀出被剷）。頁面 id 有契約測試對齊 `module-catalog.ts` 側欄。
- 操作員 session 存**獨立 key** `macau-pos/operator/{storeId}`，唔塞 `AuthSession`（`normalizeAuthSession()` 白名單會剷欄位、換班亦唔應整頁 reload）。
- 權限 gate 係雙層：`operatorSession ? operator.permissions.x : authSession.permissions.x` —— 冇操作員時沿用 L1，**不可寫 `?? true`**（fail-open）。
- 管理 API 已 server 驗 owner（`requireStoreOwner()` 雙通道：admin session scope／Ledger `owner`）；**逐個 POS 操作驗 `sv1` 仍未做**（Phase 2）。
- 表：`pos_staff`（migration `0072`，service_role only）；PIN = PBKDF2-SHA256 120k + per-row salt + 5 次鎖 15 分鐘。

## 數字口徑
- 實收＝毛＝`agg.paidTotal`；報表營業額＝淨額 `totalRevenueNetMop`；交班 `netPaidTotal`（＋未退）方向相反，唔可互抄。
- 折扣／會員價一律行現成 `discountAmount`＋`discountNote` 通道 ⇒ 收據／報表／交班／POS 自動正確、下游零改動（`buildKioskOrder({memberDiscountAmount})`）。落新折扣功能唔可以聲稱「報表零影響」。
- `discountRate`（所有顧客都享）≠ `memberPrice`（只限會員）。
- 訂單時間唯一真源 `orderEventInstant()`；澳覓單 `created_at` +8h。
- 多幣值唔設匯率：唔同幣值永遠唔可以加埋（`byCurrency`；`chartPrimary()` 只畀圖表）。

## 返結
- 四鐵律：同機正常≠上雲（查 reopen_count）／維持 reopened+keepPaidStatus／reopen_count 單調遞增／加欄位四條路徑。
- 本地快餐 counter 單可返結（`isReopenable()` 喺 `pos-order-filters.ts`）；`reopenPosOrder()` counter 跳過 temp 枱；`handleReopen()` 必帶 `order.tableId`。
- temp-reopen 枱只寫本機 ⇒ 跨機返結失聯（未修，已知）。

## 鑑權／Realtime／打印
- `posRouteAuthGuard()` 放 early-return 之後；`POS_REQUIRE_DEVICE_AUTH` **未設＝fail-closed 強制鑑權**（2026-10-22 查碼糾正：顯式 `0` 先至全域開閘，緊急回滾用；之前記憶寫「未設＝開閘」係誤讀）。
- anon 時間窗 RLS（pos_orders 72h／pos_print_jobs 24h）係刻意；收緊＝出紙 1–3 秒變 180 秒。
- 入隊只准 `appendPrintJobsWithSync()`；`pushEvents()` base 要 `loadQueue()`；去重靠 `onceKey`。
- Realtime hook 四件套：subscribe 首行 `if (cancelled || channel !== ch) return;`／`removeChannel` 後再判 cancelled／CLOSED 唔可刪／同 topic 一頁一條 channel（守衛 `realtime-resubscribe-loop.test.ts`）。
- 顧客會員 session **只存記憶體、禁持久化**（Kiosk 共用平板）⇒ 掃碼第二次必重新登入。

## 掃碼點餐
- 雙路由 `/menu?tableId=`（每枱一碼）／`/quick`（全店一碼）；**訂單綁枱唔綁手機**（2026-10-20 拍板）。
- 會員價：單品 `memberPrice` override 全店 `rules.memberDiscountRate`；純函式 `lib/pos/member-price.ts`；顯示「原價 MOP X　會員 MOP Y」（唔劃線）。
- 自助扣款 `/api/ledger/scan-debit/quote|commit`（伺服器核價）；免 PIN 窗 180s。
- `MemberLoginSheet` 冇 `open` prop ⇒ 一定要 `memberLoginOpen &&` gate。
- 確認稿：零 `@media`＋固定畫布＋`data-k`；驗收 `_verify-scan-mockup.cjs`（要 `NODE_PATH`）＋量 canvas scrollHeight／grid children。

## 外送／車手派單（2026-10-31，Phase 2 已落地，未接通車手平台）
- 需求口徑：**任何訂單都可以派**（線上外送／店內／平台自送自取），**單號照舊**；線上堂食／自取**唔准**派（要客人取消重落）。
- 表：`pos_delivery_jobs`（migration `0076`，**service_role only**，前端永不直讀，**零 Realtime／零 polling**）。關聯 `(store_id, order_source, order_ref)` 唯一，`order_source` = `ledger`（Ledger orders.id）／`pos`（pos_orders.id）；**唔改 `pos_orders`**。
- 判斷真源 `src/lib/pos/delivery/eligibility.ts`（線上只准 `merchant_delivery`＋accepted/preparing/ready；店內任何已送出；平台只准 merchant/pickup，`unknown` fail-closed）。UI 一律經 `dispatch-action.resolveDispatchAction()`，**唔好喺 component 自己寫條件**（三個入口會走樣）。
- 平台配送方式：澳覓 `raw_json.raw.sendType`（專送／自送／自取）、MFOOD `raw.deliveryType`（1 平台／2 自送／3 自取）。前端**只傳 id** 去 `GET /api/pos/delivery/modes`，raw payload 唔離開伺服器。
- 兩個旗標**預設都關**：`NEXT_PUBLIC_DELIVERY_DISPATCH=1` 顯示派送掣；`NEXT_PUBLIC_DELIVERY_LIVE=1` 才真的叫車。未開 LIVE 時 POST 只寫 `draft`，彈窗同外送 tab 都要明寫「唔會真的叫車」——**唔可以靜靜當成已派**。
- 寫入 `POST /api/pos/delivery/jobs`：server 再驗一次（`job-input.ts`）；進行中 job（new/accepted/picked_up）→ 409 `dispatch_exists`，只有 draft/canceled/failed 准覆寫。
- **座標唔收**（2026-10-31 商家拍板）：商家只有地址自由文字，冇可能填經緯度 ⇒ `customer_lat/lng` 永遠 NULL。店鋪地址／座標由 Ledger `merchants` 自己讀（缺就報「請先在商家設定填寫店鋪地址」），POS 唔需要傳。車手 App 導航失效時仍有地址＋一鍵致電。
- **平台單有地址同電話**（2026-10-31 更正）：插件 `C:/dev/grabber` `aomi-bridge.js` / `mfood-bridge.js` 有送 `customer.address`（澳覓←`userAddress`、MFOOD←`address`）、`customer.name`、`remark`；MFOOD 另有完整 `phone` 同 `rider`，**澳覓電話係遮罩**（`phoneMasked`，打唔通）。`projectGrabberOrder()` 冇投影呢啲欄位 ⇒ 派單時用 `GET /api/pos/delivery/prefill`（逐張拉，個資唔批次送）由 `raw_json` 抽。🔴 查平台欄位一定要睇 `*-bridge.js`，唔好只睇 POS 側 `GrabberOrder` type。
- 側欄「外送」放「訂單」下面；`module-catalog` 同 `POS_STAFF_PAGE_IDS` **必須同序加** `delivery`（契約測試）。側欄英文用 `Rider`（56px 淨闊）。
- 未做（要 Ledger v3.6，見 `docs/integration/pos-v3.6-partner-handover-delivery-dispatch.md`）：A1–A5 派送／取消／催單／加價、B1 外部派單、C1/C2 聊天房間。車手聊天亦未做。

## 環境／工具（本機）
- git-bash 冇 coreutils、`npm/npx` 跑唔到 ⇒ 用 Read/Glob/Grep 或 managed node 直接跑入口檔（`node_modules/typescript/bin/tsc`、`node --test`、`node_modules/eslint/bin/eslint.js <file>`）。
- 唔好 `node -e` 寫含反引號內容（shell 靜默吞）⇒ 用 Write/Edit 或 `.cjs`。
- `next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0`；刪源碼檔要 PowerShell `Remove-Item -LiteralPath` ＋同一 env。
- **push 唔使做任何手腳**（2026-10-26 更正，舊記錄寫「要把 PortableGit 入 PATH／繞過 GCM」係錯嘅）：J 部機裝咗 **GitHub Desktop**，GCM 已有緩存憑證 ⇒ `git push origin main` 直接乾脆成功，唔使 PATH、唔使 inline helper、唔使 PAT。
- ⚠️ 但 push **可能要 >120s 先返結果**：Bash tool 默認超時會 SIGTERM 殺死 process，輸出空白、以為失敗，**其實可能已經推咗**。
  ⇒ 用 `timeout 240 git push origin main` 並把 tool timeout 設 300s；判成敗一律用 `git rev-parse origin/main` 對 `main`，**唔好**用push指令嘅 exit code／輸出。
- 本機 node_modules 嘅 `typescript`／`eslint` 包裝殘缺（lib.dom.ts、eslint package.json 缺）⇒ `tsc --noEmit`／`eslint` 跑唔起，改動要靠手審。

## 取證
- `pos_bootstrap_config`／`pos_device_configs`／`pos_shifts` anon 401；`pos_store_status`、`pos_print_jobs` anon 可讀 ⇒ union store_id，再打公開 `/api/pos/bootstrap?storeId=` 核店名／菜品（唔需憑證）。

## 部署（Vercel）
- **生產網域：`https://macau-pos-system.vercel.app`**（Vercel 專案 `macau-pos-system`；deployment URL 受 SSO 保護會 302，唔適宜用嚟探測）。
- **push 到 main 即自動部署**，唔需要手動 deploy；本機冇 vercel CLI／token。
- 🔴 **env var 只對「儲存後新建嘅部署」生效**，唔會回溯補落現有部署 —— 加／改完 var 必須**重新部署**先讀到（空 commit push 或 dashboard Redeploy 都得）。2026-10-22 手機版庫存表 QR  deploy 完先至加 `MACAU_LEDGER_SSO_SECRET` ⇒ 彈窗報「尚未啟用」，枉查咗一陣 SQL／程式碼。
- 驗證「新 code 有冇上線」最快：打一條**新版本先有**嘅 endpoint —— 例如 `/api/admin/me`（舊版 → 404，新版 → 401 JSON）。其他 401 endpoint 冇辨識力。
- 查部署狀態／commit 對應：用 GCM 取 GitHub token 打 `api.github.com/repos/homeu98-glitch/macauPosSystem/deployments`，再查 `.../deployments/{id}/statuses`（state + environment_url）。
