# 157 · macau-pos Admin 多店控制台方案（2026-10-21）

> 狀態：**§7 已於 2026-10-21 拍板（D1–D5）**。仍未改任何 code／migration（除本文件）。
> 決議與執行清單見 `docs/159-multi-store-admin-decisions-and-build-plan-2026-10-21.md`；
> 向 Ledger 嘅需求文件見 `docs/158-ledger-admin-report-rpc-requirement-2026-10-21.md`。
> 相關：`.workbuddy/memory/2026-10-21.md`、`docs/89`（admin 鑑權）、`docs/156`（營業額對齊）、
> `supabase/migrations/0024`（store id 對齊）、`src/lib/admin-session-token.ts`。
> 已拍板（2026-10-21）：① 要**可寫**（改菜單／任何 POS 設定），可一次套用多店；② 沿用 8 位帳號 + PIN；
> ③ 一帳號多店，可見範圍由**大 admin** 設定；④ 營業額可跨店加總，會員數／客流**不可**跨店相加。

---

## 0. 一句話

目標唔係「加幾個頁面」，而係補一層**店舖範圍（scope）授權**：
而家 admin panel 只有「有冇 token」二分法，任何一張 admin token 都等於**全平台通行證**（可以停用其他商家、
改其他店模組、讀全部店訂單）。所以第一步必須係 scope，之後才輪到「多店 UI」同「多店寫入」。

---

## 1. 現況（讀碼事實，2026-10-21 核對）

### 1.1 三個「後台」入口，只有一個有真鑑權

| 入口 | 頁面 | 鑑權 | 狀態 |
|---|---|---|---|
| `/admin` | dashboard / reports / sessions / traffic / versions | `adminSessionToken`（12h HMAC）＋ 登入要 `manageAccounts` | **現役**，對外派帳號嘅起點 |
| `/backoffice` | overview / stores / stores/[id] / accounts / sync | `AuthGuard allowedRoles:["admin"]`（**純前端 localStorage**） | 早期後台，資料多數走 `mock-data` fallback |
| `/api/backoffice/*` | overview（有閘）／`stores/[storeId]` PATCH（**冇閘**） | 混合 | 🔴 見 §2 R4 |

### 1.2 admin token 只有「身份」，冇「範圍」

```ts
// src/lib/admin-session-token.ts:31-38
type AdminSessionClaims = { account: string; role: UserRole; exp: number };
```

### 1.3 九條 admin API 全部只驗 token，冇一條驗店

| Route | 方法 | 現時行為 | 一旦派帳號會發生咩 |
|---|---|---|---|
| `/api/admin/merchants` | GET | `select` **Ledger `merchants` 全表** + 每店 POS 統計 | 睇晒全平台所有店名、營業額 |
| `/api/admin/orders` | GET | 唔帶 `storeId` = 跨**全部**店 | 讀晒所有商戶訂單 |
| `/api/admin/ledger/orders` | GET | 唔帶 `merchantId` = 全部商家線上單 | 同上 |
| `/api/admin/merchants/status` | **PATCH** | 任意 `merchantId` 停用／啟用 | **可以停人地盤** |
| `/api/admin/merchants/modules` | GET/**PATCH** | 任意 `merchantId` 讀寫模組授權 | **可以改人地功能** |
| `/api/admin/sessions` | GET/PATCH | 全部店 POS 分頁 | 睇到他店運作＋強制關閉 |
| `/api/admin/traffic` | GET | 全部店 egress | 睇他店用量 |
| `/api/admin/release-versions` | GET/POST | 全平台版本 | 影響全平台 |
| `/api/admin/session` | POST | 8 位帳號 + PIN 換 token | — |

### 1.4 多店資料模型**已經存在**，但授權層冇用

```
admin_account_users(id, account, pin_hash, role, permission_group_id, active, ...)
admin_account_store_bindings(id, account_id, store_id, merchant_id)   ← migration 0024 加咗 merchant_id
admin_stores(id, name, merchant_id, active, ...)
admin_permission_groups(id, code, name, role, permissions jsonb)
```

`admin-account-server.ts:177-201` 其實已經把 bindings 讀成 `session.storeIds` 放返 session —— 但
`/api/admin/session` 簽 token 嗰陣**完全冇帶 scope**，所以後續每條 route 都唔知。

### 1.5 關鍵事實：`storeId == Ledger merchantId`，1 merchant = 1 store

Ledger 冇「老闆／集團」實體（`0024` 註解已寫明 POS DB 冇 `merchants` 表，跨庫唔可以建 FK）。
所以「一個老闆 5 間店」＝ 5 個**互不相識**的 merchant UUID；「邊幾個店屬於同一個老闆」只能存喺 POS 側。

---

## 2. 根因

- **R1｜授權模型缺一維**：token 只表達「係邊個」，唔表達「管邊幾間」。所有 route 因此無法收窄。
- **R2｜範圍由前端決定**：`?storeId=` / `?merchantId=` 由 client 任傳，server 直接信。前端下拉「全部商家」
  其實係「後端無 filter」——呢個正是最容易洩漏嘅寫法。
- **R3｜讀寫同一條 token 同一把鎖**：`merchants/status`（停用商家）同 `orders`（讀單）用同一張 token，
  派出去等於連「平台管理權」一齊派。
- **R4｜`/api/backoffice/stores/[storeId]` PATCH 完全冇鑑權**（`src/app/api/backoffice/stores/[storeId]/route.ts:19-31`
  直接 `updateBackofficeStoreActiveOnServer()`，寫 `admin_stores.active`）。任何人 POST 一個 storeId 就改得。
  `/backoffice` 嘅 `AuthGuard` 只係前端，繞過成本 = 0。**呢個要喺派帳號前修**。

---

## 3. 三個選項

| | A｜POS 側租戶 scope（**推薦**） | B｜Ledger SSO + merchant_group | C｜唯讀簽名分享連結 |
|---|---|---|---|
| 做法 | POS 自己管帳號 ↔ 店舖，server 端解析 scope | Ledger 做「集團」實體，POS 信 Ledger JWT | 簽名 URL 帶 `storeIds` + 到期 |
| 改動 | POS 內；~6–9 人日（4 個 phase） | 要改 Ledger（新表 + RPC + JWT 範圍）＋ POS | POS 內，~0.5 人日 |
| 會員 KPI | 仍缺（要 §4.6 補） | 直接有 | 仍缺 |
| 撤權 | 即時（scope 由 DB 解析） | 即時 | 只能等連結過期 |
| 適合 | 對外賣 SaaS、要審計 | 老闆只用一個 Ledger 帳號 | 臨時／唯讀給老闆看 |
| 結論 | **做主線** | 之後再談（跨團隊） | 可做過渡 |

---

## 4. 方案 A 設計

### 4.1 角色三層

| 角色 | 表達方式 | scope | 可寫 | 看到嘅 nav |
|---|---|---|---|---|
| `platform`（你） | `permission_groups.permissions.scopeAllStores = true` | 全部店 | 全部 | 全部 |
| `owner`（老闆） | 綁 N 店（bindings） | 自己店 | L1 + L2（§4.5） | 總覽／報表／菜單／設定 |
| `store_manager`（店長） | 綁 1 店 | 自己店 | 可選（建議同 owner 但限 1 店） | 同上 |

刻意**唔用** `role: admin` 做額外語義 —— `role` 仲用於 POS 端（`admin|manager|cashier`），
加一個獨立 flag 唔會影響 POS 判斷。

### 4.2 Scope 解析（唯一真源，server 端）

```ts
// 新增 src/lib/admin-scope.server.ts
type AdminScope =
  | { all: true; storeIds: null }
  | { all: false; storeIds: string[] };   // 空陣列 = 乜都睇唔到（fail closed）

async function resolveAdminScope(account: string): Promise<AdminScope>
```

- **唔寫入 token**：token 維持 `{account, role, exp}`。改 binding／停用帳號 ⇒ 下一個 request 即時生效，
  唔使等 12 小時 token 過期（現時 stateless token 冇得撤銷，呢點對「對外商戶」太危險）。
- 每次 request 查一次 DB（`admin_account_users` + `admin_account_store_bindings`），
  加 **30 秒 per-instance memory cache**；`PATCH` 寫入時主動清 cache。
- `merchant_id` 優先，`store_id` 為 fallback（0024 回填未完成時照行）。

### 4.3 統一守衛

```ts
// 新增 src/lib/admin-guard.server.ts
export async function requireAdmin(
  request: Request,
  need: { platform?: true; write?: boolean },
): Promise<{ ok: true; claims; scope } | { ok: false; res: NextResponse }>;
```

規則（**全部 fail closed**）：

1. 冇 token → 401。
2. `need.platform` 而 `scope.all !== true` → **403**。
3. 查詢帶 `storeId` / `merchantId` → 必須 `scope.all || scope.storeIds.includes(id)`，否則 403。
4. 唔帶 store 參數（＝彙總）→ **唔可以當「全部」**，一律用 `scope.storeIds` 做 `in()` 過濾；
   `scope.all` 才准 null。
5. 寫操作（`need.write`）→ 再驗 §4.5 分級白名單。

對照表：

| Route | 新守衛 | scope 應用 |
|---|---|---|
| `admin/session` | 不變（登入） | 回傳 `scope` 摘要畀前端 |
| `admin/me`（**新增**） | token | 回 `{account, name, scope:{all, stores[{id,name}]}, caps}` |
| `admin/merchants` | token | 只回 scope 內店；`scope.all` 才回全表 |
| `admin/orders` | token | `storeId` 驗 scope；無參數 → `in(scope.storeIds)` |
| `admin/ledger/orders` | token | 同上（`merchantId` → `in()`） |
| `admin/merchants/status` | `platform` + write | 平台專屬 |
| `admin/merchants/modules` | GET: token（限 scope）；PATCH: `platform` | 老闆睇得到自己店模組但改唔到（除非 J 決定放） |
| `admin/sessions` | `platform` | 平台專屬（他店分頁＝營運情報） |
| `admin/traffic` | `platform` | 平台專屬（成本情報） |
| `admin/release-versions` | `platform` | 平台專屬 |

### 4.4 DB 層配套

`pos_orders_page(p_store_id text)` 只支援「一店 or 全部」（`src/lib/pos-orders-range.ts:runRpc`）。
多店 scope 有兩條路：

- **首選**：新 migration 加 `p_store_ids text[]`（overload 或新參數，additive），一次 round trip。
- 次選：逐店呼叫再喺 Node merge —— N 倍請求，egress 差，**唔建議**。

同時 `fetchOrdersInRange()` 加 `storeIds?: string[] | null`，`storeId` 保留給 POS 本地路徑（唔好一次改兩邊語義）。

### 4.5 寫入分級（J 要求「一次過改多店」）

| 級別 | 內容 | 表／通道 | 開放？ |
|---|---|---|---|
| **L1 店舖設定** | 會員規則、付款方式、服務費、線上單設定、Kiosk 設定、備註預設、打印模板、模組開關（自己店） | `pos_bootstrap_config`（`rules`/`paymentMethods`）、`pos_online_order_settings`、`pos_kiosk_settings`、`pos_note_presets`、`pos_print_templates`、`pos_merchant_modules` | ✅ owner 可寫 |
| **L2 菜單** | 分類、菜式、規格、價格、售罄 | 同 `pos_bootstrap_config` 內 `menu` 結構 ＋ `pos_soldout` | ✅ owner 可寫 |
| **L3 交易** | 退款、刪單、返結、交班、列印任務、工作階段 | `pos_orders`、`pos_shifts`、`pos_print_jobs`、`pos_sessions` | ❌ 平台專屬 |
| **L4 裝置** | 打印機配對、終端名、本機設定 | `pos_device_configs`（**per device**） | ⚠️ 二期再議（要揀邊部機，誤改＝收銀癱瘓） |

🔴 **寫入紀律（唔可以繞）**：

1. 一律走現有 normalize 通道（`normalizeBootstrapPayload()` / `normalizePosLocalSettings()`），
   **唔可以自己砌 JSON 直接 upsert** —— 呢兩支都係 whitelist，漏加欄位會**靜靜剷走**（2026-10-20 已中過）。
2. 寫入前後要 `select` 回讀核對（至少對「改動嘅 key」），唔一致就報錯而唔係回 `ok:true`。
3. 每次寫入落 `admin_audit_log`（§附錄 B）。

**批量套用（apply to N stores）**：

- UI：勾店 → 顯示「將套用嘅變更」diff（邊個欄位、由咩改成咩）→ 確認 → 逐店執行。
- 結果**必須逐店回報**（成功／失敗＋原因），支援「部分成功」；唔可以一個 toast 講「已完成」。
- 建議先 `dryRun: true` 回 diff，用戶確認後才 `dryRun: false`（避免一次改 5 間店冇得返轉頭）。
- 唔提供「一鍵覆蓋全部店菜單」——危險度太高；只准「明確勾選嘅店」。

### 4.6 會員 KPI（跨店）——兩條路

**背景**：`get_merchant_report_summary` **冇 `p_merchant_id`**，商戶由 `auth.uid()` 推導
（`src/lib/ledger/reports.ts:74`、`member-list.ts:12` 明文寫「唔好傳」）。所以 admin 帳號（冇商戶身份）
永遠拿唔到會員類數字 —— 呢個就係剛被移除嗰塊天藍提示卡嘅根源。

| | B1｜Ledger 加 admin 版 RPC（**推薦**） | B2｜多憑證（老闆逐店輸 PIN） |
|---|---|---|
| 做法 | Ledger 加 `get_merchant_report_summary_admin(p_merchant_id)`，**只准 service_role** 呼叫 | POS 逐店用該店帳號換 JWT，存 server，逐店打現有 RPC |
| 要唔要老闆輸 5 次 PIN | 唔使 | 要（主店登入後再逐店加） |
| 依賴 | 要 Ledger 團隊配合 | 唔使改 Ledger |
| 風險 | RPC 一旦漏 service_role 檢查 = 全平台會員資料外洩 | 老闆要交出多店 PIN；要代管 N 組 refresh token |
| 工作量 | Ledger 1–2 日 + POS 1 日 | POS 3–4 日 |

**B2 可行性（已核實程式）**：Ledger 登入 = `8位帳號 → email`、`PIN → password`（`pin.server.ts`），
Supabase Auth 回 `access_token` + `refresh_token`，兩者都係不透明字串，**同時持 N 份冇問題**。
`POST /api/ledger/login` 已經係 server 端換票，PIN 唔需要落地。

三個硬限制（B2 唔可以照抄現有 client 結構）：

1. `getLedgerSupabaseClient()` 係 **singleton**（`persistSession:false`，session 在記憶體）；
   `ensureLedgerSession()` 係 single-flight，假設「一個身份」⇒ 一個 client 唔可以持 N 個身份。
2. refresh token **會輪換**（`session.ts:37-47` 就係為呢個坑寫嘅）⇒ N 店要各自刷新，client 側做會互相踩。
3. RPC 由 `auth.uid()` 推導商戶 ⇒ 一個 JWT 只對應一店。

**B2 設計（若拍板）**：憑證存 **server DB**（加密欄），client 只存 `credentialId`；
server 用該店 token 建臨時 client 打 RPC、代刷 refresh。UI 顯示每店狀態
（已連接／憑證失效／未加入）——「某店斷咗」要**明示**，唔可以靜靜少一間（即 J 講嘅「斷層」）。

> ⚠️ **待驗證**：`/api/ledger/login` 查 `merchant_staff` 用 `.limit(1)`
> （`src/app/api/ledger/login/route.ts:99-117`）。如果一個 Ledger 帳號本身已綁多店，
> 會被硬截成 1 店 —— 咁 B2 就變成**必要**；如果支援，B2 只係後備（某店帳號唔同時用）。
> 驗法：用該帳號 JWT 查 `merchant_staff where user_id = <uid>` 有幾行。
> 本機冇 `.env.local`（缺 `AUTH_PIN_PEPPER`），要喺有 env 嘅環境跑。

---

## 5. 分階段（每階段都可獨立上線）

| Phase | 內容 | 人日 | 上線風險 |
|---|---|---|---|
| **P0 安全底座** | ① 強制獨立 `ADMIN_SESSION_SECRET`（現時 fallback 用 service role key ⇒ 洩漏即偽造 admin token）② `/api/admin/session` IP rate limit ＋ **per-account 失敗鎖定（5 次 / 15 分鐘，落 DB）**（D2 沿用 4 位 PIN ⇒ 此項必需）③ 補 `/api/backoffice/stores/[storeId]` 鑑權 ④ 建 `admin_audit_log` | 1.5 | 低（只收緊） |
| **P1 scope 授權 + 多店讀取** | `admin-scope.server.ts` / `admin-guard.server.ts` / `/api/admin/me`；9 條 route 接守衛；`pos_orders_page` 加 `p_store_ids`；前端店舖多選 + nav 過濾 | 2–3 | 中（改既有 route，要逐條測） |
| **P2 商戶帳號管理** | 大 admin 建 `owner` 帳號、勾店、停用；首登改 PIN；`/admin/accounts` 頁 | 1–2 | 低 |
| **P3 多店寫入** | L1/L2 寫入 API + 批量套用（dry-run diff、逐店結果）+ 審計 | 3–4 | **高**（改到真數據） |
| **P4 會員 KPI** | B1（Ledger RPC）優先；B1 唔成再行 B2 | 2–4 | 中 |

**P0 一定要先行**：P1 之後就有帳號可以派，但 P0 未做 = 派出去嘅帳號可以被暴力試 PIN、且服務 key 可偽造 token。

---

## 6. 驗收準則

**安全（唔通過唔准上線）**

- [ ] 用 A 店帳號打 `GET /api/admin/orders?storeId=<B>` → **403**
- [ ] 用 A 店帳號打 `GET /api/admin/orders`（無參數）→ 只回 A 店單
- [ ] 用 A 店帳號打 `PATCH /api/admin/merchants/status` → **403**
- [ ] 用 A 店帳號打 `GET /api/admin/merchants` → 只回 A 店
- [ ] 匿名打 `PATCH /api/backoffice/stores/<id>` → **401**
- [ ] 停用帳號後，**下一個 request** 即 401／403（唔使等 token 過期）
- [ ] 冇 `ADMIN_SESSION_SECRET` 時登入 fail closed（唔會 fallback 到 service key）

**功能**

- [ ] 一個 owner 帳號勾 3 店 → 登入後「我的店舖」預設全選，報表顯示 3 店彙總
- [ ] 跨店彙總：營業額 = 3 店相加；會員數／客流**逐店列**、唔相加
- [ ] 批量改菜單：3 店改 1 個價格 → 逐店成功／失敗清楚可見；有 1 店失敗時另外 2 店照成功且**有紀錄**

**口徑**

- [ ] 多店彙總營業額 = 逐店報表相加（用 `totalRevenueNetMop`，唔可以混毛／淨）
- [ ] 多幣值仍然分開（`byCurrency`），唔會把 MOP 同其他幣加埋

---

## 7. 已拍板（2026-10-21）

| # | 問題 | **決定** | 對方案嘅影響 |
|---|---|---|---|
| D1 | 老闆可寫範圍 | **L1 + L2 可寫**（店舖設定 ＋ 菜單／價格／售罄）；L3 交易、L4 裝置一律平台專屬 | P3 照原設計做；`need.write` 白名單由 §4.5 表驅動 |
| D2 | 老闆帳號 PIN 位數 | **沿用 4 位**（否決 6 位） | ⚠️ 4 位只有 10⁴ 組合、帳號＝電話（公開可枚舉）⇒ **per-account 失敗鎖定變成 P0 必需項**，唔可以只靠 IP rate limit。連帶要加：連續失敗 5 次鎖 15 分鐘、鎖定期間唔可以再試（唔理 IP）、`admin_audit_log` 記 `login_failed` |
| D3 | 會員 KPI 路線 | **先問 Ledger**（admin 版 RPC），`docs/158` 發出；B2 多憑證留作後備 | P4 改為「等 Ledger 回覆」，POS 側**先唔做** B2；Ledger 回覆「唔做／好慢」才啟動 B2（3–4 人日） |
| D4 | 「模組開關」邊個改 | **只有平台** | `/api/admin/merchants/modules` PATCH → `need.platform`；老闆**唯讀**自己店模組（睇得到自己開通咗咩，改唔到） |
| D5 | 一個 owner 最多綁幾店 | **20** | `resolveAdminScope()` 上限 20，超出 → 建號／綁店時 400；報表分批（每批 10 店）避免單次查詢過大 |

> D2 嘅補償措施已寫入 `docs/159` §3（P0 必做，唔做唔准派帳號）。

---

## 8. 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| 先派帳號、後做 scope | 全平台資料外洩 + 可停人地盤 | P1 完成前**唔派任何帳號** |
| 批量寫入「部分成功」處理唔好 | 5 間店 3 間改咗、2 間冇，商家以為全部改完 | dry-run diff + 逐店結果 + 審計 |
| 繞過 `normalizeBootstrapPayload` 寫 JSON | 欄位靜靜被剷（歷史高頻 bug） | 只准走 normalize 通道；寫後回讀核對 |
| 多店 = N 倍 egress | `pos_orders` 本來就係最大來源 | `p_store_ids` 單次查詢 + 60s cache + 只拉需要欄位 |
| `ADMIN_SESSION_SECRET` 用 service key fallback | service key 洩漏 ⇒ 可偽造 admin token；rotate 服務 key ⇒ 全員靜靜被登出 | P0 強制獨立 secret，未設 = fail closed |
| B2 代管 N 組 refresh token | token 洩漏 = 5 間店被接管 | 存 server + 加密欄 + 只准 service_role 讀；唔存瀏覽器 |
| `merchant_staff.limit(1)` 未驗證 | B2 可能白做（或反之，根本唔需要 B2） | 先做 §4.6 嘅驗證查詢 |

---

## 附錄 A：新增／改動檔案清單（預計）

**新增**

```
src/lib/admin-scope.server.ts          # resolveAdminScope() + cache
src/lib/admin-guard.server.ts          # requireAdmin()
src/lib/admin-audit.server.ts          # 寫 admin_audit_log
src/app/api/admin/me/route.ts          # 回 scope + caps
src/app/api/admin/stores/write/route.ts# P3：L1/L2 寫入 + dryRun（或按資源拆幾條）
src/app/admin/accounts/page.tsx        # P2：商戶帳號管理
docs/157-...（本檔）
```

**改動**

```
src/app/api/admin/{merchants,orders,ledger/orders,merchants/status,merchants/modules,sessions,traffic,release-versions}/route.ts
src/lib/pos-orders-range.ts            # storeIds?: string[]（+ p_store_ids）
src/lib/admin-session-token.ts         # 可選：claims 加 caps 摘要（scope 仍由 DB 解析）
src/components/admin-shell.tsx         # 店舖多選 + nav 過濾
src/app/admin/reports/page.tsx         # allStoresMode → { storeIds }
src/components/restaurant-daily-report.tsx # 支援 storeIds 範圍
```

## 附錄 B：migration 草案（P0 / P1）

```sql
-- P0：審計
create table if not exists admin_audit_log (
  id bigserial primary key,
  account text not null,
  action text not null,          -- 'read' | 'write' | 'login'
  target text,                   -- 資源（menu.price / merchant.status ...）
  store_ids text[],              -- 涉及邊幾間店
  detail jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_audit_account_time on admin_audit_log (account, created_at desc);

-- P1：多店範圍查詢（additive；舊 client 照用 p_store_id）
-- 注意：pos_orders.store_id 係 text（migration 0012），唔係 uuid
create or replace function pos_orders_page_scoped(
  p_store_ids text[], p_start timestamptz, p_end timestamptz, p_limit int, p_offset int
) returns setof pos_orders language sql stable as $$ ... $$;
```

## 附錄 C：B2 多憑證流程（若拍板）

```
owner 登入主店（8位+PIN）
  └─ POST /api/admin/session            → adminSessionToken（含 account）
  └─ GET  /api/admin/me                 → scope.stores = [主店]
「＋ 加入其他店舖」
  └─ POST /api/admin/multi-store/link   { storeAccount, pin }
        server: /api/ledger/login 同等流程 → 得 merchantId + tokens
        驗：merchantId ∈ scope.storeIds（大 admin 已授權）
        存：admin_store_ledger_credentials（encrypted，只 service_role 可讀）
        回：{ merchantId, name, status: 'linked' }   ← PIN 唔落地
  └─ 重複 5 次
報表（跨店）
  └─ GET /api/admin/multi-store/report?storeIds=…
        server 逐店用對應 token 打 get_merchant_report_summary
        回：{ perStore: [...], totals: { revenueMop } }   ← 只加金額，不加會員/客流
斷層處理
  └─ 某店 token refresh 失敗 → status: 'expired' → UI 紅字「請重新輸入該店 PIN」
```
