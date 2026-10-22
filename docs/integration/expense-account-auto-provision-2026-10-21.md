# 庫存帳戶自動開通方案（expenseRecorder shop_users · login-time resolve-or-create）

> **日期**：2026-10-22 · **狀態**：✅ 已實作（login 觸發版，待 push 上雲）
> **觸發實案**：今日幫商家開咗一間新店。商家登入 POS 想用「庫存」，系統話
> expenseRecorder 冇佢帳號 ⇒ 庫存頁空白。J 嘅要求：**macau-pos call 過去
> expenseRecorder，如果冇帳號，就直接幫佢開一個；帳號同 PIN 跟 macau-ledger
> 互用；絕對唔可以刪／改 expenseRecorder 現有戶口。**

---

## 0. ⚠️ 方案變更記錄（重要，審批者必讀）

本檔初稿（2026-10-21）寫咗一套**完全不同**嘅設計——「lazy：庫存頁首次打開時
經 `POST /api/inventory/account/ensure` 開通，PIN 隨機生成」。

**J 審批時改咗兩個鐵則，令設計整體翻轉：**

| 初稿設計 | J 審批後嘅定版（已實作） |
|---|---|
| 庫存頁 `matched:false` 時 lazy 開通 | **`/api/ledger/login` 登入成功時立即開通** |
| PIN 隨機生成（mirror SSO `randomPin()`） | **PIN 直接採用 macau-ledger 嗰個**，兩邊帳號＋PIN 互用 |
| 容許 backfill `external_shop_id`、寫 `profile_json`／`last_login_at`／`external_owner_id` | **只 resolve-or-create，搵到就 return，絕不 UPDATE／DELETE；唔寫任何非必要欄** |
| 新增獨立 endpoint `ensure` | **完全唔加 endpoint**，埋入現有 login 路徑（零新攻擊面） |

原因：PIN 只喺登入嗰一刻可得（POS session 唔持久化 PIN），要「PIN 互用」就
**一定要喺 login 做**；而「絕對唔可以影響現有戶口」令我們收緊成純 read-then-insert。

---

## 1. 現狀：帳號點樣關聯（先講事實）

### 1.1 兩邊係咩關係

| 系統 | Supabase 專案 | 帳戶表 | 帳號格式 |
|---|---|---|---|
| macauPosSystem（POS） | `iyrywzormzisyppkokbi` | Ledger `merchants` / `merchant_staff` | `account` = 員工電話（8 位） |
| expenseRecorder | `fjvfvpedklhdenavbcjg` | `shop_users` | `login_id` = 8 位、`login_pin` = 4 位 |

POS 庫存模組**直連** expenseRecorder（service_role，bypass RLS），憑一條 8 位
`account` 做租戶 scope：

```
account(8位) → shop_users.login_id → shop_users.id → receipts.user_id / merchants.user_id
```

### 1.2 關鍵程式位置（實證）

| 行為 | 位置 |
|---|---|
| POS 登入（**新開通觸發點**） | `src/app/api/ledger/login/route.ts:230-266` 新增 best-effort 區塊 |
| 核心 resolve-or-create 邏輯 | `src/lib/expense-account-provision.ts`（新） |
| 單測 | `src/lib/expense-account-provision.test.ts`（新，15 條） |
| account → userId 解析（既有餘 chokepoint，今次唔動） | `src/lib/expense-inventory.ts:78-88` `resolveExpenseUserId()` |
| 收據清單（既有，唔用 chokepoint） | `src/app/api/inventory/receipts/route.ts:81-100` |
| 庫存頁讀 session 攞 `account` | `src/components/inventory/inventory-view.tsx:1884-1899` |
| expenseRecorder `shop_users` schema | `C:/dev/macauPos/expenseRecorder/supabase_schema_v2.sql`（`login_id` UNIQUE、`external_shop_id` UNIQUE、`auth_source` default `'local'`） |
| expenseRecorder 註冊（本地） | `app/signup/page.tsx`：店名 + 8 位 login_id + 4 位 PIN；`60000000` 係保留號 |

### 1.3 缺口（根因）

新店喺 Ledger 開咗（`merchants` 表；本 repo **冇**建店入口），但 expenseRecorder
`shop_users` 冇人建 ⇒ 庫存讀取路徑全部 `matched:false` / 404。現有唯一補救係
商家自己去 expenseRecorder 網站手動註冊同一個 8 位帳號——必然唔記得做。

### 1.4 順帶修好嘅隱患

Ledger 買貨報表契約要 `shop_users.external_shop_id = Ledger merchants.id` 先解析到
店（線上 11 家店原本全部 NULL ⇒ 報表 404）。自動開通時一齊寫 `external_shop_id`
就順手解決（撞 unique 時降級唔寫，見 §2.3）。

---

## 2. 方案總覽：login-time resolve-or-create（2026-10-22 實作）

一句話：**POS 登入驗證成功嗰一刻，如果 expenseRecorder 冇該 account 對應嘅
`shop_users`，就以完全相同嘅 account（8 位電話）＋ PIN 立即開一間；搵到就乜都
唔做。整個區塊 try/catch 包住，失敗一定唔可以令登入失敗。**

```
/api/ledger/login（phone + pin 驗證成功）
  └─ if EXPENSE_AUTO_PROVISION !== "0" 且 getExpenseSupabaseClient() 存在：
       provisionExpenseShopUser(store, { loginId: phone, loginPin: pin,
                                          shopName: merchant.name,
                                          externalShopId: staffRow.merchant_id })
         ├─ 搵到 login_id → { created:false }（鐵律：絕不 UPDATE 現有 row）
         └─ 搵唔到 → INSERT（login_id / login_pin / shop_name
                            + external_shop_id / auth_source，撞欄降級）
                          └─ { created:true } → console.info 記 log
  ※ 以上任何例外 → console.warn 一句，登入照常 return 200
```

### 2.1 為乜唔用初稿嘅 lazy `ensure` endpoint

| 考慮 | lazy `ensure`（初稿，棄用） | login 觸發（定版，已實作） |
|---|---|---|
| PIN 來源 | 庫存頁攞唔到 PIN（session 唔持久化）⇒ 只能隨機生成，**違反 J 鐵則** | login 本身就驗證咗 PIN ⇒ 直接互用 ✅ |
| 新攻擊面 | 要加新 POST endpoint + 鑑權閘（現有 inventory route 大多無鑑權，風險高） | 零新 endpoint，埋入本身就要鑑權嘅 login ✅ |
| 用家體驗 | 要等庫存頁先開到，首登可能仲係空白一瞬 | 登入即開，第一次開庫存已經有戶口 ✅ |

### 2.2 設計決策

| 決策 | 選擇 | 理由 |
|---|---|---|
| 開通時機 | **login 成功時**（非 lazy） | PIN 只喺 login 可得；帳號＋PIN 互用嘅硬要求 |
| 入口 | 唔加 endpoint，埋入 `/api/ledger/login` | 零新攻擊面；login 本身已鑑權 |
| 開關 | `EXPENSE_AUTO_PROVISION`（預設開；`0` 回滾） | 同 `POS_REQUIRE_DEVICE_AUTH` kill-switch 慣例 |
| 失敗處理 | 全程 try/catch，只 `console.warn` | 鐵律：絕對唔可以令登入失敗 |
| 現有戶口 | **只 SELECT，絕不 UPDATE／DELETE** | 鐵律：嗰邊入口有人用，唔可以影響其他功能 |
| PIN | 直接採用 macau-ledger 嗰個 | 鐵律：帳號與 PIN 兩邊互用 |

---

## 3. 詳細設計

### 3.1 核心 lib：`src/lib/expense-account-provision.ts`

用 **port 模式**（`ShopUserStore` interface 隔離 supabase），令 `node --test` 可以
純邏輯覆蓋（唔使連真實 expenseRecorder）：

```ts
export type ShopUserStore = {
  selectByLoginId(loginId: string): Promise<{ id: string; external_shop_id: string | null } | null>;
  insert(row: NewShopUser): Promise<{ id: string }>;   // 拋 { code:"23505" } 或 { code:"42703" }
};
export type NewShopUser = {
  loginId: string; loginPin: string; shopName: string;
  externalShopId: string | null; authSource: "macau-pos";
};
export type ProvisionResult =
  | { ok: true; userId: string; created: boolean; account: string }
  | { ok: false; status: 400 | 409 | 500; error: string; code?: string };
export const RESERVED_LOGIN_ID = "60000000";
```

**`provisionExpenseShopUser(store, opts)` 流程：**

1. 校驗 `loginId`（`/^\d{8}$/`、擋 `60000000`）＋ `loginPin`（`/^\d{4}$/`）→ 錯回 `400`。
2. `SELECT by login_id` ⇒ 搵到就 return `{ created:false}`（**唔 UPDATE**，鐵律 1）。
3. `INSERT`：
   - 成功 ⇒ `{ created:true }`。
   - 撞 `23505` ⇒ 再 SELECT（並發可能已建）⇒ 搵到當 `created:false`；搵唔到且
     有 `externalShopId` ⇒ **降級唔寫 `external_shop_id`** 再 INSERT（解同一間店多員工撞
     unique）；再 `23505` ⇒ `409 LOGIN_ID_TAKEN`。
   - 其他 DB 錯 ⇒ `500`（caller 靜默放過）。

**`createExpenseShopUserStore(client)`（真實 supabase 實作）：**

| 欄 | 寫入值 | 說明 |
|---|---|---|
| `login_id` | `phone`（8 位） | UNIQUE |
| `login_pin` | `pin`（4 位，來自 ledger） | **互用**，非隨機 |
| `shop_name` | `merchant.name ?? "店號 ${phone}"` | login 已攞到 merchant |
| `external_shop_id` | `staffRow.merchant_id`（= Ledger `merchants.id`） | 買貨報表 contract；撞 unique 降級唔寫 |
| `auth_source` | `'macau-pos'` | 新值；expenseRecorder 無 branch 依賴具體值 |

`insert` 撞 `42703`（`external_shop_id` / `auth_source` 欄舊環境唔存在）⇒ 降級只寫
基礎三欄（`login_id` / `login_pin` / `shop_name`）重試。**一律唔寫**
`profile_json` / `last_login_at` / `external_owner_id`（default / nullable，減少 42703
受擊面，亦避免「靜默改動」現有戶口嘅任何爭議）。

### 3.2 觸發點：`src/app/api/ledger/login/route.ts:230-266`

`return NextResponse.json(...)` 之前插入 best-effort 區塊：

```ts
if (process.env.EXPENSE_AUTO_PROVISION !== "0") {
  try {
    const expense = getExpenseSupabaseClient();
    if (expense) {
      const result = await provisionExpenseShopUser(createExpenseShopUserStore(expense), {
        loginId: phone, loginPin: pin,
        shopName: merchant?.name ?? `店號 ${phone}`,
        externalShopId: staffRow.merchant_id, authSource: "macau-pos",
      });
      if (result.ok && result.created) console.info("[ledger/login] 已自動開通…", { account: phone, storeId: … });
    }
  } catch (e) {
    console.warn("[ledger/login] 開通失敗（不影響登入）", e instanceof Error ? e.message : String(e));
  }
}
```

`phone` / `pin` / `merchant` / `staffRow` 都係 login 驗證成功之後已經喺 scope 內嘅變數
（唔使加任何新讀取）。

### 3.3 冇改 UI、冇改其他 inventory route

今次**只加** lib ＋ login 埋點，**完全唔動**：
- `src/components/inventory/inventory-view.tsx`（庫存頁行為不變；首登已開好戶口，自然唔會空白）
- 任何 `/api/inventory/*` route（唔加新 endpoint，唔改既有鑑權）
- `resolveExpenseUserId()` 等既有讀取路徑（只 resolve-or-create，唔影響佢哋）

---

## 4. 安全同風險（J 審批重點）

### 4.1 🔴 鐵律：絕不影響 expenseRecorder 現有戶口

實作層面保證：
- `provisionExpenseShopUser` 搵到 row 就 `return`，**全程無 UPDATE 語句**。
- `insert` 只寫 `shop_users`，**無 DELETE**。
- 唔寫 `profile_json` / `last_login_at` / `external_owner_id` ⇒ 唔會改到現有戶口
  嘅任何欄位（就算 weird 情況 SELECT miss 咗，都係 insert 新列，唔碰舊列）。
- 觸發區塊 try/catch 包住，失敗只 `console.warn` ⇒ 登入、庫存、其他功能零影響。

### 4.2 濫發／頻率

觸發點係 login（本身要 8 位 account + 4 位 PIN 驗證過），唔係匿名 endpoint；
`login_id` UNIQUE 保證每個 account 最多一列。Worst case 都只係建一列。

### 4.3 跨店帳號衝突（已知限制，只靜默降級）

員工電話可同時存在多間店。`external_shop_id` 撞 unique 時，今次**降級唔寫
`external_shop_id`** 再建（唔可以令開戶失敗）。讀取路徑（login_id 解析）唔動，
舊行為維持。徹底修要 expenseRecorder 改 schema，列為後續。

### 4.4 保留號／輸入驗證

`60000000` 係保留號；`account` 必須 `/^\d{8}$/`、`pin` 必須 `/^\d{4}$/`。全部 server 端驗。

### 4.5 回滾係乜

- Flag `EXPENSE_AUTO_PROVISION=0` ⇒ 完全唔執行開通區塊，行為完全回到改動前。
- 已建嘅列係**純增量**（空 `shop_users` 列，未有收據時刪除即可完整 undo）；
  有收據後刪列會 CASCADE ⇒ **唔好亂刪**（但呢啲列本來就係正確帳號，唔使刪）。

---

## 5. 測試同驗證結果（2026-10-22）

| 層 | 動作 | 結果 |
|---|---|---|
| 單測 | `src/lib/expense-account-provision.test.ts`：**19 條**（已存在→created:false 唔 insert／create 成功／23505 race→created:false／external_shop_id 降級／雙 23505→409／account 唔合法→400／PIN 唔合法→400／保留號→400／其他錯→500／42703→500／初始 select 拋錯仍 INSERT／adapter 缺欄 42703 降級 select id／adapter 缺欄 PGRST204 降級 insert／非缺欄錯誤照 throw） | ✅ **19/19 pass** |
| 型別 | `node node_modules/typescript/bin/tsc --noEmit` | ✅ **0 error** |
| lint | `node node_modules/eslint/bin/eslint.js src/lib/expense-account-provision.ts src/lib/expense-account-provision.test.ts src/app/api/ledger/login/route.ts` | ✅ **0 error** |
| 全測 | `node --test`（background） | ✅ **2589 pass / 0 fail** |

---

### 5.1 🔴 第二輪修補（2026-10-22 · 上線後商家仍報「庫存空白」）

上線後商家（Brewlab Coffee，帳號 `68189891`）開庫存仍顯示「找不到相同帳號的店戶」。取證：
生產 `GET /api/inventory/receipts?account=68189891` 回 `matched:false`（**非** 503，證明 expense client 已連上、`shop_users` 真係冇列）。

發現**全域性** bug（任何環境都會中，同「migration 檔存在 ≠ 跑過」同源）：
1. `provisionExpenseShopUser` 第一步 `selectByLoginId()` 喺 try/catch **外面**，而佢 select `id, external_shop_id`。若 live 缺 `external_shop_id` 欄 ⇒ PostgREST `42703` / `PGRST204` ⇒ throw ⇒ 整個開通靜默失敗（連「已存在」都查唔到）。
2. `insert()` 只認 `db.code === "42703"`；但 PostgREST 對 `.insert()` 未知欄多數回 **`PGRST204`**（"Could not find the 'x' column … in the schema cache"）⇒ 降級分支永不觸發。

修法：
- 新增 `isMissingColumnError()`（認 `42703` / `PGRST204` / 訊息 regex，同 `api/inventory/receipts` 嘅 `isMissingColumn()` 同思路）；**非缺欄錯照 throw**，唔可以亂降級。
- `selectByLoginId`：主 select 撞缺欄 ⇒ 降級只 `select("id")`。
- `insert`：缺欄時降級只寫基礎三欄（改用上面 helper）。
- `provisionExpenseShopUser`：初始 select 包 try/catch，查詢失敗當「未搵到」交 INSERT + 23505 兜底。

⚠️ **仍有一個非程式問題**：開通只喺 `/api/ledger/login` 觸發。商家若喺部署前已登入（session 存 localStorage），之後只按「重新整理」係**唔會**再打 login ⇒ 開通永遠唔會 fire。對呢類已登入嘅店，**需登出再登入一次**先觸發（符合 J「第一次登入就開」嘅原本設計）。

---

## 6. 端到端驗證清單（push 上雲後做，用今日嗰間新店）

1. 用新店嘅 8 位 account ＋ PIN 登入 POS（online）。
2. 直連查 expenseRecorder `shop_users where login_id = <account>`，確認新列：
   - `login_pin` == 嗰個 PIN（**互用**）；
   - `external_shop_id` == `merchantId`（商家 storeId）；
   - `auth_source` == `'macau-pos'`；
   - `shop_name` == Ledger 店名。
3. 直接去 expenseRecorder 網頁用**同一 account + 同一 PIN** 登入 ⇒ 應該成功（證明互用）。
4. 返轉頭開 POS 庫存 ⇒ 唔再空白；新增一張收據／供應商成功。
5. 再登入一次 POS ⇒ `created:false`（冚唪啱，唔重複建列）。
6. Ledger 買貨報表用該 storeId 由 404 變有數（證明 `external_shop_id` 綁定生效）。
7. 回滾測試：Vercel 設 `EXPENSE_AUTO_PROVISION=0` ⇒ 行為還原（唔自動開通）。

> 直查工具：`tools/check-expense-db.mjs`（`node --env-file=.env.local` 跑），
> 或臨時 script 查 `shop_users where login_id = …`。

---

## 7. 改動清單

| 檔案 | 動作 |
|---|---|
| `src/lib/expense-account-provision.ts` | 🆕 新（port + resolve-or-create + 純函式，含 schema 降級） |
| `src/lib/expense-account-provision.test.ts` | 🆕 新（15 條單測） |
| `src/app/api/ledger/login/route.ts` | ✏️ 加 best-effort 開通區塊（line 230-266） |
| `docs/integration/README.md` | ✏️ 索引行更新狀態 |
| `docs/integration/expense-account-auto-provision-2026-10-21.md` | ✏️ 本檔（翻轉成 login 觸發版） |
| Vercel env | `EXPENSE_AUTO_PROVISION`（文件化；預設開＝唔設都得） |

---

## 8. 明確唔做（今次範圍外）

| 項目 | 原因 |
|---|---|
| 庫存頁 `matched:false` 觸發 / 新增 `ensure` endpoint | J 改要求 login 觸發＋PIN 互用，初稿設計已棄用 |
| 商家直登 expenseRecorder 嘅 PIN 重設 UI | PIN 已經互用，暫時無需；真要另做「查看/重設庫存 PIN」 |
| 建店時 proactive 開通（Ledger admin） | 建店喺另一個 repo；要 Ledger 團隊配合，列後續 |
| SSO 打通 | expenseRecorder 已有現成 route，但要 Ledger 簽發，跨 repo |
| 全部 inventory route 加鑑權 | 另開 P2（pos-api-auth-hardening skill） |
