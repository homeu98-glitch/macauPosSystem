# API 路由參考

> **最後更新**：2026-08-12  
> 路徑根：`src/app/api/`

---

## 概覽

| 路由 | 方法 | Mock fallback | 說明 |
|------|------|---------------|------|
| `/api/ledger/login` | POST | **503 無 env** | **主登入** — Ledger Auth |
| `/api/auth/login` | POST | mock | 舊 Admin 登入（UI 未用） |
| `/api/pos/bootstrap` | GET, POST | GET→mock | Bootstrap 配置 |
| `/api/pos/state` | GET | 空+mock 會員 | 批量 POS 狀態 |
| `/api/pos/orders` | GET | 空陣列 | 店內訂單列表 |
| `/api/pos/sync` | POST | ok 無寫入 | 同步隊列上傳 |
| `/api/pos/sequence` | POST | 隨機序號 | 日序號 RPC |
| `/api/pos/device-config` | GET, POST | GET→null | 設備配置 |
| `/api/members` | GET, POST | mock | 會員 |
| `/api/online-order-settings` | GET, POST | autoAccept:false | 自動接單 |
| `/api/online-orders` | * | **410 Gone** | 已廢棄，用 Ledger |
| `/api/inventory/soldout` | POST | stub | 沽清通知 |
| `/api/admin/accounts` | GET,POST,PATCH,DELETE | GET→mock | Admin CRUD |
| `/api/backoffice/overview` | GET | mock | 後台總覽 |
| `/api/backoffice/stores/[storeId]` | GET, PATCH | mock | 門店詳情 |

---

## 詳細說明

### POST `/api/ledger/login`

**主登入入口。**

```json
// Request
{ "phone": "66668888", "pin": "1234" }

// Response 200
{
  "accessToken": "...",
  "refreshToken": "...",
  "merchantId": "uuid",
  "merchantName": "店名",
  "staffName": "員工"
}
```

- 需 env：`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `AUTH_PIN_PEPPER`
- 無 env → 503
- 速率限制內建

---

### GET `/api/pos/bootstrap`

返回 `PosBootstrap`：storeId, categories, menuItems, tables, rules, printerGroups

- 有 POS Supabase → `pos_bootstrap_config`
- 無 → `mockBootstrap`

### POST `/api/pos/bootstrap`

Upsert bootstrap。需 POS Supabase，否則 500。

---

### GET `/api/pos/state`

批量返回：

```json
{
  "orders": [],
  "queue": [],
  "printJobs": [],
  "deviceConfig": null,
  "members": [],
  "localSettings": null
}
```

---

### POST `/api/pos/sync`

上傳 `QueueEvent[]`，寫入 `pos_queue_events`、`pos_orders`、members、print jobs。

無 Supabase：返回 `{ ok: true }` 但不寫 DB。

**事件類型**：

- `ORDER_CREATED`, `ORDER_UPDATED`, `ORDER_SETTLED`
- `PRINT_JOB_CREATED`, `DEVICE_CONFIG_UPDATED`, `TEST_PRINT_REQUESTED`

---

### POST `/api/pos/sequence`

```json
{ "storeId": "...", "date": "2026-08-12" }
→ { "sequence": 42 }
```

有 Supabase：`next_daily_sequence` RPC；無：隨機 100–999。

---

### GET/POST `/api/pos/device-config`

設備名、打印機列表、`localSettings` jsonb。

---

### GET/POST `/api/members`

- GET：查詢會員 + 券
- POST：`action`: `create` | `recharge`

---

### GET/POST `/api/online-order-settings`

`{ autoAccept: boolean }`

---

### `/api/online-orders` — **已廢棄**

所有方法返回 **410**，body 指向 Ledger Supabase RPC + Realtime。

---

### `/api/admin/accounts`

| 方法 | 說明 |
|------|------|
| GET | 列表（mock 或 DB） |
| POST | 新增 |
| PATCH | 更新 PIN/角色/門店 |
| DELETE | 刪除 |

Mutations 需 `SUPABASE_SERVICE_ROLE_KEY`。

---

### `/api/backoffice/overview`

門店、帳戶、權限組、最近 sync jobs。

### GET/PATCH `/api/backoffice/stores/[storeId]`

門店詳情、bootstrap 摘要、設備、sync jobs；PATCH 切換 active。

---

## Ledger 直連（非 Next API）

以下由**前端直連 Ledger Supabase**，不經本 repo API：

| RPC | 用途 |
|-----|------|
| `list_merchant_orders` | 線上訂單列表 |
| `get_order_detail` | 明細 |
| `accept_order_with_deduct` | 扣點接單 |
| `accept_order_in_store` | 到店付接單 |
| `update_order_status` | 狀態 |
| `set_order_paid_in_store` | 標記已付 |
| `get_merchant_report_summary` | 報表 |
| `list_merchant_order_menu` | 菜單 |

+ Realtime：`public.orders` filter `merchant_id`

詳見 [integration/ledger-client-api.md](./integration/ledger-client-api.md)。

---

## 建議主系統對接 API（未實作）

第一批對接目標（見 [integration/main-system-integration.md](./integration/main-system-integration.md)）：

- `GET /pos/bootstrap`
- `GET /pos/config?since_version=...`
- `POST /pos/orders`
- `POST /pos/payments`
- `POST /pos/device-config`
- `POST /pos/sync/batch`
