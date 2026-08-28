# Ledger v3.2 對接計劃（macauPosSystem）

> **日期**：2026-08-28
> **權威契約**：`pos-ledger-client-api.md`（v3.2，以該檔為準）
> **實作清單**：`pos-v3.2-partner-handover.md`
> **狀態**：計劃已定稿（5 個 open question 已獲夥伴解答）；**全部已知確認項已完成** —— M5①②③、M3、M5 充值＋會員列表＋未註冊建檔、M4、M7，以及契約 v2→v3.2 同步（見 §8）。
> 原 DEFER 嘅 **M5③ `ensure-customer` 已於 2026-08-28 解鎖落地**：Ledger HTTP 本體**已上線**，POS 只做薄轉發（校驗＋限流＋帶店員 Bearer token 轉發）。
> ⚠️ 先前 DEFER 係**我方誤判**（本 repo 契約副本停喺 v2，而 Ledger 權威檔只喺其 private repo），並非 Ledger 未定稿。
> **環境**：UAT `https://membership-uat.macau-tech.com`（先聯測）→ 正式 `https://membership.macau-tech.com`（migration `20260828120000` 已於 2026-08-28 上正式庫）。Supabase 沿用已私下提供之 `NEXT_PUBLIC_SUPABASE_URL` + `anon` + `AUTH_PIN_PEPPER`（**唔好**再攞 `service_role`）。

---

## 0. 一句話結論

現有 POS 已經有「大半」Ledger 直連骨架（login 伺服器路由、`ensureLedgerSession`、`getLedgerSupabaseClient`、member `lookup`/`deduct`、orders Realtime）。真正仲要做嘅係：**① 未註冊代建路由 `ensure-customer`；② 會員列表搜尋 `list_merchant_customers`；③ 移除禁咗嘅 `p_type=add`；④ 日報 KPI 改為「Ledger 線上摘要 + POS 本地堂食」分源；⑤ 確認 polling / PII 反模式合規。** 其餘多數只需「對齊契約」，唔使從零寫。

---

## 1. 對接架構（照契約）

- **兩 DB 分家**
  - **Ledger Supabase** = 線上訂單 / 會員錢包 / 報表（線上數據權威）
  - **POS 自己 Supabase** = 堂食 / 收銀 / 設備 / LAN 打印 / 離線隊列
- **POS client 直連 Ledger RPC + Realtime**（零 Ledger Vercel HTTP，除咗下面兩條伺服器路由）。
- 只有兩件事經**伺服器**（`{NEXT_PUBLIC_APP_URL}` 自己嘅 route）：
  1. `POST /api/ledger/login` — 8 位電話 + 4 位 PIN → `password = HMAC-SHA256(AUTH_PIN_PEPPER, normalizePhone+":"+pin)`；`AUTH_PIN_PEPPER` **只喺 server**（`.server.ts` + env，絕不入 browser bundle）。
  2. `POST /api/integration/pos/ensure-customer` — 未註冊代建 ± 首充。
- **禁項**：`setInterval` polling 任何 Ledger RPC；`wallets` Realtime；`p_type=add`；PII（電話/名/地址）落 localStorage / IndexedDB / POS DB；mirror 線上單入 POS DB。

---

## 2. 現狀盤點（做咗 vs 未做）

| 契約要求 | 現狀 | 缺口 / 動作 |
|---|---|---|
| login 伺服器路由（PIN 簽章） | `login-screen.tsx` → `/api/ledger/login` → `pin.server.ts`（`.server`，HMAC）✓ | 驗 `merchant_staff.staff_role` 讀取（owner/staff）影響 UI 權限 |
| session / token 刷新 | `ensureLedgerSession` + `setSession` ✓ | token 存 sessionStorage/內存，唔落永久 localStorage |
| Ledger Supabase client 單例 | `getLedgerSupabaseClient` ✓ | 確認用 Ledger 嘅 `NEXT_PUBLIC_SUPABASE_URL`，Realtime 同一 client |
| 會員 lookup | `merchant_lookup_customer_wallet` ✓ | — |
| 已註冊 deduct | `applyPosDeduct`（有 idempotency key）✓ | **移除 `applyPosAdd`**（`p_type=add` 禁） |
| 會員列表搜尋 | ✅ **已做** | `src/lib/ledger/member-list.ts`（`list_merchant_customers`） |
| 未註冊代建 | ✅ **已做** | POS 薄轉發 `src/app/api/ledger/ensure-customer/route.ts` → Ledger HTTP 本體（已上線） |
| 線上訂單 realtime | `use-ledger-orders-realtime.ts`（orders）✓ | 加 `products` realtime（本地 patch/upsert）|
| 日報會員數 | `getMerchantMemberSummary`（RPC `get_merchant_member_summary`）| **RPC 不存在** → 改用 `get_merchant_report_summary.member_count`；移除 `getMerchantMemberSummary` |
| 線上營收摘要 | `getMerchantReportSummary` ✓ | 加 `memberCount` 欄（來自 `member_count`）|
| 庫存低存預警 | 讀 POS 自己 `inv_products` ✓ | 唔使改（無 Ledger 依賴）|

### 5 個 open question — 夥伴解答（已閉環）

1. **會員總數點計？** `get_merchant_member_summary` **不存在**。本店會員總數用 `get_merchant_report_summary` → `member_count`（該店 `wallets` 列數，與 Web 報表「會員」同數）。店員呼叫**省略** `p_merchant_id`。`list_merchant_customers.total` 係當次搜尋筆數，**唔係**全店總數，唔好用嚟當日報總數，亦唔好為咗攞 total 而空搜尋 dump 全店。日報開報表時打**一次** `get_merchant_report_summary`（與營收共用）。
2. **`get_merchant_report_summary` 覆唔覆蓋線上營收/渠道/菜品？** 部分覆蓋：會員/收藏/餘額總額、記帳充值/扣點、線上訂單營收摘要（有）；渠道只有「餘額扣點 vs 到店付款」兩欄，**無** UTM/Facebook/外送平台拆帳；**菜品/分類銷量無**。結論：線上營收摘要直接用 summary，**唔好**用 `list_merchant_orders` 自己加總（有筆數上限會錯）；**唔好**為報表對每單 loop `get_order_detail`。菜品排行 / 堂食現金單屬 POS 自有 DB。summary **不含** POS 自己堂食現金單。
3. **返結/退款要唔要動 Ledger 餘額？** 同意建議：**POS 店內單返結唔好動 Ledger**。`p_type=add` 唔開放（唔係充值、亦唔係沖正）；唔好用 `topup` 當退款；真沖正係 Web 商戶端 `revert_transaction`，v3.2 唔開放 POS。只係 POS 堂食現金（未打過 Ledger deduct）→ 只改 POS 本機狀態；打過 `merchant_apply_pos_txn(deduct)` → POS 唔好改餘額，要沖正請店員用會員通 Web「退回」。
4. **`/api/topup/pending-count` 係咪 proxy Ledger？** **唔係** Ledger 路徑（會員通冇呢條 API）。Ledger 線上充值審核紅點 = `merchant_siteb_pending` 表 + Realtime（另一夥伴 topUpAutomation），**禁止**為紅點 polling Ledger。若 `/api/topup/pending-count` 係 POS 自己嘅轉帳截圖 queue，可以 poll **自己後端**，只要唔打 Ledger Vercel / Ledger RPC 就合規。→ 現有 `pending-count-store.ts` + `member-topup-panel.tsx` 嘅 `setInterval` **可以保留**，但要做一次 audit 確認佢只撈 POS 自己 DB。
5. **正式 migration 幾時 deploy？** 已經上正式庫（2026-08-28），UAT 更早。JSON 加 `paid_balance_avos`/`gift_balance_avos`，簽章不變；代建 HTTP 隨 `main` Vercel 部署。聯測仍建議**先 UAT**。

---

## 3. 實作模組

### M1 — 認證（基本完成，要驗）
- 已有：`login-screen.tsx` → `/api/ledger/login` → `pin.server.ts`（`.server`，HMAC-SHA256）→ `setSession`；`ensureLedgerSession` 負責 refresh。
- 動作：
  - 確認 `AUTH_PIN_PEPPER` 確實只喺 `.server.ts` + env（唔入 bundle）。
  - 登入後讀 `merchant_staff.staff_role`（`owner`/`staff`，**唔係** `role` 欄），影響 UI 權限（例如「會員通」tab 可見性）。
  - 確認 Ledger access/refresh token 只存 sessionStorage / 內存（契約 PII 規則：電話/名/地址唔持久化；token 本身非 PII，但建議 sessionStorage 避免跨 tab 長期留存）。

### M2 — Ledger Supabase client 單例（已有）
- `getLedgerSupabaseClient` + `supabase-server-auth.ts` `setSession` 已喺。
- 確認 client 指向上文 Ledger 嘅 `NEXT_PUBLIC_SUPABASE_URL`；Realtime 用同一 client；subscribe filter `merchant_id=eq.<uuid>`。

### M3 — 線上訂單 feed（要改 mirror 行為）
- 已有：`use-ledger-orders-realtime.ts`（public.orders realtime）、`orders.ts`（`list_merchant_orders` / `get_order_detail` / `accept_order_with_deduct` / `accept_order_in_store` / `update_order_status` / `set_order_paid_in_store`）。
- 動作：**audit `ledger-pos-bridge.ts:193`**（及任何寫入 `loadOrders`/`saveOrders` 嘅路徑）確認有冇將線上單 mirror 入 POS DB。契約禁止 → 改為只 in-memory 顯示（收銀見單），唔寫本地持久層。

### M4 — 日報 KPI 重挷（重點）
現狀 `restaurant-daily-report.tsx` 用 `loadOrders()`（只堂食/前台）計營收 + 渠道 + 出餐時間 + 會員數。改法：
- **會員數**：移除 `getMerchantMemberSummary`；`getMerchantReportSummary` 回傳加 `memberCount`（來自 `member_count`），開報表打一次共用。
- **線上營收 / 記帳**：直接讀 `getMerchantReportSummary`（`orderPaidMop` / `orderBalancePaidMop` / `orderInStorePaidMop` / `topupMop` / `deductMop`）。**唔好**用 `list_merchant_orders` 加總。
- **渠道**：只有「餘額扣點 vs 到店付款」兩欄，照實顯示；**唔好**聲稱有 UTM / 平台拆帳。
- **菜品排行 / 分類銷量**：契約 summary **無**此欄，且禁止 loop `get_order_detail`。→ 日報菜品排行 = **POS 堂食/前台本地單**（準確 scope），卡片標「堂食/前台銷量」；線上菜品排行契約唔提供，唔做。
- **出餐時間**：只計堂食/前台（local 有 `sent_to_kitchen_at` / `served_at`），標 scope。
- 總之：日報 = 「Ledger 線上摘要（會員/營收/記帳）+ POS 本地堂食（菜品/出餐/現金）」，**兩者 scope 唔同，唔可以假設 merge 成一筆總營收**。

### M5 — 會員操作（3 件事）
- ① **lookup**（已有 `lookupCustomerWallet` → `merchant_lookup_customer_wallet`）✓
- ② **已註冊 recharge / deduct**（已有 `applyPosDeduct` → `merchant_apply_pos_txn(p_type:"deduct")`，有 idempotency key）✓；但**移除 `applyPosAdd`**（`p_type=add` 禁）。影響 `reopenPosOrder` 返結：返結**唔 call Ledger**（見 Q3 規則），改為只本機狀態或提示用 Web「退回」。
- ③ **未註冊代建**（TODO，新建伺服器路由 `ensure-customer`）：
  - `POST {NEXT_PUBLIC_APP_URL}/api/integration/pos/ensure-customer`
  - Header `Authorization: Bearer <店員 Ledger access_token>`（由 `ensureLedgerSession` 攞）
  - Body：`merchantId`、`phone`；可選 `displayName`、`amountAvos`、`idempotencyKey`（有金額時 idempotency 必填）
  - `displayName` 只喺平台姓名仍空時寫入，已有唔覆寫
  - 限流：每店 / 每操作者 **15 分鐘 30 次**；禁 `setInterval`、背景 tab 連打
  - 成功後客人到會員通 `/wallet/login` 自設 4 位 PIN（餘額已在），POS 唔幫設 PIN
- **PII 規則**：電話/名/地址 render-only，audit `members.ts` / `member-types.ts` 有冇寫入 storage；餘額用 `balance_avos`（已合計），**唔好** `balance + gift`。

### M6 — 庫存低存預警（唔使改）
- 已讀 POS 自己 `inv_products`（`/api/inventory/products?store=<merchantId>`），無 Ledger 依賴。保持。

### M7 — Realtime 生命週期
- 現有 `use-ledger-orders-realtime.ts` 訂 `public.orders`；加 `public.products`（同一 client，filter `merchant_id=eq.<uuid>`）。
- `products` 更新 → **本地 patch/upsert** menu cache（**唔好**全 `list_merchant_order_menu` re-fetch）。
- 規則：mount subscribe / unmount unsubscribe；`wallets` **唔 subscribe**。
- 會員通線上單明細展示用已有訂單列表 / Realtime，**唔好**為日報加 polling。

### M8 — 反模式清理（audit list）
1. `members.ts` `applyPosAdd`（`p_type=add`）→ 移除；`reopenPosOrder` 改為唔 call Ledger 餘額。
2. `pending-count-store.ts` + `member-topup-panel.tsx` 嘅 `setInterval` 12–30s → **保留**（Q4 確認係 POS 內部 queue，合規），但做一次 audit 確認 `/api/topup/pending-count` 唔 proxy Ledger。
3. 確認無 `wallets` Realtime。
4. 確認線上單無 mirror 入 POS DB（同 M3）。

---

## 4. 預計新增 / 修改檔案（只列，未實作）

- ✅ **新增** `src/app/api/ledger/ensure-customer/route.ts`（POS **薄轉發**：Bearer + 限流 + idempotency → 轉發 Ledger 本體；**唔係** Ledger 本體）
- ✅ **新增** `src/lib/ledger/member-list.ts`（`list_merchant_customers` 封裝：**唔傳** `p_merchant_id`、非空搜尋、`p_page_size≤50`、一次一頁）
- ✅ **新增** `src/lib/ledger/ensure-customer.ts`（client wrapper，打 POS 薄轉發）
- **改** `src/lib/ledger/reports.ts`：移除 `getMerchantMemberSummary` + `LedgerMemberSummary`；`LedgerReportSummary` 加 `memberCount`（來自 `member_count`）；確保呼叫省略 `p_merchant_id`
- **改** `src/lib/ledger/members.ts`：移除 `applyPosAdd`；PII 唔落 storage；確保 `applyPosDeduct` 唔傳 `p_type=add`
- **改** `src/components/restaurant-daily-report.tsx`：KPI 分源（會員數 / 線上營收讀 summary；菜品排行 / 出餐時間讀本地；標 scope）
- **改** `src/lib/ledger/ledger-pos-bridge.ts` + 任何訂單寫入點：確保唔 mirror 線上單入 POS DB
- **改** `src/lib/ledger/use-ledger-orders-realtime.ts`：加 `products` realtime + 本地 patch/upsert
- **確認** `src/lib/topup/pending-count-store.ts` + `member-topup-panel.tsx`：polling 只撈 POS 自己後端

---

## 5. 驗收閘（契約 §9 第 20–24 項）

| # | 項目 | 驗法 |
|---|---|---|
| 20 | 未註冊代建成功 | `ensure-customer` 建未註冊 + 首充，客人再到 `/wallet/login` 自設 PIN |
| 21 | 已註冊扣點 | `merchant_apply_pos_txn(deduct)` + idempotency key；重試重用同一 key |
| 22 | 列表搜尋 | `list_merchant_customers` 非空搜尋（≥2 字或完整 8 位電話）、`p_page_size≤50`、唔 dump 全店 |
| 23 | 未註冊扣點錯誤 | `registered=false` 直接 `deduct` → 正確報錯，唔好靜靜代建 |
| 24 | 限流 | `ensure-customer` 30 次 / 15 分 / 店 / 操作者 |

- **UAT 測試號**：店主 `60000001` / PIN `1111`；會員 `60000003`（已註冊）。未註冊請用夥伴自備 8 位測試號，測完告知清理。
- 問問題時引用契約 §5.6.4 / §5.7.2 / §5.7.7，附：環境、HTTP 狀態、RPC `error` 原文、是否已先 lookup。

---

## 6. 建議執行順序（先 UAT）

1. **M1** 驗證 login / session（已有，跑通 UAT `60000001`）
2. **M5③** `ensure-customer` 路由 + **M5①②** 移除 `applyPosAdd`、清理 `reopenPosOrder`
3. **M5** 會員列表 `list_merchant_customers`
4. **M3** mirror audit + **M7** `products` realtime
5. **M4** 日報 KPI 分源（會員數改 `member_count`、線上營收讀 summary、菜品排行標本地 scope）
6. **M8** 反模式清理（applyPosAdd + pending-count audit + wallets/ mirror 確認）
7. **驗收** §9 第 20–24 項（UAT 先，過再切正式）

---

## 7. 收尾 scope 註記

- 日報「線上菜品排行」契約唔提供（summary 無菜品欄、且禁 loop `get_order_detail`）→ 日報菜品排行只計 **POS 堂食/前台**，卡片明標 scope，唔假裝有線上拆分。
- 渠道只計「餘額扣點 vs 到店付款」；唔做 UTM / 外送平台拆帳。
- 返結/退款：POS 唔動 Ledger 餘額；Ledger-deducted 單要沖正 → 會員通 Web「退回」。

---

## 8. 實作進度（2026-08-28）

### 已完成（已知 / 確認項）

| 項 | 改動 | 檔 |
|---|---|---|
| M5② 移除禁項 `applyPosAdd`（`p_type=add`） | 刪 `applyPosAdd`；`reopenPosOrder` 返結只切本機狀態，唔 call Ledger | `src/lib/ledger/members.ts`、`src/lib/pos-orders.ts` |
| M5② 新增 `applyPosTopup`（`p_type=topup`）+ 充值 UI | `applyPosTopup`（帶 idempotency key）；`members-page.tsx` 加充值區（MOP→avos、`topup-<id>-<ts>` key、成功刷餘額+券） | `src/lib/ledger/members.ts`、`src/components/members-page.tsx` |
| M4 日報 member_count | `LedgerReportSummary.memberCount` 來自 `member_count`；移除 `getMerchantMemberSummary`；日報 pill 讀 `ledger.sel?.memberCount` | `src/lib/ledger/reports.ts`、`src/components/restaurant-daily-report.tsx` |
| M3 線上單無 mirror 入 POS DB | `bridgeLedgerOrderToPos` 移除 `saveOrders`，改用 in-memory `bridgedOrders` Map；`findPosOrderForLedger` 先查 in-memory registry 再 fallback `loadOrders()`，void/receipt 打印唔會斷 | `src/lib/ledger/ledger-pos-bridge.ts`、`src/lib/print-jobs.ts` |
| M7 `products` Realtime | 新 `useLedgerProductsRealtime`（訂 `public.products`，filter `merchant_id`，**唔** subscribe `wallets`）；`patchMenuFromRealtimeRecord` 單筆 patch/upsert bootstrap 餐牌 cache + 售罄狀態，dispatch `pos-bootstrap-changed`；`pos-app.tsx` 接 hook + 聽事件即時重讀餐牌 | `src/lib/ledger/use-ledger-products-realtime.ts`（新）、`src/lib/ledger/menu-import.ts`、`src/components/pos-app.tsx` |

> **M3 副作用（順帶修正）**：移除 mirror 後，`restaurant-daily-report.tsx` 讀 `loadOrders()` 仲係「POS 堂食/前台」純本地單，線上單唔再污染菜品排行 / 出餐時間 scope（原本 mirror 會錯計）。符合 M4 scope 規則。

### ✅ 已完成（2026-08-28 晚 · v3.2 解鎖後）

> **解除 DEFER 的原因**：先前 DEFER 係**我方誤判**——本 repo 嘅契約副本仍係 v2（2026-08-11），而 Ledger 權威
> `pos-ledger-client-api.md`（v3.2）同 `pos-v3.2-partner-handover.md` 只喺 **Ledger private repo**，本 repo 搜唔到。
> Ledger 2026-08-28 確認：`list_merchant_customers`（自 `20260530160000` 喺 DB）同 HTTP `ensure-customer`
> **均已在線**，唔係新建。契約已轉錄進 `docs/integration/ledger-client-api.md` §5.6–§5.9（升級 v3.2）。

| 項 | 改動 | 檔 |
|---|---|---|
| M5 會員列表 `list_merchant_customers` | `listMerchantCustomers({search,page})`：**唔傳** `p_merchant_id`（傳咗 `not admin`）、`p_search` 非空校驗、`p_page_size=50`；`balance_avos` 已係合計**唔好再加 gift**；會員頁加搜尋列＋結果列表＋「載入更多」 | `src/lib/ledger/member-list.ts`（新）、`src/lib/ledger/member-types.ts`、`src/components/members-page.tsx` |
| M5③ 未註冊建檔 `ensure-customer` | **POS 薄轉發**（唔係 Ledger 本體）：校驗＋限流 30/15min/店/操作者＋帶店員 Bearer token 轉發到 `https://membership-uat.macau-tech.com/api/integration/pos/ensure-customer`；browser 只打 `/api/ledger/ensure-customer` | `src/app/api/ledger/ensure-customer/route.ts`（新）、`src/lib/ledger/ensure-customer.ts`（新） |
| 充值分流（一掣兩分支） | `handleTopup`：`registered=true`→`applyPosTopup`；`registered=false`→`ensureCustomer`（建檔＋首充）；成功刷新錢包＋券；明禁 `p_type=add` | `src/components/members-page.tsx` |
| 契約同步 v2 → v3.2 | 升級 `ledger-client-api.md` 為 v3.2 並新增 §5.6–§5.9；`pos-member-system-requirements.md` 移除「新建？」誤導標註 | `docs/integration/*.md` |

> ⚠️ **「無輸入自動載入全店會員」係契約 v3.2 §5.7 明確禁止**（禁 dump 全店、禁空搜尋當一覽、PII 禁落地），
> 唔係技術上做唔到。要睇全店名單 → 會員通 Web `/merchant/reports/users`。
> 完整計劃／紀錄見 `docs/78-member-list-and-add-via-topup.md`。

### 待辦（確認項但非今輪範圍）

- 契約 M1 `merchant_staff.staff_role` UI 權限（owner/staff）接駁「會員通」tab 可見性。
- M8 pending-count / `wallets` Realtime audit（Q4 確認 POS 內部 queue 合規，今輪未再動）。

### 驗收

- `npx tsc --noEmit`：0 錯（只餘 `layout.tsx` 已知 false positive `LayoutProps`）。
- 真正 `next build` 建議用家 dev box 跑一次確認（Vercel build 無礙）。
- UAT 帳號 `60000001`/`1111`（店主）、`60000003`（會員）聯測充值 / 餐牌 realtime / 線上單唔落 POS DB。
