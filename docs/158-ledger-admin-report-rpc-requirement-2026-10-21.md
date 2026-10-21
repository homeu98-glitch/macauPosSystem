# 158 · 致 Ledger 技術團隊：Admin 版會員報表 RPC 需求（v1 · 2026-10-21）

> 用途：**可直接轉發**。發件方：macau-pos（POS 系統）。收件方：Ledger。
> 期望回覆：§9 四項（function 簽名 / grant 清單 / 測試店 / 已知限制）。
> 相關（我哋內部）：`docs/157`（多店 Admin 控制台方案）、`docs/159`（執行清單）。

---

## 0. 一句話需求

請新增一個 **只准 service_role 呼叫、可用 `p_merchant_id` 指定商戶** 的報表彙總 RPC，
回傳結構與現有 `get_merchant_report_summary` **完全一致**；現有函數**唔需要改、亦唔應該改**。

---

## 1. 背景：我們在做什麼

macau-pos 正在做「多店 Admin 控制台」：一個老闆有多間店（**每間店 = 一個獨立 merchant**），
可以用同一個 POS 後台帳號一次看／改多家店。

問題出在**身份**：POS 的 admin 帳號係 POS 自己發的（8 位帳號 + PIN），**冇 Ledger 商戶 JWT**。
而 Ledger 現時所有會員類 RPC 都用 `auth.uid()` 推導商戶 —— 所以 admin 後台拿唔到會員充值／扣點／會員數，
只能拿到 POS 自己那份訂單數據。畫面上會出現「營業額有數、會員 KPI 空白」的斷層。

我們**唔想**用以下兩種做法（都會帶來更大風險，所以請勿建議）：

- ❌ 叫老闆逐間店登入 POS 才看到數字 → 5 間店要輸 5 次 PIN，而且無法彙總。
- ❌ 叫老闆把 5 間店的 PIN 交給 POS 代存 → 等於 5 組憑證長期放在第三方系統。

所以我們想要的是：**由 POS server 用 service_role 呼叫、明確傳 `p_merchant_id` 的 admin 版 RPC**。
Ledger 永遠只回應「被明確指定的那一間店」，唔需要認識「老闆」或「集團」概念。

---

## 2. 現時限制（我方讀碼確認的契約事實）

| RPC | 我方呼叫位置 | 商戶如何決定 | Admin 可用？ |
|---|---|---|---|
| `get_merchant_report_summary(p_start, p_end)` | `src/lib/ledger/reports.ts:85` | `auth.uid()` → `merchant_staff` | ❌ 冇商戶 JWT |
| `list_merchant_customers(...)` | `src/lib/ledger/member-list.ts:89` | 同上（**註釋明文寫「唔好傳 `p_merchant_id`」，傳咗會 `not admin`**） | ❌ |
| `list_merchant_orders(...)` / `get_order_detail(...)` | `src/lib/ledger/orders.ts` | 同上 | ❌ |
| `list_merchant_order_menu(...)` | `src/lib/ledger/menu.ts:196` | 同上（**此函數反而要傳 `p_merchant_id`，且僅限商戶自己**） | ❌ |

> 注意：`list_merchant_customers` 的契約係「店員唔可以傳 `p_merchant_id`（傳咗會 `not admin`）」。
> 所以**唔可以**用「放寬現有函數」的方式解決 —— 會同現有店員契約衝突。請**新增**函數。

---

## 3. R1（必須）：`get_merchant_report_summary_admin`

### 3.1 簽名

```sql
create or replace function public.get_merchant_report_summary_admin(
  p_merchant_id uuid,          -- 必填；Ledger merchants.id
  p_start       timestamptz,   -- 必填；澳門日界，帶 +08:00（例：2026-10-21T00:00:00+08:00）
  p_end         timestamptz    -- 必填；例：2026-10-21T23:59:59.999+08:00
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$ ... $$;
```

### 3.2 回傳

**與現有 `get_merchant_report_summary` 一字不差**（同樣的 key、同樣的 avos 整數單位）。
我哋前端靠 key 名讀取，改名等於要改我哋代碼 —— 可以做，但請**提前書面通知**。

我哋實際讀取的 key（附錄 A 有完整清單）：
`order_count`、`order_paid_avos`、`order_balance_paid_avos`、`order_in_store_paid_avos`、
`topup_avos`、`topup_paid_avos`、`topup_gift_avos`、`deduct_avos`、`deduct_paid_avos`、`deduct_gift_avos`、
`member_count`；可選 `topup_count`、`deduct_count`、`new_member_count`、`balance_avos`。

### 3.3 語義要求

1. **範圍 = `p_merchant_id` 一間店**，唔可以夾雜其他店（包括會員跨店共用的情況，一律只算該店 wallet／txn）。
2. **唔可以用 `auth.uid()`**（service_role 呼叫時 `auth.uid()` 為 NULL，會靜靜回 0 —— 呢個係最危險的失敗模式）。
3. `p_merchant_id` 不存在 → 請**明確報錯**（見 §7 失敗模式），唔好回一堆 0。
4. 時間比較用 **instant（timestamptz）**，唔好當 `date` 處理；我哋一律傳帶 `+08:00` 的 ISO 8601。
5. 計算口徑必須與現有函數**完全相同**（同一套 status 過濾、同一套 refund 處理），否則同一間店在
   「商戶自己登入 POS」與「Admin 後台」會看到兩個數 —— 這正是我們 2026-10-21 已經踩過的坑（見 `docs/156`）。

### 3.4 安全要求（**最重要**）

```sql
revoke all on function public.get_merchant_report_summary_admin(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_merchant_report_summary_admin(uuid, timestamptz, timestamptz)
  to service_role;
```

- 函數內部**必須**驗證呼叫者：`current_role = 'service_role'`（或等價檢查），否則 `raise exception`。
  只靠 `grant` 也可以，但我們要求**雙重保障**（grant 可能被日後 migration 意外放寬）。
- 唔可以 `security invoker`（會被 RLS 擋住，或反過來依賴 RLS 而漏檢查）。
- 唔可以回傳 `merchant_staff`／`auth.users` 等內部資料。

---

## 4. R2（建議，可選）：批量版

我哋一個老闆最多 **20 間店**。如果逐店呼叫 = 20 次 round trip。

```sql
create or replace function public.get_merchants_report_summary_admin(
  p_merchant_ids uuid[],
  p_start timestamptz,
  p_end   timestamptz
) returns jsonb   -- [{ merchant_id, ...同 R1 一模一樣的欄位 }]
```

- 上限請設 **20**（超過請報錯，唔好靜靜截斷）。
- 安全要求同 R1 完全一樣（只 service_role）。
- 順序唔需要保證，我哋用 `merchant_id` 對應。

> 如果 R2 唔做，R1 逐店呼叫我哋接受（但請告知，因為影響我們的批次策略與 egress 預算）。

---

## 5. R3（只係確認，唔需要改動）

我哋發現兩個問題，需要你們確認，因為直接影響我們的登入與權限模型：

1. **同一 `auth.users` 是否可以有多條 `merchant_staff`（多間店）？**
   如果有，`get_merchant_report_summary` 內部揀哪一條？（我哋見到 `merchant_staff` 查詢有 `limit 1` 的做法，
   我哋自己 POS 側亦係 `limit(1)`，屬**不確定行為**。）
2. 如果支援多條，有冇「當前店 / active merchant」的概念？（session 內？參數？）

> 如果 Ledger 本身已經支援「一個帳號多店」，我哋會調整 UI（一次登入即可見多店）；
> 如果唔支援，我哋會走「逐店憑證」後備方案（`docs/157` §4.6 B2）。**所以這個答案對我們很關鍵。**

---

## 6. R4（後續，非本次）

R1 上線後，如果要做「Admin 後台的會員清單／券／線上訂單明細」，同樣需要 admin 版：
`list_merchant_customers_admin`、`list_merchant_orders_admin`、`get_order_detail_admin`、
`list_redeemable_grants_for_customer_admin`。
**本次唔需要做**，列出嚟只係想提前對齊命名慣例（`_admin` 後綴 + `p_merchant_id` 第一參數）。

---

## 7. 失敗模式（請明確區分，唔要靜靜回 0）

| 情況 | 期望行為 |
|---|---|
| `p_merchant_id` 不存在 / 已刪除 | `raise exception` with `errcode = 'P0002'`（no_data_found）或回 `null` ＋ 明確 error |
| 冇權限（anon / authenticated 呼叫） | PostgreSQL `42501`（permission denied） |
| `p_start > p_end` | `raise exception`（`22023` invalid_parameter_value） |
| 店存在但區間內真係冇數 | **正常回 0**（呢個係合法結果） |

🔴 我們最怕的是「錯」與「冇數」長得一樣。如果 `auth.uid()` 為 NULL 時回全 0，我們會以為那間店今天沒生意，
而實際上是 RPC 沒有正確處理 merchant 參數。

---

## 8. 驗收（我們會照此測試）

| # | 測試 | 預期 |
|---|---|---|
| T1 | `service_role` 呼叫 R1（示範店 `d564b932-0c91-45e9-86fd-0ec8e2711f13`，今日） | 200；數字與 LEDGER 後台報表頁一致 |
| T2 | 同一參數，改用 **anon key** 呼叫 | `permission denied`（42501），**唔可以回數據** |
| T3 | 同一參數，改用**商戶 JWT**（`authenticated`）呼叫 | `permission denied`（42501） |
| T4 | `p_merchant_id` 傳不存在的 uuid | 明確錯誤，**唔可以回全 0** |
| T5 | 同一區間，R1 與現有 `get_merchant_report_summary`（該店商戶 JWT 呼叫） | 兩者數字**逐個欄位相同** |

T5 係最重要的一條 —— 佢同時證明「口徑冇漂移」。

```bash
# T1 範例
curl -s "$LEDGER_URL/rest/v1/rpc/get_merchant_report_summary_admin" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_merchant_id":"d564b932-0c91-45e9-86fd-0ec8e2711f13",
       "p_start":"2026-10-21T00:00:00+08:00","p_end":"2026-10-21T23:59:59.999+08:00"}'

# T2 範例（必須失敗）
curl -s -o /dev/null -w '%{http_code}\n' "$LEDGER_URL/rest/v1/rpc/get_merchant_report_summary_admin" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_merchant_id":"d564b932-0c91-45e9-86fd-0ec8e2711f13",
       "p_start":"2026-10-21T00:00:00+08:00","p_end":"2026-10-21T23:59:59.999+08:00"}'
```

---

## 9. 回覆時請提供（我哋要據此接線）

1. ✅ R1 最終 **function 名 + 參數型別 + 回傳型別**（如果同本文不同）。
2. ✅ **grant / revoke 清單**（貼 SQL 即可）。
3. ✅ R2 做唔做；做就提供簽名與上限。
4. ✅ R3 的答案（一個 user 可否多 merchant、怎樣決定當前店）。
5. ✅ 已部署到哪個環境（prod / staging）＋ migration 版本號。
6. ✅ 已知限制（例如 `member_count` 的定義是 wallets 列數抑或其他）。

---

## 10. 我哋這邊的接線（Ledger R1 上線後約 1 人日）

| 位置 | 改動 |
|---|---|
| `src/lib/ledger/reports.ts` | 新增 `getMerchantReportSummaryAdmin(merchantId, range)`（**server-only**，用 service_role client） |
| `src/app/api/admin/multi-store/report/route.ts` | 新 route：驗 admin session → 驗 scope → 逐店呼叫 → 回 `{ perStore: [...], totals: { revenueMop } }` |
| `src/components/admin-shell.tsx` / 報表頁 | 多店勾選 + 逐店明細 |

⚠️ 彙總規則（我哋已拍板）：**只加金額**（營業額／充值／扣點可以加，同幣值）；**會員數／客流唔可以跨店相加**，
一律逐店列。所以 R2 的批量結果我哋會按店分開顯示，唔會合併成一個「會員總數」。

---

## 附錄 A：我哋實際讀取的 key（R1 必須一致）

| key | 我哋點用 | 缺失時 |
|---|---|---|
| `order_count` | 線上單筆數 | 當 0（但會顯示「—」提示） |
| `order_paid_avos` / `order_balance_paid_avos` / `order_in_store_paid_avos` | 會員錢包付款拆解 | 當 0 |
| `topup_avos` / `topup_paid_avos` / `topup_gift_avos` | 充值總額（含贈送拆解） | 當 0 |
| `deduct_avos` / `deduct_paid_avos` / `deduct_gift_avos` | 扣點總額（含拆解） | 當 0 |
| `member_count` | 本店會員總數（wallets 列數） | 當 0 |
| `topup_count` / `deduct_count` / `new_member_count` / `balance_avos` | 筆數／新增會員／餘額 | 缺就唔 render（可接受） |

我哋會過濾非數字欄位（例如 `merchant_id`），所以 R2 回 array 時請**每個元素自帶 `merchant_id`**。

## 附錄 B：我哋會怎樣呼叫（接線後）

```ts
// server-only；client 用 service_role，永不落瀏覽器
const { data, error } = await ledgerService.rpc("get_merchant_report_summary_admin", {
  p_merchant_id: merchantId,
  p_start: "2026-10-21T00:00:00+08:00",
  p_end: "2026-10-21T23:59:59.999+08:00",
});
```

（現有店員路徑仍然用 `get_merchant_report_summary`，**兩條路並存**，互不影響。）
