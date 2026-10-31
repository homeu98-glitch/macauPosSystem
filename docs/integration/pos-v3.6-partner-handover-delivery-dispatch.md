# 給 Macau-Ledger 的 v3.6 派送整合交接（可直接轉貼）

> **對象**：Macau-Ledger 維護者
> **日期**：2026-10-31
> **現行契約**：[`pos-ledger-client-api.md`](pos-ledger-client-api.md) **v3.5**（2026-09-12）—— 本文是**增量需求**，未上線前以 v3.5 為準
> **POS 端狀態**：DB `pos_delivery_jobs` 已建立、派送資格／配送方式正規化已完成並有單測；UI 在功能旗標後面等本文件
> **不是**：改 `orders` 狀態機、改 `orders` 表、加 polling、POS 直連 SiteB

---

## 一句話

POS 要加「派送」：**線上外送單**用 Ledger 現有原生派送；**店內／平台單**用 Ledger 現有外部派單。兩條路都經 Ledger 中樞去 SiteB，POS 永遠唔會持有 SiteB 憑證。

---

## 上線次序（2026-10-31 商家拍板：線下先上）

POS 端把兩件事**拆開交付**，所以 Ledger 兩邊可以分先後做，唔需要一次過齊：

| 階段 | POS 開邊個旗標 | 需要 Ledger 邊部分 | 邊啲單會出「派送」掣 |
|---|---|---|---|
| ① 現在（UI 已完成，等 B 線） | `NEXT_PUBLIC_DELIVERY_DISPATCH=1` | **B1 外部派單** | 店內單、快餐 counter、澳覓／MFOOD 自送自取 |
| ② B1 好之後 | 再加 `NEXT_PUBLIC_DELIVERY_LIVE=1` | B1 | 同上，而且**真的叫車手** |
| ③ A 線好之後 | 再加 `NEXT_PUBLIC_DELIVERY_ONLINE=1` | A1–A5（＋C1/C2 聊天） | 再加線上 `merchant_delivery` 單 |

- ① 同 ③ 之間**可以隔幾耐都得**：`ONLINE` 未開時，線上單完全冇派送掣，維持 v3.5 行為（客人取消重落／商家線下處理），對線上流程零影響。
- 反過來，`ONLINE` 開咗但 `LIVE` 未開，只會寫 draft，唔會叫車 —— 所以**一定要等 B1 + LIVE 一齊開**才算「真派送」。
- B1 同 A 線**唔綁死**：B1 可以先上，A 線可以後補。呢個正是商家要求的次序。

---

## 0. 為什麼要改約

v3.5 明文禁止（原文）：

| 位置 | 原文 |
|---|---|
| §1.2 表 | 「SiteB 派送｜`merchantRequestDeliveryDispatch`、外派 Tab、車手 callback — **僅 Ledger Web**」 |
| §1.2 表 | 「訂單聊天｜`list/post_order_chat_message`」 |
| §5.5.3 / §484 | 「`create_order`、派送相關 Server Action 等一切 **Ledger Vercel** 路徑；`merchant_*_order_change`、訂單聊天 RPC …」列為契約外 |
| §9 驗收 #10 | 「派送｜POS 無 SiteB 派送按鈕／API」 |

2026-10-31 商家需求：店內電話單／平台「商家自送」單要可以由 POS 直接叫車手，唔想再開 Ledger Web。所以需要 v3.6 開一個**窄幅**窗口。

---

## 1. 範圍（5 + 2 支）

| # | Method | Path | 用途 | 包裝現有 |
|---|---|---|---|---|
| A1 | POST | `/api/integration/pos/delivery/dispatch` | 線上外送單呼叫派送 | `merchantRequestDeliveryDispatch` |
| A2 | POST | `/api/integration/pos/delivery/cancel` | 取消派送 | `merchantCancelDeliveryDispatch` |
| A3 | POST | `/api/integration/pos/delivery/hurry` | 催單 | `merchantHurryDeliveryDispatch` |
| A4 | POST | `/api/integration/pos/delivery/raise-price` | 加價 | `merchantRaiseDeliveryDispatchPrice` |
| A5 | GET | `/api/integration/pos/delivery/status` | 查派送狀態（重連補洞用） | `get_order_delivery_dispatch` |
| B1 | POST | `/api/integration/pos/delivery/external` | 店內／平台單外部派單 | `merchantCreateExternalDispatch`（需擴充） |
| C1 | — | 白名單 `list_order_chat_messages` / `post_order_chat_message` | 線上單聊天（客人＋車手） | 現成 RPC |
| C2 | — | 新增 `list_external_dispatch_chat_messages` / `post_external_dispatch_chat_message` | 外部派單聊天（只有車手） | 新 RPC |

> **唔需要**新表、唔需要改 `orders`、唔需要新 publication（`order_delivery_dispatch` 同 `merchant_external_dispatches` 已經喺 `supabase_realtime`：`20260707160000`、`20260715160000`）。

---

## 2. 通用約定

| 項目 | 規則 |
|---|---|
| 認證 | `Authorization: Bearer <店員 Supabase access_token>`（同 `/api/integration/pos/ensure-customer` 一致；**不要** service role） |
| 授權 | 由 token 取 `auth.uid()` → 查 `merchant_staff`；`merchantId` 必須屬於該用戶，否則 403 |
| 店鋪隔離 | 所有查詢一律 `.eq("merchant_id", merchantId)`；唔可以靠 client 傳入嘅 orderId 直接信 |
| 錯誤格式 | `{ "ok": false, "error": { "code": "...", "message": "..." } }`（HTTP status 見 §5） |
| 成功格式 | `{ "ok": true, ... }` |
| 幂等 | A1／B1 必須支援：同一 `idempotencyKey`（A1）或同一 `externalOrderRef`（B1）重送 → 回同一結果，**唔可以重複建 SiteB 單** |
| Polling | 一律禁止。POS 只會（a）撳掣時呼叫、（b）開「外送」tab 時訂閱 Realtime、（c）重連時打 A5 補洞 |
| 個資 | 回應只回 POS 已有嘅欄位；唔要回顧客 `profiles` 其他資料 |

---

## 3. A 線：原生派送（線上外送單）

### A1 `POST /api/integration/pos/delivery/dispatch`

```json
{
  "merchantId": "uuid",
  "orderId": "uuid（Ledger orders.id）",
  "feeMop": 30,
  "feePaidBy": "shop",
  "idempotencyKey": "pos-dispatch:018:2026-10-31T12:33:00+08:00"
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `feeMop` | 是 | 0–999；沿用現有 `SITE_B_DISPATCH_FEE_OPTIONS_MOP` 亦可，但 API 唔強制枚舉 |
| `feePaidBy` | 否 | `shop`（預設）／`customer` |
| `idempotencyKey` | 是 | 8–128 字；同一 key 重送唔可以再叫一次車手 |

**成功 200**

```json
{
  "ok": true,
  "dispatch": {
    "id": "uuid（order_delivery_dispatch.id）",
    "orderId": "uuid",
    "status": "new",
    "feeMop": 30,
    "feePaidBy": "shop",
    "providerOrderId": "uuid（SiteB orders.id）",
    "externalOrderRef": "uuid（= orderId，重派會係 orderId-r{ts}）",
    "created": true
  }
}
```

**行為**：直接 reuse `merchantRequestDeliveryDispatch()` 嘅所有守衛（`fulfillment_type=merchant_delivery`、地址／電話／同意快照／座標、店鋪地址＋座標、狀態 accepted/preparing/ready、已有進行中派送），**唔好放寬**。POS 已經喺前端擋咗一次，API 係第二道閘。

**常見錯誤**

| code | HTTP | 觸發 |
|---|---|---|
| `forbidden` | 403 | 唔係該店 staff |
| `order_not_found` | 404 | 訂單唔存在／唔屬於此店 |
| `not_delivery_order` | 409 | `fulfillment_type ≠ merchant_delivery` |
| `invalid_status` | 409 | 唔係 accepted/preparing/ready |
| `dispatch_exists` | 409 | 已有進行中派送 |
| `phone_consent_missing` | 409 | 舊單冇 `delivery_phone_consented_at` |
| `shop_coords_missing` | 400 | 店鋪未設經緯度 |
| `customer_coords_missing` | 400 | 訂單缺配送座標 |
| `delivery_disabled` | 503 | SiteB env 未齊（現有 `SITE_B_DELIVERY_DISABLED_MESSAGE`） |
| `provider_error` | 502 | SiteB 回應失敗（回 `message`） |

> ⚠️ 現有 action 回中文 error string；API 要**轉成 code**，`message` 可以照舊中文（POS 直接顯示）。

### A2 `POST /delivery/cancel` · A3 `/hurry` · A4 `/raise-price`

Body 分別為：

```json
{ "merchantId": "...", "orderId": "..." }                  // cancel
{ "merchantId": "...", "orderId": "..." }                  // hurry
{ "merchantId": "...", "orderId": "...", "feeMop": 35 }    // raise-price
```

成功一律 `{ ok: true, dispatch: { ...同 A1 同樣結構 } }`。錯誤沿用 A1 表，另加：

| code | HTTP | 觸發 |
|---|---|---|
| `not_cancelable` | 409 | 已取貨／已送達 |
| `not_hurriable` | 409 | 未有車手接單 |
| `not_raisable` | 409 | 已取貨 |

> A4 唔可以改 `orders.total_avos`；加價只影響車手費（現有行為）。

### A5 `GET /delivery/status?merchantId=...&orderId=...`

回 `{ ok: true, dispatch: { ... } | null }`。用途：POS Realtime 斷線重連後補洞（一次性，唔係輪詢）。

---

## 4. B 線：外部派單（店內／平台單）

### B1 `POST /api/integration/pos/delivery/external`

呢條線**冇 Ledger 訂單**，所以要由 POS 帶齊資料。

```json
{
  "merchantId": "uuid",
  "externalOrderRef": "pos:8291f843-...:2026-10-31:003",
  "orderNoSnapshot": "外賣 003",
  "platform": null,
  "deliveryMode": "merchant",
  "sourceNote": "POS 店內外賣單",
  "feeMop": 30,
  "feePaidBy": "shop",
  "codAmountMop": 128,
  "customer": {
    "name": "陳小姐",
    "phone": "66123456",
    "address": "黑沙環中街 88 號 金海山花園 5 樓 A",
    "latitude": null,
    "longitude": null,
    "note": "管理處交收，到達請致電"
  },
  "items": [
    { "name": "大麥克牛肉麵", "quantity": 1 },
    { "name": "凍檸茶", "quantity": 1 }
  ]
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `externalOrderRef` | 是 | POS 穩定單號（**唔可以**每次隨機）；SiteB `externalOrderId` 直接用它，重送＝同一單 |
| `orderNoSnapshot` | 是 | 顯示用（外賣 003／澳覓 463403），唔參與邏輯 |
| `platform` | 否 | `aomi` / `mfood`；店內單留 null |
| `deliveryMode` | 是 | `merchant` / `pickup` 先准派；`platform` / `unknown` → 409 `not_deliverable`（第二道閘，防 POS 繞過） |
| `customer.address` | 是 | 冇地址就唔好派（POS 已擋） |
| `customer.latitude/longitude` | **否** | 商家只有地址（自由文字），**POS 冇能力提供座標** ⇒ 傳 `null`。Ledger 現有 `merchantCreateExternalDispatch()` 本身都收 null；唔好因為缺座標而 400 |
| `customer.phone` | 是 | 車手要聯絡 |
| `codAmountMop` | 否 | 貨到付款；SiteB 冇欄位，寫入 `shopNote`／`offline_payment_note` |
| `items` | 否 | 車手對單用（SiteB `order_items` 只有 name+qty，冇價） |

**成功 200**

```json
{
  "ok": true,
  "dispatch": {
    "id": "uuid（merchant_external_dispatches.id）",
    "externalOrderRef": "pos:...:003",
    "status": "new",
    "providerOrderId": "uuid",
    "feeMop": 30,
    "feePaidBy": "shop",
    "created": true
  }
}
```

**實作提示**

1. 沿用 `merchantCreateExternalDispatch()` 嘅驗證（店鋪地址＋座標、fee 合法、電話 parse），但：
   - `mode` 固定 `"address"`（唔需要相片）；`image_urls` 可以空陣列。
   - `externalOrderId` **用 `externalOrderRef`，唔用 `randomUUID()`**（現有 action 係隨機，唔可以照抄）。
   - `items` 要傳入 SiteB（現有 action 寫死 `items: []`，要加）。
   - `codAmountMop > 0` 時，`shopNote` 加一句「貨到付款 MOP xxx，請車手代收」。
2. `merchant_external_dispatches` 有 `unique (provider, external_order_ref)` → 用 upsert，重送返同一 row。
3. 重派（已取消再派）：同一個 `externalOrderRef` 會撞 unique；此時回 `409 dispatch_exists`，由 POS 決定是否用新 ref（`...:003-r2`）。

**錯誤**：同 A1 表，另加

| code | HTTP | 觸發 |
|---|---|---|
| `missing_address` | 400 | 冇地址 |
| `missing_coords` | ~~400~~ | **B1 唔應該再回呢個**：POS 冇座標來源（見上面 `customer.latitude/longitude`）|
| `missing_phone` | 400 | 冇電話 |
| `not_deliverable` | 409 | `deliveryMode` 係 `platform`／`unknown`（平台專送或未知） |
| `dispatch_exists` | 409 | 同一 `externalOrderRef` 已有進行中派單 |

---

## 5. C 線：聊天

### C1 線上單房間（客人＋商家＋車手）

技術上 POS 用 staff JWT 已經打得郁（`grant execute to authenticated` + `is_merchant_staff`），**唯一需要嘅係契約白名單**：

```
rpc list_order_chat_messages(p_order_id uuid, p_since timestamptz default null)
rpc post_order_chat_message(p_order_id uuid, p_body text, p_client_msg_id text default null)
```

POS 行為：只喺「詳情 › 訊息」tab 開啟時讀（`p_since` 增量），離開即停；**冇輪詢**。

### C2 外部派單房間（只有車手）

現有兩支 RPC 只收 `p_order_id`，外部房間（`order_chat_messages.external_dispatch_id`）冇 RPC。請加兩支鏡像：

```sql
create or replace function public.list_external_dispatch_chat_messages(
  p_dispatch_id uuid,
  p_since timestamptz default null
) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  -- 權限：該 dispatch 屬於 auth.uid() 嘅 merchant（is_merchant_staff）
  -- 查詢：order_chat_messages where external_dispatch_id = p_dispatch_id
  --       and (p_since is null or created_at > p_since) order by created_at, id
end $$;

create or replace function public.post_external_dispatch_chat_message(
  p_dispatch_id uuid,
  p_body text,
  p_client_msg_id text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  -- 同 post_order_chat_message 一樣：body 1–500、每人每分鐘 10 條、
  -- (external_dispatch_id, client_msg_id) 唯一、sender_role='merchant'、sender_label=店名
end $$;
```

> 如果嫌寫兩支新 RPC 麻煩，退而求其次：開放 `order_chat_messages` 對 staff 嘅 **select**（已有 RLS），再加一支 `post_external_dispatch_chat_message`。但讀寫經 RPC 會一致啲（限流／標籤／冪等都由 DB 做）。

---

## 6. D 線：狀態回寫（唔使新工作）

```
車手 App → SiteB → callback → Ledger update order_delivery_dispatch / merchant_external_dispatches
        → Realtime（publication 已開）→ POS（只喺「外送」tab 開啟時訂閱）
```

POS 訂閱參數（確認 RLS 已允許 staff select 即可，兩個表都已有 policy）：

```ts
supabase.channel(`delivery:${merchantId}`)
  .on("postgres_changes", { event: "*", schema: "public", table: "order_delivery_dispatch", filter: `merchant_id=eq.${merchantId}` }, ...)
  .on("postgres_changes", { event: "*", schema: "public", table: "merchant_external_dispatches", filter: `merchant_id=eq.${merchantId}` }, ...)
```

離線或用戶離開 tab → `removeChannel`，**唔會常駐**。

---

## 7. 錯誤碼總表

| code | HTTP | 意思 |
|---|---|---|
| `unauthorized` | 401 | 冇／過期 token |
| `forbidden` | 403 | 唔係該店 staff |
| `order_not_found` | 404 | 訂單唔存在 |
| `not_delivery_order` | 409 | 線上單唔係外送單 |
| `invalid_status` | 409 | 狀態唔准派 |
| `dispatch_exists` | 409 | 已有進行中派送 |
| `not_cancelable` / `not_hurriable` / `not_raisable` | 409 | 動作唔適用 |
| `phone_consent_missing` | 409 | 缺電話同意快照 |
| `missing_address` / `missing_phone` | 400 | 外部派單缺資料（**座標唔算缺**）|
| `shop_coords_missing` | 400 | 店鋪未設座標 |
| `delivery_disabled` | 503 | SiteB 未配置 |
| `provider_error` | 502 | SiteB 失敗 |
| `rate_limited` | 429 | 聊天限流 |

---

## 8. 驗收清單

1. 店員 JWT 打 A1–A5／B1 成功；非該店 staff 一律 403。
2. A1 同一 `idempotencyKey` 重送兩次 → SiteB 只建一張單（`created:false` 第二次）。
3. A1 喺 `pending`／`completed`／非外送單 → 409，且**冇**建 SiteB 單。
4. A1 店鋪未設座標 → 400 `shop_coords_missing`（同 Ledger Web 文案一致）。
5. A1 成功後 `order_delivery_dispatch` 有 row，Realtime 推到 POS。
6. A2／A3／A4 行為同 Ledger Web 完全一致（同一堆守衛）。
7. B1 同一 `externalOrderRef` 重送 → 同一 `merchant_external_dispatches.id`，SiteB 唔重複。
8. B1 有 `codAmountMop` → SiteB `offline_payment_note` 見到代收金額。
9. B1 `items` 有傳入 SiteB（車手 App 見到品項）。
10. B1 `deliveryMode=platform`／`unknown` → 409 `not_deliverable`，而且**冇**建 SiteB 單。
11. C1 白名單：POS staff 讀寫線上單房間成功；非參與者 403。
12. C2 外部房間：POS staff 讀寫成功；`sender_role='merchant'`、`sender_label=店名`。
13. 所有 endpoint 都**冇**改 `orders.status`（除咗 callback 本身）。
14. 冇任何 polling；POS 斷線重連只用 A5 補一次。

---

## 9. 時程 / 分工

| 項目 | 負責 |
|---|---|
| A1–A5 endpoint + 錯誤碼 | Ledger |
| B1 外部派單 endpoint（改用外部 ref、加 items、加 cod note） | Ledger |
| C1 契約白名單（無代碼） | Ledger |
| C2 兩支聊天 RPC | Ledger |
| POS UI／job 表／派送彈窗／外送 tab | POS（進行中，旗標關閉） |
| 聯調（UAT） | 雙方 |

---

## 附錄：POS 端已定案嘅判斷（僅供參考，唔使實作）

POS 只會喺以下情況顯示「派送」掣：

| 來源 | 條件 |
|---|---|
| 線上 | `fulfillment_type = merchant_delivery` 且 accepted/preparing/ready |
| 店內 | `sent_to_kitchen` / `paid` / `settled` / `reopened` |
| 平台 | `raw.sendType`（澳覓）＝自送／自取，或 `raw.deliveryType`（MFOOD）＝2／3 |

平台專送（澳覓「專送」、MFOOD `1`）同未知值 → **唔顯示**，API 亦應該回 `not_delivery_order`／`invalid_status` 防繞過。
