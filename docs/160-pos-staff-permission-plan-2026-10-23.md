# 160 · POS 店員帳號與權限控制（權限控制頁）· 設計與落地

> 2026-10-23 · 狀態：**已實作（未部署）**
> 需求來源：J 與商家確認「唔同員工要唔同權限」；並明確兩點：
> ① **員工唔一定個個有 Ledger 戶口**；② 要喺 **admin panel** 同 **POS 設定頁** 各有一個
> 「權限控制」，**只店主登入後才顯示**。
> 前置評估：`docs/123-pos-staff-pin-permission-feasibility.md`（2026-09-11，結論一致）。

---

## 0. 一句話

**身份留喺 Ledger，權限一定係 POS 本地。** 店主喺兩個入口設定員工角色／可見頁面／操作權限；
員工用「工號 + PIN」簽到（**唔需要 Ledger 戶口**）；Ledger 側零改動。

---

## 1. 為何唔用 Ledger 嘅角色（契約級證據）

| # | 事實 | 位置 |
|---|---|---|
| 1 | `merchant_staff` 只有 `staff_role`（`owner` \| `staff`），**冇 `role` 欄**，契約明文「勿 invent」 | `docs/integration/ledger-client-api.md` §4.3 |
| 2 | 契約寫明 `staff_role` 係「**映射 POS 本地權限用**」 | 同上 §4.3（L175） |
| 3 | RPC 權限閘只有 `is_merchant_staff()` —— 一個 boolean，唔係 per-action permission | 同上 §5 |
| 4 | 前端 session 見到嘅 role / permissions **本來就係 POS 自己計**（`mapLedgerStaffRole()` + 硬編碼 ternary） | `src/app/api/ledger/login/route.ts` |

⇒ Ledger 只答「係唔係本店員工」，答唔到「店長定收銀、睇唔睇到報表」。
再加上「員工唔一定有 Ledger 戶口」，權限層別無選擇，一定要 POS 本地。

---

## 2. 分層架構

```
L1 裝置登入（Ledger，8 位電話 + PIN）
   └─ 證明：呢部機屬於邊間店（merchantId）＋ 拎 ledger token ＋ pv1 終端憑證
        │
L2 店員簽到（POS 本地，工號 + PIN）   ← 2026-10-23 新增
   └─ 證明：而家係邊個店員、可做咩（sv1 操作員 token）
        │
UI 權限 = L2 有簽到 ? 操作員權限 : L1 session 權限（店主全開 / staff 收緊）
```

**重要邊界：**

- **店主唔入 `pos_staff` 表**：Ledger `staff_role = owner` 的人永遠全開，亦係唯一見得到
  「權限控制」入口的人。
- **冇 L2 簽到 = 完全維持現狀**（今日所有店鋪行為零變化）。
- 客人掃碼、Kiosk、KDS 唔需要 L2（裝置角色）。

---

## 3. 資料模型（migration `0072_pos_staff_permissions.sql`）

表 `pos_staff`（POS Supabase，**service_role only**）：

| 欄 | 說明 |
|---|---|
| `store_id` | = Ledger `merchants.id`（同 `pos_orders.store_id` 同一口徑） |
| `staff_no` | 工號，同店唯一（`lower(btrim())` unique index） |
| `name` / `role` | `role ∈ {manager, cashier}`（`admin` 刻意唔入此表） |
| `permissions` | jsonb `{pages:{...}, actions:{...}}` |
| `pin_hash` / `pin_salt` / `pin_algo` | **PBKDF2-SHA256 120k iter** ＋ per-row salt；**永不存明文** |
| `failed_attempts` / `locked_until` | 連續 5 次錯 → 鎖 15 分鐘 |
| `active` | 停用（軟刪除，保留歷史） |

⚠️ **migration 要人手跑**（POS 專案 SQL Editor）。未跑時 API 回 `tableReady:false`，
UI 顯示「請執行 0072」，唔會爆 500。

---

## 4. 權限模型（`src/lib/pos/staff-core.ts`，零 import）

**兩組權限：**

- `pages`（員工「睇得到」邊幾頁）：`order` / `orders` / `members` / `prints` /
  `reports` / `soldout` / `shift` / `inventory` —— id 對齊 `module-catalog.ts`
  的 `SIDEBAR_MODULES`（有契約測試防漂移）。
- `actions`（員工「做得到」咩）：`voidItem` / `refundOrder` / `reopenOrder` /
  `applyDiscount` / `reprintReceipt` / `closeShift` / `deviceSettings`。

**角色預設：**

| | manager 店長 | cashier 收銀 |
|---|---|---|
| 頁面 | 全開 | 點餐／訂單／會員／打印／交班 |
| 退菜 / 退款 / 折扣 / 設備設定 | ✅ | ❌ |
| 補打 / 交班 / 返結 | ✅ | ✅（**保持今日實際行為**） |

🔴 **三條不變量**

1. **白名單正規化**：加新權限**一定**要同時加落 `POS_STAFF_PAGE_IDS` /
   `POS_STAFF_ACTION_IDS`，否則 UI 勾咗、入庫成功、讀出嚟被靜靜剷走。
2. **缺欄 = 角色預設**（唔係 false），避免升級後全店忽然冇權限。
3. **fail closed**：`canSeePage(null)` / `canDoAction(undefined)` 一律 false。

---

## 5. API

| Route | 方法 | 用途 | 鑑權 |
|---|---|---|---|
| `/api/pos/staff` | GET / POST | 列表 / 新增 | `requireStoreOwner()` |
| `/api/pos/staff/[staffId]` | PATCH / DELETE | 修改 / 停用 | 同上 |
| `/api/pos/staff/login` | POST | 店員簽到（工號＋PIN） | 無（IP 限流 10/min ＋ 每人鎖定） |

`requireStoreOwner()` 兩條通道（`src/lib/pos/owner-guard.server.ts`）：

- **Admin 通道**：`adminSessionToken` → `resolveAdminScope()` → scope 含該店；
- **Ledger 通道**：`x-pos-ledger-token` → 驗 user → `merchant_staff` 必須
  `merchant_id === storeId` 且 `staff_role === owner`。

簽到成功 → 簽發 `sv1` HMAC token（`staff-operator-token.ts`，12h），
payload 含 role + permissions，secret 同 `pv1` 共用（`resolvePosTokenSecret()`）。

---

## 6. UI 入口（兩個，同一元件）

| 入口 | 檔案 | 憑證 |
|---|---|---|
| POS 設定頁 › **權限控制**（tab 排最後） | `device-settings.tsx` + `staff-permission-panel.tsx` | Ledger access token |
| 後台 `/admin/staff`（nav「權限控制」） | `src/app/admin/staff/page.tsx` + 同一面板 | `adminSessionToken` |

可見性規則：POS 設定頁 tab 只在 `role === "admin"`（= Ledger owner）**且**有 `merchantId` 時出現；
admin 頁按 `resolveAdminScope()`（店主只見自己店、平台見全部）。

店員簽到入口：`/operator`（側欄底部「簽到」／手機底欄「簽到」）。

---

## 7. 上線步驟（**唔可以調亂**）

1. **POS Supabase** → SQL Editor 貼 `supabase/migrations/0072_pos_staff_permissions.sql`。
2. **POS Supabase** → SQL Editor 貼 `supabase/migrations/0073_pos_bound_devices.sql`（§10 裝置授權）。
3. 確認 server env 有其中一條（簽 token 用）：
   `POS_DEVICE_TOKEN_SECRET` ／ `ADMIN_SESSION_SECRET` ／ `SUPABASE_SERVICE_ROLE_KEY`。
   **改完 env 一定要重新部署**（env 只對新部署生效 —— memory 高頻坑）。
   ⚠️ 同一條 secret 亦用嚟加密 `pos_bound_devices.refresh_token_enc`；**換 secret = 所有已授權裝置即刻失效**（要重新授權）。
4. Push 到 `main` → Vercel 自動部署。
5. 店主登入 POS → 設定 › 權限控制 → 新增一位店長、一位收銀（各設 4 位 PIN）。
6. 同一頁 › 裝置授權 → **授權呢部機**（店主只需做一次）。
7. 換部機（或登出 L1）測試 `/operator` 用工號 + PIN 簽到 —— 應該**唔需要**店主帳密。

**驗收清單：**

- [ ] 收銀員簽到後，側欄冇「報表／庫存」；退菜／退款粒掣被攔並提示「請使用店長帳號」。
- [ ] 店長簽到後全部可用；`/settings` 入得。
- [ ] 收銀員冇 `deviceSettings` → `/settings` 顯示「冇設定權限」，側欄冇「設置」。
- [ ] 連續 5 次錯 PIN → 鎖 15 分鐘（正確 PIN 都拒）。
- [ ] 停用員工 → 即刻簽到唔到（已簽到嘅 session 仍然有效，最長 12h）。
- [ ] 非店主（Ledger `staff`）用 `x-pos-ledger-token` 打 `/api/pos/staff` → 403。
- [ ] 店主 A 店帳號打 B 店 storeId → 403。
- [ ] DB 查 `pos_staff`：**冇任何明文 PIN**。
- [ ] 裝置授權：店主授權後清 localStorage（或換瀏覽器）→ 開機應自動還原 → 跳 `/operator`，**唔使**店主帳密。
- [ ] 撤銷裝置後，該機再開機 → 回 `/login`，並提示要店主重新授權。
- [ ] 店主按「登出」→ 唔會自動登入（回登入頁）；登入頁有「店員簽到」入口可復原。

---

## 8. 明確唔做（今次）

| 項目 | 原因 |
|---|---|
| 伺服器端逐個操作驗 `sv1`（例如 `/api/pos/sync` 的退菜事件） | 要改寫 sync route 事件分流，風險高；列 **Phase 2**。今日權限 gate 係 UX 層，管理 API 已經 server 驗。 |
| 離線簽到（快取 PIN hash） | POS 離線優先，但離線驗證涉及快取有效期／對帳，Phase 2。今日離線時簽到失敗即沿用現有 L1 行為。 |
| 跨店店員（一人多店） | `store_id` scoped；日後再擴。 |
| 員工審計欄位（`pos_shifts.staff_id`） | 只增不改原則；Phase 2 再加。 |
| Ledger 任何改動 | 契約禁止；亦冇必要。 |

---

## 9. 改動檔案

**新增**

- `supabase/migrations/0072_pos_staff_permissions.sql`
- `src/lib/pos/staff-core.ts` / `staff-core.test.ts`（零 import ＋ 契約測試）
- `src/lib/pos/staff-pin.ts` / `staff-pin.test.ts`
- `src/lib/pos/staff-server.ts`
- `src/lib/pos/staff-operator-token.ts`
- `src/lib/pos/owner-guard.server.ts`
- `src/lib/pos/operator-session.ts`
- `src/app/api/pos/staff/route.ts`、`[staffId]/route.ts`、`login/route.ts`
- `src/components/staff-permission-panel.tsx`
- `src/components/operator-signin-screen.tsx`
- `src/components/settings-gate.tsx`
- `src/app/admin/staff/page.tsx`、`src/app/operator/page.tsx`

**修改**

- `src/components/device-settings.tsx`（新增「權限控制」tab，店主限定）
- `src/components/app-sidebar.tsx`（操作員過濾可見模組＋簽到入口）
- `src/components/admin-shell.tsx`（nav 加「權限控制」）
- `src/app/settings/page.tsx`（`SettingsGate`）
- `src/components/pos-app.tsx`（退菜／退款 gate 讀操作員權限）
- `src/lib/pos/pos-device-token.ts`（export `resolvePosTokenSecret`）
- `src/lib/pos/order-only-terminal.ts`（`/operator` 加入白名單）
- `src/lib/i18n-dict-en.ts` / `i18n-dict-zh.ts`（簽到／操作員／員工工號）

---

## 10. 裝置授權 —— 補 L1 缺口（2026-10-23 同日追加）

### 10.1 問題（J 提出）

> 「我而家首先要用店主帳號登入完，才能再用員工號登入，咁咪即係要知店主帳號密碼先開得機？」

**完全正確，呢個係原設計嘅缺口。** L2（工號 + PIN）依附 L1（店舖登入），
而 L1 唯一通道係 **店主嘅 Ledger 8 位帳號 + PIN**：

```
L1 店舖登入（Ledger，只有店主有）
   └─ L2 店員簽到（工號 + PIN）
```

⇒ 新機、換瀏覽器、清 cache、店主按過「登出」之後，店員開機**一定要店主到場**。
同「員工唔一定有 Ledger 戶口」嘅前提自相矛盾，亦令店主 PIN 變成「開機鑰匙」。

> 補充邊界：同一部機、同一個瀏覽器、冇按「登出」嘅話，L1 session 本身冇 TTL，
> `pv1` 12 小時過期亦會自動續期 ⇒ 日常運作唔會日日要店主。問題只喺「要重新建立
> L1」嘅場景。

### 10.2 解法：裝置授權（店主授權一次）

```
L0 裝置授權（pos_bound_devices，店主一次性）
   └─ 開機：裝置 secret → 換返完整 L1 session → 直接跳 /operator
        └─ L2 店員簽到（工號 + PIN）
```

| 動作 | 觸發 | 結果 |
|---|---|---|
| **授權** | 店主喺設定 › 權限控制 › 裝置授權 ›「授權呢部機」 | server 記一筆，回一個 32-byte secret（本機保存） |
| **開機** | 冇 L1 session 但有本機授權 | `POST /api/pos/device/session` → 完整 session → `/operator` |
| **續期** | 客戶端每次輪換 refresh token | `PATCH /api/pos/device/session` 同步返 server 副本 |
| **撤銷** | 權限控制 › 裝置授權 ›「撤銷」 | 即刻唔可以再換 session（已開嘅機最長 12h） |
| **登出** | 側欄「登出」 | 寫 `device-signed-out` 標記，**唔會**自動登入；登入頁有「店員簽到」入口 |

### 10.3 資料模型（migration `0073_pos_bound_devices.sql`）

`pos_bound_devices`（POS Supabase，service_role only）：

| 欄 | 說明 |
|---|---|
| `id` | `${store_id}:${device_id}`（同 `pos_sessions` 同一手法） |
| `device_id` | 客戶端 `crypto.randomUUID()`，存 `macau-pos/device-id` |
| `secret_hash` | 客戶端 secret 嘅 SHA-256；**DB 冇明文 secret** |
| `refresh_token_enc` | Ledger refresh token，**AES-256-GCM**（`v1.<iv>.<tag>.<ct>`） |
| `bound_by` / `bound_at` / `last_seen_at` / `revoked_at` | 審計 + 軟刪除 |

🔴 **金鑰**：由 `resolvePosTokenSecret()` 派生（`POS_DEVICE_TOKEN_SECRET` →
`ADMIN_SESSION_SECRET` → service role key）。冇 secret = 授權 API fail closed（503）。
**換 secret = 所有已授權裝置即刻失效**（解密失敗 ⇒ 要重新授權）。

### 10.4 為何要存 refresh token（而唔係只簽 pv1）

`pv1` 只證明「呢部機屬呢間店」。但會員、加值、報表、權限控制全部靠
`ledgerAccessToken`（`src/lib/ledger/*` 十幾處 `ensureLedgerSession()`）。
如果開機只簽 `pv1`，店員一開機就冇會員、冇加值、冇報表 —— 等於廢咗半個 POS。
所以 server 要用 refresh token 換一對**真** token。

### 10.5 🔴 Refresh token 輪換（最易靜靜壞嘅位）

Supabase **每次 refresh 都輪換 refresh token**（舊票即刻失效）。所以：

1. `/api/pos/device/session` refresh 完**即刻**寫新票落 DB；
2. 客戶端自己再 refresh 時（`resolveLedgerSession()`），新票會經
   `syncDeviceBindingRefreshToken()` → `PATCH /api/pos/device/session` 同步返 server。

冇第 2 步嘅話：DB 嗰張票喺客戶端第一次 refresh 之後變廢票 ⇒
**第二日開機「授權已失效」，而且查唔到原因**。呢個係本功能第一號陷阱。

### 10.6 安全取捨（要同 J 講清楚）

- **裝置持有 = 店主 Ledger session 持有**：本機 `ledgerAccessToken` 係店主嘅。
  技術上，拿到部機 + 開發者工具嘅人可以抽走個 token。呢個風險**今日已經存在**
  （任何登入咗嘅 POS 都係咁），本功能只係延長咗有效期（直到撤銷）。
  ⇒ 員工離職／賣機**一定要**去「裝置授權」撤銷。
- POS 端 `role` 一律降為 `cashier`：店主如果要用自己權限，正常登入一次。
- 未做（可加）：授權 TTL（例如 90 日自動失效）、裝置指紋綁定、逐操作 server 驗 `sv1`。

### 10.7 改動檔案（§10）

**新增**

- `supabase/migrations/0073_pos_bound_devices.sql`
- `src/lib/pos/device-binding.ts`（客戶端：device id／本機授權／開機／token 同步）
- `src/lib/pos/device-binding-server.ts`（server：加密、驗證、CRUD）
- `src/lib/pos/device-binding-types.ts`（中立 DTO 型別，兩邊共用）
- `src/app/api/pos/device/bind/route.ts`（POST 授權 / GET 列表 / DELETE 撤銷，店主限定）
- `src/app/api/pos/device/session/route.ts`（POST 開機 / PATCH token 同步）

**修改**

- `src/components/auth-guard.tsx`（冇 session 時先試裝置還原，成功跳 `/operator`）
- `src/components/operator-signin-screen.tsx`（`/operator` 唔經 AuthGuard，自己試還原）
- `src/components/login-screen.tsx`（已授權提示 +「店員簽到」入口；登入成功清登出標記）
- `src/components/staff-permission-panel.tsx`（裝置授權區塊）
- `src/components/device-settings.tsx`（傳 `enableDeviceBinding`）
- `src/lib/ledger/session.ts`（輪換後同步 server；登出寫 `device-signed-out`）
