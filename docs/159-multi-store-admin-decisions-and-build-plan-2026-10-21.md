# 159 · 多店 Admin 控制台：決議 + 執行清單（2026-10-21）

> 對象：**J**（決策與排期用）。方案本體見 `docs/157`；給 Ledger 的需求見 `docs/158`。
> 狀態：決議已鎖定，**未改任何 code**。以下係可直接開工嘅清單。

---

## 1. 已鎖定嘅五個決議

| # | 決定 | 連帶要做嘅事（唔做就會出事） |
|---|---|---|
| **D1** | 老闆可寫 **L1（店舖設定）+ L2（菜單／價格／售罄）**；L3（退款／刪單／交班／列印）、L4（裝置／打印機）平台專屬 | 寫入白名單要由 §4.5 表驅動，**唔可以**用「route 存在即開放」方式判斷；每次寫入必落 audit |
| **D2** | PIN **沿用 4 位** | 🔴 4 位 = 10⁴ 組合、帳號 = 電話（可枚舉）⇒ **per-account 失敗鎖定**由「建議」升為 **P0 必需**；單靠 IP rate limit 唔夠（換 IP 即繞過） |
| **D3** | 先問 Ledger（admin 版 RPC），已寫 `docs/158` | P4 **暫緩實作**；B2 多憑證**先唔做**，等 Ledger 回覆。回覆「唔做」才啟動（3–4 人日） |
| **D4** | 模組開關**只有平台**可改 | `/api/admin/merchants/modules` PATCH → `need.platform`；老闆 GET 自己店可以（睇得到開通咗咩），PATCH 403 |
| **D5** | 一個 owner 最多 **20 店** | 建號／綁店時驗上限（400）；報表查詢分批（每批 10 店），避免單次 `IN` 過大 |

---

## 2. 對 `docs/157` 方案嘅三處修訂

1. **§4.1 角色表**：`owner` 可寫範圍由「L1+L2（建議）」改為**已鎖定 L1+L2**；
   `store_manager` 預設同 `owner` 一樣但只綁 1 店（如要更嚴，開工前講）。
2. **§4.3 守衛表**：`merchants/modules` 由「GET token（限 scope）／PATCH platform」維持不變 —— 已同 D4 一致。
3. **§5 階段表**：P4 由「2–4 人日」改為 **「等 Ledger，未排期」**；P0 增加「per-account 鎖定」一項，人日 1 → 1.5。

---

## 3. P0 安全底座（1.5 人日 · **唔做完唔准派帳號**）

| # | 任務 | 檔案 | 驗收 |
|---|---|---|---|
| P0-1 | 強制獨立 `ADMIN_SESSION_SECRET`：移除 fallback 到 service role key；未設 = fail closed | `src/lib/admin-session-token.ts:41-46` | 未設 env 時 `/api/admin/session` 回 503；設咗就正常；rotate service key 唔會令 admin token 全滅 |
| P0-2 | `/api/admin/session` 加 rate limit（IP 10 次/分鐘）＋ **per-account 鎖定**：失敗 5 次鎖 15 分鐘 | `src/app/api/admin/session/route.ts`＋migration 加 `failed_login_count` / `locked_until` | 同一帳號錯 5 次後，**換 IP 都登入唔到**；15 分鐘後自動解；成功登入清零 |
| P0-3 | 補 `/api/backoffice/stores/[storeId]` 鑑權（現時 **完全冇閘**，可直接改 `admin_stores.active`） | `src/app/api/backoffice/stores/[storeId]/route.ts` | 匿名 GET／PATCH → 401 |
| P0-4 | 建 `admin_audit_log`（附錄 B SQL）＋ 寫入 helper | `supabase/migrations/0069*`、`src/lib/admin-audit.server.ts` | 登入成功／失敗／寫入都有 row；查得到「邊個帳號、幾時、邊幾間店」 |
| P0-5 | 登入回傳帶 `scope` 摘要（唔改 token claims） | `src/app/api/admin/session/route.ts` | 回 `{ scope: { all, stores: [{id,name}] } }` |

> ⚠️ P0-2 嘅鎖定一定要**落 DB**，唔可以只放記憶體 —— Vercel 多 instance，記憶體鎖定等於冇鎖。

---

## 4. P1 scope 授權 + 多店讀取（2–3 人日）

| # | 任務 | 檔案 |
|---|---|---|
| P1-1 | `resolveAdminScope(account)`：`platform` → `{all:true}`；其餘查 bindings，上限 20，30s cache | `src/lib/admin-scope.server.ts`（新） |
| P1-2 | `requireAdmin(request, { platform?, write? })`：冇 token 401、超範圍 403、無參數時用 `in(scope.storeIds)` | `src/lib/admin-guard.server.ts`（新） |
| P1-3 | `GET /api/admin/me` | `src/app/api/admin/me/route.ts`（新） |
| P1-4 | 8 條 route 接守衛（§157 §4.3 對照表逐條） | `src/app/api/admin/**` |
| P1-5 | `pos_orders_page` 加 `p_store_ids text[]`（additive）；`fetchOrdersInRange()` 加 `storeIds` | `supabase/migrations/0070*`、`src/lib/pos-orders-range.ts` |
| P1-6 | 前端店舖多選（預設全選我嘅店）＋ nav 按 role 過濾 | `src/components/admin-shell.tsx` |
| P1-7 | 報表 `allStoresMode` → 由 `storeIds` 驅動（唔再係「無 filter = 全部」） | `src/app/admin/reports/page.tsx`、`src/components/restaurant-daily-report.tsx` |
| P1-8 | scope 測試：A 店帳號查 B 店 → 403（每條 route 一個 case） | `src/**/*.test.ts` |

---

## 5. P2 商戶帳號管理（1–2 人日）

| # | 任務 |
|---|---|
| P2-1 | `/admin/accounts` 頁：列表（帳號／名稱／角色／綁幾間店） |
| P2-2 | 建號：8 位帳號 + 4 位 PIN + 揀店（≤20）→ 寫 `admin_account_users` + bindings |
| P2-3 | 改綁店／停用／重設 PIN（**冚 PIN 一律由平台做**，唔開放自助） |
| P2-4 | 首登強制改 PIN（加 `must_change_pin` flag） |

---

## 6. P3 多店寫入（3–4 人日 · 風險最高）

| # | 任務 | 備註 |
|---|---|---|
| P3-1 | 寫入 API：L1/L2 各資源一支（或統一 `/api/admin/stores/write`） | 必走 `normalizeBootstrapPayload()`／`normalizePosLocalSettings()` |
| P3-2 | `dryRun: true` → 回 diff（欄位 / 舊值 / 新值） | 前端確認後才真寫 |
| P3-3 | 批量執行：逐店結果 `[{storeId, ok, error}]`，支援部分成功 | 唔可以一個 toast 講「已完成」 |
| P3-4 | 寫後回讀核對（至少對改動嘅 key） | 唔一致 → 回錯誤而唔係 `ok:true` |
| P3-5 | 每店每次寫入落 audit（含 diff） | 追溯「邊個改咗邊間店咩」 |
| P3-6 | UI：菜單／設定編輯器（admin panel 內） | 呢個係最大工作量，可能要再拆 |

> ⚠️ P3-1 有一條鐵律：**唔可以自己砌 JSON 直接 upsert**。`normalizeBootstrapPayload` 係 whitelist，
> 漏加欄位會靜靜剷走（2026-10-20 已中過一次，見 memory）。

---

## 7. P4 會員 KPI（**等 Ledger**）

- 已發 `docs/158`，等 §9 四項回覆。
- Ledger 做 → 我哋 1 人日接線（`getMerchantReportSummaryAdmin` + `/api/admin/multi-store/report`）。
- Ledger 唔做／好慢 → 啟動 B2 多憑證（3–4 人日，憑證存 server、逐店代刷 refresh）。
- **暫時唔做**：跨店會員數相加（已否決）、跨店客流相加（已否決）。

---

## 8. 要你（J）配合嘅五件事

| # | 事項 | 幾時要 |
|---|---|---|
| 1 | 喺 Vercel 設 **新嘅 `ADMIN_SESSION_SECRET`**（唔好再用 service key 頂） | P0-1 上線前 |
| 2 | 確認 Vercel 有 `AUTH_PIN_PEPPER`（Ledger 登入要用；本機冇 `.env.local` 我驗唔到） | 想我做 §157 §4.6 驗證時 |
| 3 | 把 `docs/158` 轉發 Ledger，並催 §9 四項回覆 | 即刻 |
| 4 | 揀 1–2 間 **pilot 店**（建議：你自己嘅多店老闆客）＋ 該老闆嘅帳號清單 | P2 前 |
| 5 | 決定 `store_manager` 是否同 `owner` 一樣可寫 L1/L2 | P1 前（預設：一樣） |

---

## 9. 排期（工作日，唔計 Ledger 回覆時間）

```
P0 安全底座        1.5 日   ← 可即刻開工，唔依賴任何人
P1 scope＋讀取     2–3 日   ← 依賴 P0
P2 帳號管理        1–2 日   ← 依賴 P1
── 呢度可以派第一批帳號出去（唯讀 + 睇多店）──
P3 多店寫入        3–4 日   ← 風險最高，建議獨立上線
P4 會員 KPI        1 日（Ledger 做完之後）／B2 3–4 日（Ledger 唔做）
```

**建議節奏**：P0 → P1 → P2 一次過做完（約 5–6.5 人日）先派帳號，唔好中途派。
原因：P1 未完成時派出去嘅帳號 = 全平台權限（可以停人地盤、睇晒所有店）。

---

## 10. 驗收總表（上線前逐項剔）

**安全**
- [ ] 匿名 `PATCH /api/backoffice/stores/<id>` → 401
- [ ] A 店帳號 `GET /api/admin/orders?storeId=<B>` → 403
- [ ] A 店帳號 `GET /api/admin/orders`（無參數）→ 只回 A 店
- [ ] A 店帳號 `PATCH /api/admin/merchants/modules` → 403（D4）
- [ ] A 店帳號 `PATCH /api/admin/merchants/status` → 403
- [ ] 同一帳號錯 PIN 5 次 → 鎖 15 分鐘（**換 IP 都入唔到**）
- [ ] 停用帳號 → 下一個 request 即 401/403
- [ ] 冇 `ADMIN_SESSION_SECRET` → 登入 fail closed

**功能**
- [ ] owner 綁 3 店 → 登入預設全選 → 報表顯示 3 店彙總
- [ ] 第 21 間店 → 400（D5）
- [ ] 批量改價：3 店中 1 店失敗 → 另 2 店成功且逐店結果清楚
- [ ] 菜單寫入後回讀一致（無欄位被剷）

**口徑**
- [ ] 多店彙總營業額 = 逐店 `totalRevenueNetMop` 相加
- [ ] 會員數／客流逐店列，唔相加
- [ ] 多幣值分開，唔混加

---

## 11. 明確唔做（避免日後爭議）

1. **Ledger 側「集團 / merchant_group」實體** —— 唔做（要走 Ledger 改，成本高）。
2. **老闆 email／OTP 登入** —— 唔做（已決定沿用 8 位 + 4 位 PIN）。
3. **跨店會員數／客流相加** —— 唔做（已否決，口徑錯誤）。
4. **L4 裝置設定（打印機／終端）開放給老闆** —— 唔做（誤改 = 收銀癱瘓）。
5. **一鍵覆蓋全部店菜單** —— 唔做（只准明確勾選嘅店）。

---

## 12. P0 完成紀錄（2026-10-21 已改碼，未部署）

### 12.1 改咗咩

| # | 檔案 | 內容 |
|---|---|---|
| P0-1 | `src/lib/admin-session-token.ts` | **移除** service role key fallback；只認 `ADMIN_SESSION_SECRET`，未設 = 回 null → 登入 503（fail closed） |
| P0-2 | `src/lib/admin-login-lockout.ts`（新）、`src/lib/admin-account-server.ts`、`src/app/api/admin/session/route.ts` | 純函數鎖定（5 次 / 15 分鐘 / 過期重新計數）＋ DB 落狀態＋IP 限流 10 次/分鐘；鎖定期間**唔會再驗 PIN** |
| P0-3 | `src/app/api/backoffice/stores/[storeId]/route.ts` | GET：admin token 或 POS 終端憑證（**終端只准自己店**，越店 403）；PATCH：**只准 admin token**（POS 終端 401） |
| P0-4 | `supabase/migrations/0068_admin_security_hardening.sql`（新）、`src/lib/admin-audit.server.ts`（新） | `admin_account_users` 加 `failed_login_count` / `locked_until`；建 `admin_audit_log`（RLS 無 policy，只 service_role）；登入成功／失敗／鎖定、店舖停啟用都落 audit |
| P0-5 | `src/app/api/admin/session/route.ts` | 登入回傳加 `scope: { all, storeIds }`（P1 會換成 `resolveAdminScope()`；前端**唔可以**用它做授權判斷） |
| — | `.env.example`、`docs/113-agent-gotchas.md` | 記錄「admin secret 改為必填、已無 fallback」；本機冇 env 時登入 503 屬預期 |
| — | `src/lib/admin-login-lockout.test.ts`、`src/lib/admin-security-contract.test.ts`（新） | 18 個測試：鎖定臨界值（4→5、過期邊界、過期後重新計數）＋ 源碼契約（唔可以加返 fallback、store route 唔可以拆閘） |

**驗證（本機）**：`tsc --noEmit` 0 error；`node --test` **2521 pass / 0 fail**；改動檔案 eslint 0 error。

### 12.2 上線次序（**唔可以調亂**）

1. **跑 migration `0068`**（Supabase SQL Editor 貼全檔）。
   —— 只加欄位＋建表，現有 code 零影響，可以早跑。
2. **Vercel 加 `ADMIN_SESSION_SECRET`**（新生成值，見對話）。
   —— ⚠️ 呢一步會令**現有 admin token 同 POS 終端憑證全部失效**（因為 `pos-device-token` 第二順位就是它）。
   **建議同時加 `POS_DEVICE_TOKEN_SECRET`（另一組值）**，之後 rotate 兩支就唔會互相拖累。
   **揀非營業時間做**，並通知店員重新登入。
3. **部署 code**。
4. 驗收（見 §12.3）。

> 若只加 secret 唔部署 code：舊 code 一樣會簽新 secret，行為同部署後一致（都係全部人要重登）。
> 所以 2、3 兩步可以連住做，唔需要分開觀察。

### 12.3 上線後即場驗收（5 分鐘）

> ⚠️ **測試鎖定一定要用「存在於 `admin_account_users` 嘅帳號」**（即你平時入 `/admin` 嗰個）。
> `60000002` / `2222` 係 **Ledger 店員帳號**（用嚟登入 POS 收銀，走 `/api/ledger/login`），
> **唔存在於 `admin_account_users`**，所以喺 `/admin` 登入頁永遠只會回「帳號或密碼不正確」，
> 而且**永遠唔會被鎖** —— 冇 row 就冇地方記失敗次數。呢個係設計如此，唔係 bug
> （帳號唔存在 = 冇嘢可以爆破；IP 限流仍然生效）。
>
> 判斷「新 code 有冇上線」最乾淨嘅方法：去查 `admin_audit_log` 有冇你嗰幾次失敗紀錄
> （舊 code 完全唔會寫 audit）。冇表 = migration 0068 未跑，或者跑錯專案
> （**POS = `iyrywzormzisyppkokbi`**，Ledger = `zymdemjflsckicwcinxl`）。

```bash
# ① 未帶 token → 401
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH \
  "https://<pos-host>/api/backoffice/stores/d564b932-0c91-45e9-86fd-0ec8e2711f13" \
  -H 'Content-Type: application/json' -d '{"active":true}'        # 期望 401

# ② 正常登入 → 200 + token + scope
curl -s -X POST "https://<pos-host>/api/admin/session" \
  -H 'Content-Type: application/json' -d '{"account":"<8位>","pin":"<4位>"}' | head -c 300

# ③ 連續錯 PIN 5 次 → 第 5 次應回 429（Retry-After ≈ 900）
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "try$i=%{http_code}\n" -X POST "https://<pos-host>/api/admin/session" \
    -H 'Content-Type: application/json' -d '{"account":"<8位>","pin":"0000"}'
done
```

```sql
-- ④ audit 有冇寫入
select account, action, target, ip, created_at
  from admin_audit_log order by created_at desc limit 20;

-- ⑤ 鎖定欄位有冇生效（測試帳號應該見到 failed_login_count = 5 / locked_until 有值）
select account, failed_login_count, locked_until from admin_account_users;
```

### 12.4 回滾

| 情況 | 做法 |
|---|---|
| 登入全部 503（漏設 secret） | 補 `ADMIN_SESSION_SECRET` 後重新部署（**唔可以**用回舊 code 解決，舊 code 依賴 service key fallback 已刪） |
| 鎖定誤傷（例如客服大量重試） | `update admin_account_users set failed_login_count = 0, locked_until = null where account = '<帳號>';` |
| 要完全停用鎖定 | 暫無開關；如急要，先把 `MAX_FAILED_ATTEMPTS` 調高再部署（唔建議長久） |
| migration 出錯 | `alter table admin_account_users drop column if exists failed_login_count, drop column if exists locked_until; drop table if exists admin_audit_log;`（code 有容錯，缺欄位只會 warn 唔會壞登入） |

### 12.5 P0 未做（留給 P1）

- `scope` 只係**回傳摘要**，**未有任何 route 真正用佢收窄**（A 店帳號打 `?storeId=B` 仍然會拿到 B）。
  ⇒ **P1 完成前，仍然只可以派「平台級」帳號**（即現有 admin）。

---

## 13. P1 完成紀錄（2026-10-21 已改碼，未部署）

### 13.1 核心機制：scope 由 server 端解析，唔入 token

```
token = { account, role, exp }          ← 唔變（stateless，仍然 12h）
        ↓ 每個 request
resolveAdminScope(account)              ← 查 DB（10 秒 cache）
        ↓
{ all: true }  或  { all: false, storeIds: [...] }
        ↓
storeFilterFor(scope, 請求指定嘅店)      ← 三條不變量
        ↓
SQL: 無 filter（只用於 all）／ in(store_ids)／ 空結果
```

**三條不變量**（有單測鎖死，`admin-scope-core.test.ts`）：

1. `storeIds: []` **≠ 全部** —— 空 scope = 乜都睇唔到（fail closed）
2. 唔帶店參數 **≠ 全部** —— 只有 `all: true` 才可以用 null
3. 指定越權店 = **403**（唔可以靜默降級做「睇自己店」，否則前端會以為睇緊 B 店、實際係 A 店數字）

> 為何唔把 `storeIds` 寫入 token：改權限／停用要**即時生效**，唔可以等 12 小時 token 過期。

### 13.2 改咗咩

| 檔案 | 內容 |
|---|---|
| `src/lib/admin-scope-core.ts`（新） | 純函數：`storeFilterFor()` / `isPlatformPermissions()` / `scopeSummary()` / `dedupeStoreIds()`；`MAX_SCOPE_STORES = 20`（D5） |
| `src/lib/admin-scope.server.ts`（新） | `resolveAdminScope()`：查 `admin_account_users`（**順便驗 active**，停用即刻失效）＋ 權限組 ＋ bindings→merchant UUID（`admin_stores.merchant_id` 補 mapping，補唔到一律剔除）；10 秒 cache ＋ `clearAdminScopeCache()` |
| `src/lib/admin-guard.server.ts`（新） | `requireAdmin(request, { platform? })`：401 / 403 / 503 統一出口；`storeFilterOrDeny()`：越權 403 |
| `src/app/api/admin/me/route.ts`（新） | 回 `{ account, role, scope:{all,storeIds}, stores:[{id,name}] }`（前端只作顯示／預設選店） |
| 9 條 admin route | 全部改用 `requireAdmin()`（唔再自己驗 token） |
| `merchants` | Ledger 商戶列表 + POS 統計（兩條查詢）都跟 scope；回傳加 `scope` |
| `orders` / `ledger/orders` | `storeId`/`merchantId` 驗 scope；無參數時用 `in(scope.storeIds)`；空 scope 直接回空 |
| `merchants/status` | **`platform: true`**（D4）＋ 落 audit |
| `merchants/modules` | GET 限 scope（店主睇得到自己開通咩）；PATCH **`platform: true`**（D4） |
| `sessions` / `traffic` / `release-versions` | **`platform: true`**（跨店營運情報＋全平台設定） |
| `src/lib/pos-orders-range.ts` | 新增 `storeIds?: string[] \| null`：`null`=全部、`[]`=**即刻回空**、`[a,b]`=`in()`；RPC 走新 `pos_orders_page_scoped`，未跑就自動降級四腿 |
| `supabase/migrations/0069_pos_orders_page_scoped.sql`（新） | `p_store_ids text[]` 版本；空陣列 fail closed；`security invoker`、只 grant service_role |
| `src/lib/types.ts` | `UserPermissions` 加 `adminPanelAccess?` / `scopeAllStores?` |
| `admin/session` | 登入閘改為「平台級 **或** `adminPanelAccess` ＋ 有綁店」（見 §13.3） |

**測試**：`admin-scope-core.test.ts`（11）＋ `admin-security-contract.test.ts` 擴充（P1：每條 admin route 必須用 `requireAdmin`、唔可以自己驗 token；平台專屬 route 必須有 `platform: true`）。全量 **2549 pass / 0 fail**；`tsc` 0 error。

### 13.3 🔴 登入閘（最需要留意嘅一點）

```ts
canEnterAdmin = permissions.manageAccounts === true        // 平台級
             || permissions.adminPanelAccess === true      // 店舖級（明確開啟）
if (canEnterAdmin && !isPlatform && storeIds.length === 0) → 403「未獲分配任何店舖」
```

**刻意唔用「有店舖綁定就入得」**：`admin_account_store_bindings` 早就存在，好多現有店長／收銀帳號都有綁定；如果照綁定放行，等於突然開一個新入口畀所有前線帳號（雖然只係自己店、只讀），屬未經批准嘅權限擴張。
⇒ 現有帳號行為**完全不變**；要開店舖級後台，必須明確設 `adminPanelAccess`（P2 建號 UI 會勾）。

### 13.4 上線次序

1. **跑 migration `0069`**（**POS 專案 `iyrywzormzisyppkokbi`** —— 即 `pos_orders` 所在嗰個，唔係 Ledger）。
   —— 未跑都唔會壞：`pos_orders_page_scoped` 唔存在 → 自動降級四條時間腿（功能正確、慢少少）。
2. 部署 code。
3. 驗收（§13.5）。

### 13.5 驗收（重點：A 店帳號查 B 店 = 403）

> 🔴 **帳號 ≠ 店**。`d564b932-…`（60000002 嗰間）本身已經係 Ledger 店，**唔需要新建店**，
> 亦唔需要在 Ledger 開任何嘢。測試只需要一個「非平台級」嘅登入身份 + 一條 binding；
> 綁定係一次性設定（P2 會有 UI），唔需要為每間店重複做落去。

**方案 A（推薦，零風險）**：造一個臨時登入帳號，綁去你指定嘅真實店

```sql
-- ① 權限組（⚠️ admin_permission_groups.id 係 uuid，唔可以自己填文字 id，否則 22P02）
insert into admin_permission_groups (id, code, name, role, permissions, created_at, updated_at, note)
select gen_random_uuid(), 'owner-test', '店主（測試）', 'manager',
       '{"adminPanelAccess":true,"scopeAllStores":false,"manageAccounts":false}'::jsonb,
       now(), now(), '多店 P1 驗收用，可刪'
 where not exists (select 1 from admin_permission_groups where code = 'owner-test');

update admin_permission_groups
   set permissions = '{"adminPanelAccess":true,"scopeAllStores":false,"manageAccounts":false}'::jsonb,
       updated_at = now()
 where code = 'owner-test';

-- ② 測試帳號（PIN 用明文 pin_code；首次成功登入會自動升級成 pin_hash）
insert into admin_account_users
  (account, pin_code, name, role, active, permission_group_id, created_at, updated_at, note)
values
  ('60000099','1234','測試店主','manager',true,
   (select id from admin_permission_groups where code='owner-test'), now(), now(), 'P1 驗收用')
on conflict (account) do update
  set pin_code = '1234', active = true, updated_at = now(),
      permission_group_id = (select id from admin_permission_groups where code='owner-test');

-- ③ 綁 A 店（只需 merchant_id；resolver 會優先讀佢）
delete from admin_account_store_bindings
 where account_id = (select id from admin_account_users where account='60000099');

insert into admin_account_store_bindings (account_id, merchant_id)
select id, 'd564b932-0c91-45e9-86fd-0ec8e2711f13'
  from admin_account_users where account='60000099';
```

> 若 `admin_account_store_bindings.store_id` 係 **NOT NULL**，改用：
> ```sql
> insert into admin_account_store_bindings (account_id, store_id, merchant_id)
> select a.id,
>        coalesce((select s.id from admin_stores s
>                   where s.merchant_id='d564b932-0c91-45e9-86fd-0ec8e2711f13' limit 1),
>                 (select s.id from admin_stores limit 1)),
>        'd564b932-0c91-45e9-86fd-0ec8e2711f13'
>   from admin_account_users a where a.account='60000099';
> ```

**方案 B（唔想新增帳號）**：暫時把你現有平台帳號降級，測完還原

```sql
-- 0) 記低原本嘅 permission_group_id（copy 出嚟，還原要用）
select id, account, permission_group_id from admin_account_users where account = '<你嘅帳號>';

-- 1) 同上面 ① 一樣建 owner-test 組；2) 綁 A 店；3) 切過去
update admin_account_users
   set permission_group_id = (select id from admin_permission_groups where code='owner-test')
 where account = '<你嘅帳號>';

-- 🔴 測完還原（唔記得做就會發現自己睇唔到其他店）
update admin_account_users
   set permission_group_id = '<原本嘅 uuid>'
 where account = '<你嘅帳號>';
delete from admin_account_store_bindings
 where account_id = (select id from admin_account_users where account='<你嘅帳號>')
   and merchant_id = 'd564b932-0c91-45e9-86fd-0ec8e2711f13';
```

驗收清單：

| # | 動作 | 期望 |
|---|---|---|
| 1 | 測試帳號（或方案 B 降級後嘅平台帳號）登入 `/admin` | 成功；回傳 `scope.all = false`、`storeIds` 只有 A 店 |
| 2 | `GET /api/admin/me` | `stores` 只有 A 店（有名稱） |
| 3 | `GET /api/admin/orders?storeId=<B>` | **403** `scope.denied` |
| 4 | `GET /api/admin/orders`（無參數） | 只回 A 店單（睇 `scope` 欄位） |
| 5 | `GET /api/admin/merchants` | 只有 A 店 |
| 6 | `GET /api/admin/ledger/orders?merchantId=<B>` | **403** |
| 7 | `PATCH /api/admin/merchants/status` | **403** `platform_only` |
| 8 | `PATCH /api/admin/merchants/modules` | **403** `platform_only` |
| 9 | `GET /api/admin/sessions`、`/traffic`、`/release-versions` | **403** `platform_only` |
| 10 | 用返原本平台帳號做以上全部 | 全部照舊正常（`scope.all = true`） |
| 11 | 停用 `60000099`（`active=false`）後，**用同一張舊 token** 再打 | **401**（唔使等 token 過期） |

### 13.6 刻意未做（移到 P2）

- **前端店舖多選 UI**（`admin-shell` 店舖勾選、報表 `allStoresMode` → `storeIds`）。
  原因：P2 之前冇正式嘅店舖級帳號（要靠 §13.5 嘅 SQL 造），UI 冇對象可測；
  而且平台帳號仍然係「全部」，現有畫面行為完全正確。P2 建號 UI 會一次過做完。
- **`merchants` 的 Ledger 查詢仍然 `select` 全表再 JS 過濾**（店主只收到自己嘅店，冇外洩，
  但多讀幾十行）。等 P3 寫入通道一齊改成 server 端 `.in()`（Ledger 表細，暫時唔急）。
