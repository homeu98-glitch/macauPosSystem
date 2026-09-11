# POS 店員 PIN 與權限層 — 可行性評估與設計建議

> 2026-09-11 · 狀態：**評估 / 待決策**（未寫任何 code）
> 需求來源：用戶提出「在 macau-pos 層新增一層店員權限控制」：
> ① 商戶登入後再輸入 4 位 PIN 作第二層；② 完全獨立於 Ledger；③ 按店員角色控制可執行操作。

---

## 0. 結論摘要（TL;DR）

**方案可行，架構方向正確，但不能照字面實作。** 三個必須修正的前提：

| # | 原方案表述 | 評估 | 修正建議 |
|---|---|---|---|
| 1 | 「登入主頁後再進入第二層 PIN」 | ⚠️ 現有 `/login` 本身已經係「8 位帳號 + 4 位 PIN」 | 兩層要**重新命名區隔**：L1 = 裝置／商戶登入，L2 = 操作員（店員）登入。否則店員會混淆「兩組 4 位 PIN」 |
| 2 | 「完全獨立於 Ledger」 | ✅ 目標正確，但 L1 **仍然係** Ledger 登入 | L2 係喺 L1 之上**再收窄授權**，唔係取代 L1；L1 仍係唯一拎到 `merchantId` + ledger token 嘅入口 |
| 3 | （未提及）離線行為 | 🔴 **最大可行性風險** | POS 係離線優先（outbox / shift reconcile）。純服務端 PIN 驗證 = 斷網即全店登入唔到 → 必須設計離線策略 |

**現有系統已經有半套骨架可直接複用**：`UserRole` + `UserPermissions` + `AuthGuard` + `posDeviceToken`（HMAC）。唔需要從零建，但**唔可以**照抄現有 `admin_account_users`（明文 PIN）。

**最大嘅單一技術風險**：呢一層如果只喺前端比對，等於冇做。安全邊界必須落喺 `/api/pos/*`。

---

## 0.5 選型追問：「不如直接用 Ledger 嗰邊嘅權限？」

> 2026-09-11 追加。問題：与其自建 POS 權限層，係咪複用 Ledger 現有嘅權限更好？

### 0.5.1 結論：**身份應該複用 Ledger；權限做唔到交給 Ledger**

「用 Ledger 嘅權限」呢件事**根本唔成立**，因為 **Ledger 冇權限模型**。有契約級證據：

| # | 證據 | 位置 | 含義 |
|---|---|---|---|
| 1 | `merchant_staff` 只有 `staff_role`（`owner` \| `staff`），**「不存在 `role` 欄」**，且明文「**勿 invent `admin`／`role` 欄**」 | `docs/integration/ledger-client-api.md` §4.3（L163、L175） | Ledger 只有**兩檔**，而且係「店主 vs 其他所有人」→ **表達唔到「店長 vs 一般店員」** |
| 2 | RPC 權限檢查係 `is_merchant_staff(p_merchant_id)` | 同上 §5（L281） | 係一個 **boolean「你係唔係本店員工」**，唔係 per-action permission |
| 3 | 契約自己寫：`staff_role` 係「**映射 POS 本地權限用**」 | 同上 §4.3（L175） | 🔴 **Ledger 自己已明確話權限模型係 POS 嘅事**，佢只提供粗角色訊號 |
| 4 | Ledger **唔提供**夥伴可用嘅登出 API；「Session 生命週期**完全由 POS 自理**」 | 同上 §4.4（L179-190） | Ledger 刻意唔管終端會話管理 |
| 5 | 前端 session 見到嘅 `role` / `permissions` **唔係 Ledger 回傳**，係 POS 自己計（`mapLedgerStaffRole()` + 硬編 ternary） | `src/app/api/ledger/login/route.ts:41-44, 145-148` | 所謂「Ledger 嘅權限」其實**一直都係 POS 自己嘅**，只係輸入源係一個 2 值欄位 |

### 0.5.2 正確分工

| 問題 | 應該由邊個答 | 現況 |
|---|---|---|
| 呢個 Auth 帳號係唔係本店員工？ | **Ledger**（`merchant_staff` / `is_merchant_staff`） | ✅ 已有 |
| 呢台機屬邊間店？ | **Ledger**（L1 login → `merchantId`） | ✅ 已有，勿動 |
| 可唔可以讀寫 Ledger 資料？ | **Ledger RPC 內部**（`is_merchant_staff`） | ✅ 已有；POS **唔應該**重複做 |
| 收銀台可以做咩操作？ | **POS 本地**（唯一可行） | ❌ 缺，即係今次想加嘅嘢 |

### 0.5.3 三個「現成權限系統」候選評估

| 候選 | 形狀匹配度 | 致命問題 | 判定 |
|---|---|---|---|
| **Ledger `merchant_staff`** | ❌ 只有 2 檔、無 permission 欄 | 契約禁止加 `role` 欄；表達唔到店長/店員 | **只可用嚟做身份**，唔做權限 |
| **POS `admin_account_users` + `admin_permission_groups`** | ✅ 形狀最似（role + permissionGroupId + store bindings + `defaultPermissionsForRole` 三檔預設） | ① 係**後台 SaaS 帳號層**（`/admin`、要求 `manageAccounts`），唔係「一間店嘅收銀員」；② `pin_code` **明文**；③ 帳號係 8 位 | **借形狀、唔當店員表** |
| **新建 `pos_staff`** | ✅ 按需要設計 | 要自己處理 PIN 安全 + 離線 | ✅ **正確層級** |

> 值得注意：`admin_account_users` 嗰套（`AccountPermissionGroup` / `mergePermissions` / store bindings）其實已經係一份可用嘅權限模型藍圖 —— **建議複製佢嘅資料形狀與合成邏輯，但放到正確層級**（POS 本地、store-scoped、雜湊 PIN）。

### 0.5.4 若堅持「要用 Ledger 嗰邊」：唯一可行形態 = 混合

**身份來源 = Ledger，權限存 POS。**
- `pos_staff` 加可選 `ledger_user_id`（指向 Ledger Auth user）；
- 入職時綁定一次（由 Ledger 側確認此人為本店 `merchant_staff`），日常用 POS 4 位 PIN 快速簽到；
- role / permissions 一律存 POS。

**但必須接受以下成本**（呢啲係「唔用純 Ledger 方案」嘅實質理由）：

| 成本 | 說明 |
|---|---|
| 每個店員要一個 Ledger 帳號 | = 一個**電話號碼** + 一組 PIN。對小店請兼職／臨時工係實質障礙（唔一定個個有澳門電話或願意綁） |
| 開戶要喺 Ledger 側做 | POS 幫唔到。技術上 POS **有** `LEDGER_SERVICE_ROLE_KEY`（`src/lib/ledger/admin-server.ts`，可讀寫 `merchant_staff`），但用佢直接管 Ledger 員工生命週期 = **POS 反向侵入 Ledger**，違背本方案「權限層唔影響 Ledger」嘅原始目標，風險更高 |
| 換班 = 換 Ledger session | 觸發 §4.4 要求嘅 `signOut` + `pos-auth-changed` 全頁 reload + 重新 backfill —— 同「一部收銀機全日開住」嘅現實互相矛盾 |
| 仍然做唔到店長/店員區分 | 就算每個人都開 Ledger 帳號，`staff_role` 依然只有 `owner`/`staff`；除非叫所有店長做 `owner`（= 順手授予 Ledger 全權，更差） |

### 0.5.5 建議（本文件立場）

**唔好將權限交給 Ledger；但身份盡量唔重複。**

1. `pos_staff` 作**店員唯一真源**（POS 本地、store-scoped、雜湊 PIN），**唔強制**綁 Ledger —— 因為大部分收銀員本身唔需要、亦唔應該為咗排班去開 Ledger 帳號。
2. 預留 `ledger_user_id` 可選欄位：店長／老闆本身有 Ledger 帳號時可綁定，做到「一個身份兩邊通用」，但**唔係必要條件**。
3. **Ledger 側保持 0 改動**：唔加 `role` 欄、唔要求 Ledger 新增權限 API、唔用 service_role 反向寫 Ledger 員工。
4. 唯一「用返 Ledger」嘅地方 = L1 裝置登入（`merchantId` + `staff_role`）—— 呢個**保持不變**，並繼續由 `staff_role` 提供**初始**粗角色（owner → 不受 L2 限制；staff → 受 L2 控制）。

---

## 1. 現況盤點（先睇清楚已經有咩）

| 機制 | 位置 | 說明 | 對本方案嘅意義 |
|---|---|---|---|
| L1 登入 | `src/components/login-screen.tsx` → `/api/ledger/login` | 8 位電話 + 4 位 PIN → Ledger `signInWithPassword` | L2 要掛喺佢後面，**唔好動佢** |
| 角色來源 | `merchant_staff.staff_role` | Ledger 只有 `owner` \| `staff` → 映射 `admin` \| `cashier`（`route.ts:41-44`） | ⚠️ **POS 目前冇「店員」概念**，只有店主 vs 店員兩檔 |
| 角色型別 | `src/lib/types.ts:2` | `UserRole = "admin" \| "manager" \| "cashier"` | ✅ 直接沿用，唔好另立詞彙 |
| 權限型別 | `src/lib/types.ts:4-15` | `refundOrder / voidItem / reprintReceipt / reopenOrder / manageAccounts` | ✅ 擴充此結構即可 |
| 權限組 | `AccountPermissionGroup` + `admin_permission_groups` | 後台已有「權限組」概念（code/name/role/permissions） | ✅ 模式可複製，但**表係後台 SaaS 層**，唔應混用 |
| 前端守衛 | `src/components/auth-guard.tsx` | `allowedRoles` / session 檢查 | ⚠️ **純 UX**，唔係安全邊界 |
| 服務端憑證 | `src/lib/pos/pos-device-token.ts` | HMAC-SHA256，kind `pv1`，TTL 12h，payload = `{storeId, account, role, exp}` | ✅ **關鍵**：`/api/pos/*` 已靠佢證明「店內終端」。但佢只證「邊間店」，**唔證「邊個店員」** |
| 憑證消費點 | `sync` / `state` / `bootstrap` / `kiosk-settings` / `kds/*` route | 全部 `readPosDeviceTokenFromRequest()`，**絕大部分只取 `storeId`**（KDS 額外取 `account` 做審計） | ✅ 加 L2 憑證係**疊加**，唔會改動現有 storeId 語義 → 對 Ledger 零影響 |
| 既有帳號表 | `admin_account_users`（`docs/sql/admin-account-schema.sql:30`） | `pin_code text not null` —— **明文**；登入用 `.eq("pin_code", pin)` 明文比對 | 🔴 **反面教材，新表絕對唔可以照抄** |
| 審計欄位 | `pos_shifts.employee_account/employee_name`、`order.settledBy/voidedBy/refundRecords.employeeAccount` | 現時一律寫**登入帳號（商戶電話）**；交班頁按此值做「員工篩選」 | 🔴 **整合最大陷阱**：改成店員 id 會令舊記錄對唔上（見 §6.5） |
| 裝置角色 | `kiosk` / `kitchen` / `expo` 模式 | 登入時刻意跳過店級設定寫入（`login-screen.tsx:179-192`） | ✅ 呢類裝置**唔應**要求店員 PIN，但破壞性操作可要求 manager PIN |

---

## 2. 可行性與架構合理性

### 2.1 為何可行
1. **分層天然存在**：L1 用 Ledger 憑證（`ledgerAccessToken`），POS 本地寫入通道用自簽 `posDeviceToken`。兩者已平行，加一層 POS-local 憑證屬同構擴展，唔會侵入 Ledger 契約。
2. **型別已備**：`UserRole` / `UserPermissions` 已定義並在 `pos-app.tsx:566-567` 有實際 gate（`canRefundOrder` / `canVoidItem`）。
3. **憑證基建已備**：`pos-device-token.ts` 已經係「HMAC + 獨立 kind + TTL + fail-closed」嘅成熟樣板，`staffToken` 可以照同一套寫，甚至共用 `resolveSecret()`。
4. **store 隔離口徑清晰**：全系統以 `merchants.id`（= `pos_orders.store_id`）為 scope，店員表照 `store_id` 分區即天然隔離。

### 2.2 架構定位（正確嘅心智模型）

```
L1  裝置登入（Ledger）         → 證明：呢部機屬於邊間店 + 拎到 ledger token
     ↓  (不變，唔改語義)
L2  操作員登入（POS staff）    → 證明：而家係邊個店員 + 佢可以做咩
     ↓  (新增，POS-local)
Authorization = verifyPosDeviceToken() + verifyStaffToken() → effective permissions
     ↓
/api/pos/*  業務端點（寫入 / 交班 / 設定）
     └─ Ledger 相關呼叫：仍然只帶 ledger token，權限層唔進入 Ledger
```

**咁樣做嘅好處**：L2 完全係 POS 內部事，Ledger 側 0 改動；`staffToken` 缺席時可回退現行行為（feature flag），部署風險可控。

---

## 3. 逐條評估原方案

### 3.1 第 1 條：登入後再輸入 4 位 PIN
- **合理**，係行業慣例（收銀機開機 → 店員簽到）。
- ⚠️ **命名衝突**：L1 已經係 4 位 PIN。建議 UI 上 L2 標示為「店員簽到 / 操作員 PIN」，並用**工號（staff_no）+ PIN** 或**頭像揀人 + PIN**，避免與商戶 PIN 混淆。
- ⚠️ **必須解決「換班」流程**：一台機 = 一個裝置 session + N 個店員輪流。需要「鎖定 / 切換操作員」入口 + 閒置自動鎖定。
- ⚠️ **離線**：見 §8。

### 3.2 第 2 條：完全獨立於 Ledger
- ✅ **方向正確，但要講清「獨立」嘅定義**：
  - **獨立 = 唔改 Ledger 契約、唔存 Ledger 資料、唔用 Ledger RPC 驗權**。
  - **唔係**「唔需要 Ledger」：L1 仍要 Ledger 登入（否則拎唔到 `merchantId` 同 ledger token）。
- ✅ 資料面完全獨立：店員表放 POS Supabase，`store_id` 對齊 `merchants.id`，不設任何 FK 去 Ledger 表。

### 3.3 第 3 條：按角色控制操作
- ✅ 合理，但**要盤點清楚「閘邊啲操作」**（§7 有清單），否則會出現「控制咗但控制錯重點」。
- ⚠️ **現存 fail-open bug**：`pos-app.tsx:566-567` 用 `authSession?.permissions.refundOrder ?? true`。session 缺 permissions 就**直接放行**。權限層上線前必須改成 `?? false`。

---

## 4. 潛在問題（按嚴重度排序）

### 4.1 🔴 PIN 儲存安全
- 現有 `admin_account_users.pin_code` 係**明文**，且以明文 `.eq()` 比對 —— 4 位 PIN 只有 10,000 組合，一旦 DB 洩漏等於全洩。
- 新表建議：`pin_hash`（**argon2id 或 scrypt**；若受限於 serverless runtime，用 `PBKDF2-SHA256`，迭代 ≥ 100k）+ **per-row random salt** + **server-side pepper**（env，唔入 DB）。
- **常數時間比對**（`timingSafeEqual`，樣板見 `pos-device-token.ts:68-73`）。
- **Rate limit + 鎖定**：每人 `failed_attempts` / `locked_until`（例如連錯 5 次鎖 5 分鐘）；route 層再加 IP / 裝置級限流（可複用 `/api/ledger/login` 嘅 `checkRateLimit()` 模式）。
- ⚠️ **唔可以**沿用 `deriveLedgerAuthPassword()` —— 嗰個係 Ledger 契約（`phone + pin + pepper`）嘅一部分，改咗會斷 L1。

### 4.2 🔴 4 位 PIN 嘅碰撞與可猜性
- 同店店員數目雖少，但 10,000 空間下**重複 PIN 係現實風險**；重複 = 審計軌跡張冠李戴，比「估中」更常發生。
- 設計上：`unique (store_id, pin_hash)` 只能防「完全一樣嘅 hash」（有 salt 就防唔到），所以應該喺**建立時明文檢查同店唯一**，唔靠 DB constraint。
- 補強：限制連續／重複數字（`1111` / `1234`）、禁止等於 L1 商戶 PIN。

### 4.3 🔴 驗證層級（最關鍵嘅架構決定）
- 若只喺 `login-screen` 或前端比對 PIN → **devtools 一改就穿**。`AuthGuard`、按鈕 `disabled` 全部只係 UX。
- 真正邊界 = **服務端 `/api/pos/*`**。目前呢啲 route 只驗 `posDeviceToken`（`storeId`），**冇「當前操作員」概念**。
- 結論：**必須**由服務端簽發 `staffToken`，並喺需要店員權限嘅端點要求「`posDeviceToken`（店內）+ `staffToken`（邊個／可做咩）」兩張同時有效。

### 4.4 ⚠️ 角色詞彙「四套並存」風險
現存：`UserRole`（types）、`admin_account_users.role`（後台）、Ledger `staff_role = owner|staff`。再加一套店員角色就變四套。
→ **建議**：店員只用 `UserRole` 嘅子集（`manager` \| `cashier`），權限一律用既有 `UserPermissions`，**唔另立 enum**。

### 4.5 🔴 審計欄位相容性（最易踩嘅整合坑）
- 交班頁「員工篩選」按 `employeeAccount` 比對（`shift-page.tsx:415,424-425`）；`pos_shifts.employee_account`、`order.settledBy/voidedBy` 現時寫入嘅係**商戶電話**。
- 若 L2 上線後直接改寫呢啲欄位為店員 id → **舊記錄對唔上、篩選失效、報表斷層**。
- **建議**：新增 `staff_id` / `staff_name` 欄位，**保留** `employee_account` 寫原本登入帳號（維持向後相容）；顯示時 `staff_name ?? employee_name ?? employee_account`。migration 要可重跑、舊值不變。

### 4.6 ⚠️ Kiosk / KDS 邊界
- `kiosk` / `kitchen` / `expo` 係**裝置角色**，登入時刻意跳過店級設定寫入。要求店員 PIN 會妨礙營運 → **唔應該**。
- 但「退出自助點餐模式」、「換崗位」等破壞性操作，建議要求 **manager PIN** 二次確認（同一套驗證，唔另建機制）。

### 4.7 ⚠️ 「裝置登入後先入 L2」會唔會鎖死
- 若 L1 成功但 L2 未完成 → 要有明確 fallback（例如只准「設定頁」同「鎖定畫面」），唔可以完全白屏。
- 建議 L2 未通過時：顯示鎖定畫面 + 只開放「輸入 PIN」。**唔好**自動 fallback 成全權（fail-closed）。

---

## 5. 建議資料結構

### 5.1 新表 `pos_staff`（POS Supabase，**service_role only**；RLS 對 anon/authenticated 一律拒絕）

```sql
create table if not exists pos_staff (
  id               uuid primary key default gen_random_uuid(),
  store_id         text        not null,          -- = merchants.id / pos_orders.store_id 口徑
  staff_no         text        not null,          -- 短工號（登入輸入 / 顯示用，如 '01'）
  name             text        not null,
  role             text        not null            -- 'manager' | 'cashier'（UserRole 子集，owner 不在此層）
                     check (role in ('manager','cashier')),
  permissions      jsonb       not null default '{}'::jsonb,  -- UserPermissions 覆寫值
  pin_hash         text        not null,          -- argon2id / scrypt / PBKDF2+salt（絕不存明文）
  pin_updated_at   timestamptz,
  active           boolean     not null default true,
  failed_attempts  integer     not null default 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (store_id, staff_no)
);
create index if not exists pos_staff_store_idx on pos_staff (store_id) where active;
```

- **為何 store-scoped 而唔係「一個店員跨多店」**：POS 以單店裝置運作，`store_id` 分區天然隔離、授權判斷最簡單；跨店需求日後再擴。
- **權限組（可選）**：若想有「權限組」概念，**照抄** `admin_permission_groups` 結構開 `pos_staff_permission_groups`，`pos_staff.permission_group_id` 引用；唔好另創形狀。
- **有效權限合成**（對齊 `admin-account-server.ts:31-37` 既有手法）：
  `effective = defaultPermissionsForRole(role) ⊕ group.permissions ⊕ staff.permissions`

### 5.2 憑證 `staffToken`（仿 `posDeviceToken`）

```
kind = "sv1"            // 獨立 kind，pv1 / av1 互不通用（verify 只認 sv1）
payload = { v, storeId, staffId, staffNo, role, permissions, iat, exp }
TTL     = 一個班次級別（建議 12h，同 pv1 一致；或 8h + 閒置自動鎖）
secret  = POS_DEVICE_TOKEN_SECRET ?? ADMIN_SESSION_SECRET ?? SUPABASE_SERVICE_ROLE_KEY（共用 resolveSecret）
```

### 5.3 前端儲存：**另開一層 key，唔好塞入 `AuthSession`**

```
localStorage（store scope）: macau-pos/stores/{storeId}/operator
{
  staffId, staffNo, name, role, permissions,
  staffToken, loggedInAt, expiresAt, lastActivityAt
}
```

**點解唔塞入 `AuthSession`**：
- `AuthSession` 係 Ledger 登入產物，`normalizeAuthSession()` 係**白名單重建** → 塞欄位極易踩「reload 被剷走」嘅歷史坑（`qrUrl` / `posDeviceToken` 都中過）。
- 換班唔應該觸發 `pos-auth-changed` → 整頁 reload（現時 `auth-guard.tsx:58-61` 會 reload）。操作員切換應該係**輕量**嘅。

---

## 6. 權限模型建議

### 6.1 沿用 + 擴充 `UserPermissions`
現有：`refundOrder` / `voidItem` / `reprintReceipt` / `reopenOrder` / `manageAccounts`。
針對 POS 建議新增（按風險排序）：

| 權限 | 控制嘅操作 | 建議預設 manager / cashier |
|---|---|---|
| `voidItem` | 退菜 | ✅ / ❌ |
| `refundOrder` | 退單 / 退款 | ✅ / ❌ |
| `compOrder`（新） | 免單 | ✅ / ❌ |
| `reopenOrder` | 返結 | ✅ / ❌ |
| `cancelOrder`（新） | 取消線上單 | ✅ / ❌ |
| `applyDiscount`（新） | 套用折扣 / 改價（尤其時價菜） | ✅ / ⚠️ 可設 |
| `reprintReceipt` | 補打收據 | ✅ / ✅ |
| `closeShift`（新） | 交班結帳 | ✅ / ⚠️ 可設 |
| `deviceSettings`（新） | 設備 / 打印 / 菜單 / 桌台設定 | ✅ / ❌ |
| `manageStaff`（新） | 管理店員（新增／停用／改 PIN） | ✅ / ❌（僅 manager） |

### 6.2 角色預設（三檔對映既有語義）
- `manager`（店長）：全部 ✅（`manageStaff` 亦 ✅）
- `cashier`（一般店員）：只落單 / 結帳 / 補打；退菜、退款、免單、返結、設定一律 ❌
- 沿用 `UserRole` 內既有 `admin` 值（= Ledger owner）作為「不受 L2 限制」嘅店主通道（可選，需明確定義）。

### 6.3 Fail-closed 原則
- 任何「搵唔到權限」→ **拒絕**，唔係放行。
- 修正 `pos-app.tsx:566-567` 嘅 `?? true` → `?? false`。
- 服務端：`staffToken` 無效 / 缺失 → 高風險操作直接 403（可 feature flag 回退）。

---

## 7. 與 Ledger / 現有架構嘅整合方式

### 7.1 硬規則（唔可以破）
1. **L1 `/api/ledger/login` 完全不改**：回傳嘅 `role` / `permissions` 語義不變（Ledger owner→admin，staff→cashier）。
2. **店員身份絕不送入 Ledger**：所有 member lookup / deduct / 訂單同步一律只帶 ledger token。Ledger 端**完全睇唔到**權限層。
3. **`posDeviceToken` 語義不變**：仍然只證「店內終端 + storeId」。`staffToken` 係**疊加**，唔取代。
4. **不動 Ledger schema**：新表全放 POS Supabase，無 FK 指向 Ledger 表。
5. **審計欄位只增不改**（§4.5）。

### 7.2 新增端點
| 端點 | 作用 | 授權 |
|---|---|---|
| `POST /api/pos/staff/login` | 店員工號 + PIN → 簽 `staffToken` | 需 `posDeviceToken`（證明店內終端）；rate limit + 鎖定 |
| `GET /api/pos/staff` | 列出本店店員（**唔回 `pin_hash`**） | 需 `staffToken` + `manageStaff`（或 L1 admin） |
| `POST /api/pos/staff` | 新增 / 停用 / 改 PIN / 改權限 | 同上 |
| `POST /api/pos/staff/verify` | 高風險操作前嘅二次確認（例如 Kiosk 退出） | 需 `posDeviceToken` |

### 7.3 授權合成（route 內）
```ts
const device = readPosDeviceTokenFromRequest(request);      // 既有
if (!device && isPosDeviceAuthRequired()) return unauthorized();

const staff = verifyStaffToken(request.headers.get("x-pos-staff-token"));
// 關鍵：staff.storeId 必須 === device.storeId，否則跨店 → 拒
const perms = resolveEffectivePermissions(device, staff);   // staff 有 → 用 staff；冇 → 回退 Ledger role
if (!perms.voidItem && isVoidAction) return forbidden();
```

### 7.4 前端 gate
- 既有 `AuthGuard` / `pos-app` 嘅 `canRefundOrder` 等，改為讀**合成後**嘅 permissions。
- 所有 gate 定位為 **UX**（收起粒掣、顯示「需要店長權限」），安全仍由服務端兜底。

### 7.5 版本相容 / 回退
- Feature flag（例如 `NEXT_PUBLIC_POS_STAFF_LAYER=1`）+ 服務端 `POS_REQUIRE_STAFF_AUTH`（對齊既有 `POS_REQUIRE_DEVICE_AUTH` 模式，預設 on、可應急關閉）。
- 舊 client 未帶 `staffToken` → 行為同今日一致（回退 Ledger role），避免部署當日鎖死全店。

---

## 8. 離線策略（必答題）

POS 係離線優先，純線上 PIN 驗證唔可行。建議：

| 情境 | 行為 |
|---|---|
| 首次喺某店登入 L2 | 必須**線上**（順便快取本店店員清單至 localStorage，含 `{staffId, staffNo, name, role, permissions, pinVerifySaltHash}`） |
| 之後離線開機 | 用**快取**驗證：以「裝置 + 店員」為 scope 嘅本地雜湊（唔存明文 PIN）比對 |
| 快取有效期 | 例如 7 天；過期且離線 → 只准落單／結帳（最低風險操作），高風險操作仍要求重連驗證 |
| 恢復上線 | 對帳：以 server 店員清單為準（新增／停用／改權限生效），並可要求重新簽到 |
| 敏感操作 | 一律要求**線上** `staffToken`（離線時退而要求 manager PIN 二次確認，並標記 `pendingVerify`） |

> 設計張力：呢度係「安全 vs 可用性」嘅取捨點，建議**第一版先做線上**、離線 fallback 留 Phase 2，但**一開始就要設計好資料形狀**，唔好日後推倒重來。

---

## 9. 分期落地建議

| 階段 | 內容 | 產出 |
|---|---|---|
| **Phase 0** | 修 fail-open（`?? true` → `?? false`）；定 PIN 政策（雜湊演算法、鎖定、唯一性）；補 `docs/113` 嘅權限相關坑 | 小修補 + 規格 |
| **Phase 1** | `pos_staff` 表；`staffToken`（sv1）；`/api/pos/staff*`；設定頁「店員管理」；線上 L2 登入 + 鎖定／切換；只 gate **高風險操作**（退菜／退款／免單／返結／交班 / 設定） | 可用嘅權限層 |
| **Phase 2** | 離線驗證快取 + 對帳；閒置自動鎖定；按店員嘅審計報表；審計欄位加入 `staff_id` | 完整閉環 |
| **明確唔做** | ① 唔將 staff 身份送入 Ledger；② 唔喺前端做唯一驗證；③ 唔明文存 PIN；④ 唔改 `AuthSession`／L1 回傳語義 | — |

### 9.1 驗證劇本（Phase 1）
```
1. 店長登入 L1 → 新增店員 A（cashier）/ B（manager），各設唯一 PIN。
2. 換部機登入 L1 → 入 L2 用 A 嘅 PIN → 退菜 / 退款掣應該收起或 403。
3. 鎖定 → 用 B 嘅 PIN → 高風險操作可用。
4. 直接 curl /api/pos/sync 帶 ORDER_ITEM_VOIDED，帶 A 嘅 staffToken → 應 403。
5. 4 位 PIN 亂試 6 次 → 帳戶鎖定；換 IP 亦受裝置級限流。
6. 斷網 → 高風險操作被拒（Phase 1 線上模式），落單結帳不受阻。
7. 檢查 DB：pos_staff 冇任何明文 PIN。
```

---

## 10. 風險登記

| 風險 | 級別 | 緩解 |
|---|---|---|
| 前端單獨驗證被繞過 | 🔴 | 服務端 `staffToken` + route 授權 |
| PIN 明文 / 弱雜湊 | 🔴 | argon2id/scrypt + salt + pepper + 常數時間比對 |
| 審計欄位改寫令舊報表斷層 | 🔴 | 只增 `staff_id` 欄位，`employee_account` 保持不變 |
| 離線鎖死全店 | 🔴 | 快取 + 有效期 + 低風險操作豁免 |
| 4 位 PIN 同店碰撞 | ⚠️ | 建立時明文查同店唯一 + 禁用弱 PIN |
| 角色詞彙四套並存 | ⚠️ | 只用 `UserRole` 子集 + `UserPermissions` |
| 部署當日鎖死 | ⚠️ | feature flag + `staffToken` 缺席回退 |
| L2 未完成白屏 | ⚠️ | 明確「鎖定畫面」狀態，fail-closed 但可用 |

---

## 附註
- 相關文件：`docs/113-agent-gotchas.md`（改動前必讀）、`docs/109-shift-sync-overtime-plan.md`（`pos_shifts` 員工欄位）、`docs/sql/admin-account-schema.sql`（既有帳號表，含明文 PIN 教訓）。
- 本文件**未改動任何程式碼**。
