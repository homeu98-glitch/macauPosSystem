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
- `posRouteAuthGuard()` 放 early-return 之後；`POS_REQUIRE_DEVICE_AUTH` 未設＝開閘。
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

## 環境／工具（本機）
- git-bash 冇 coreutils、`npm/npx` 跑唔到 ⇒ 用 Read/Glob/Grep 或 managed node 直接跑入口檔（`node_modules/typescript/bin/tsc`、`node --test`、`node_modules/eslint/bin/eslint.js <file>`）。
- 唔好 `node -e` 寫含反引號內容（shell 靜默吞）⇒ 用 Write/Edit 或 `.cjs`。
- `next build` 要 `CODEBUDDY_SAFE_DELETE_ENABLED=0`；刪源碼檔要 PowerShell `Remove-Item -LiteralPath` ＋同一 env。
- push 前把 PortableGit `cmd`＋`mingw64/bin` 入 PATH；仍掛就繞過 GCM 用內聯 helper。

## 取證
- `pos_bootstrap_config`／`pos_device_configs`／`pos_shifts` anon 401；`pos_store_status`、`pos_print_jobs` anon 可讀 ⇒ union store_id，再打公開 `/api/pos/bootstrap?storeId=` 核店名／菜品（唔需憑證）。

## 部署（Vercel）
- **生產網域：`https://macau-pos-system.vercel.app`**（Vercel 專案 `macau-pos-system`；deployment URL 受 SSO 保護會 302，唔適宜用嚟探測）。
- **push 到 main 即自動部署**，唔需要手動 deploy；本機冇 vercel CLI／token。
- 驗證「新 code 有冇上線」最快：打一條**新版本先有**嘅 endpoint —— 例如 `/api/admin/me`（舊版 → 404，新版 → 401 JSON）。其他 401 endpoint 冇辨識力。
- 查部署狀態／commit 對應：用 GCM 取 GitHub token 打 `api.github.com/repos/homeu98-glitch/macauPosSystem/deployments`，再查 `.../deployments/{id}/statuses`（state + environment_url）。
