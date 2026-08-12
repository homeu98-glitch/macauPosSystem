# 主系統 / POS 後台 API 對接

> **最後更新**：2026-08-12  
> 對應本 repo API Routes + 建議主系統 REST 契約

Ledger 線上訂單整合見 [ledger-client-api.md](./ledger-client-api.md)（**不走本文件路徑**）。

---

## 對接範圍

POS 前端已具備業務骨架，主系統對接集中在：

- 基礎配置下發
- 設備與打印配置回寫
- 店內訂單與支付回寫
- 庫存 / 沽清同步
- Admin 帳戶（POS Supabase）

---

## 當前實作（本 repo API）

### 1. POS 基礎配置

| 路由 | 方法 | 現狀 |
|------|------|------|
| `/api/pos/bootstrap` | GET | mock 或 `pos_bootstrap_config` |
| `/api/pos/bootstrap` | POST | 需 POS Supabase |

**GET 返回**：storeId, storeName, currency, categories, menuItems, tables, rules, printerGroups

**建議主系統提供**：

```
GET /pos/bootstrap
GET /pos/config?since_version=...
```

### 2. 設備配置

| 路由 | 方法 |
|------|------|
| `/api/pos/device-config` | GET, POST |

**回寫內容**：

- 本機名、打印機列表
- localSettings：打印分區、菜品覆蓋、規格模板、備註、支付方式、自動接單

**建議表結構**：

| 欄位 | 類型 |
|------|------|
| device_id | text |
| terminal_name | text |
| store_id | text |
| printers | jsonb |
| local_settings | jsonb |
| updated_at | timestamptz |

### 3. 店內訂單與同步

| 路由 | 方法 |
|------|------|
| `/api/pos/orders` | GET |
| `/api/pos/sync` | POST |
| `/api/pos/state` | GET |
| `/api/pos/sequence` | POST |

**同步事件類型**：

- `ORDER_CREATED`, `ORDER_UPDATED`, `ORDER_SETTLED`
- `PRINT_JOB_CREATED`, `DEVICE_CONFIG_UPDATED`, `TEST_PRINT_REQUESTED`

**建議主系統批量補傳**：

```
POST /pos/sync/batch
```

每條事件：`event_id`, `event_type`, `entity_id`, `payload`, `created_at`

**建議主系統訂單/支付**：

```
POST /pos/orders
POST /pos/payments
```

### 4. 會員（POS 側）

| 路由 | 方法 |
|------|------|
| `/api/members` | GET, POST |

GET → mock 或 `pos_members`；POST create/recharge。

> 線上會員權威在 Ledger；此 API 為店內 POS 會員快取。

### 5. 線上訂單設定

| 路由 | 方法 |
|------|------|
| `/api/online-order-settings` | GET, POST |

`autoAccept` 開關 → `online_order_settings` 表。

> **注意**：`/api/online-orders` 已 **410 廢棄**。線上單走 Ledger，見 [ledger-client-api.md](./ledger-client-api.md)。

### 6. 沽清 / 庫存

| 路由 | 方法 | 現狀 |
|------|------|------|
| `/api/inventory/soldout` | POST | stub（TODO） |

**建議主系統欄位**：menu_item_id, remaining_qty, initial_qty, updated_at

### 7. Admin 帳戶

| 路由 | 方法 |
|------|------|
| `/api/admin/accounts` | GET, POST, PATCH, DELETE |

需 `SUPABASE_SERVICE_ROLE_KEY`。DDL：[../sql/admin-account-schema.sql](../sql/admin-account-schema.sql)

### 8. Backoffice

| 路由 | 方法 |
|------|------|
| `/api/backoffice/overview` | GET |
| `/api/backoffice/stores/[storeId]` | GET, PATCH |

---

## 打印對接

前端負責：

1. 生成 `PrintJob`
2. 管理打印機配置（role / zoneId / connectionType）
3. 標記任務狀態

**落地打印**建議本地橋接服務：

```
PrintJob → 本地服務 → LAN/USB → ESC/POS 打印機
```

兼容：EPSON 80/58mm、Star 收據、Brother/TSC 標籤。

---

## Mock → 生產遷移清單

- [ ] `GET /api/pos/bootstrap` 改拉主系統
- [ ] `POST /api/pos/sync` 對接主系統 batch API
- [ ] `POST /api/inventory/soldout` 接真實庫存
- [ ] 增量配置 `since_version`
- [ ] device-config 雙向同步衝突策略

---

## 相關文檔

- [ledger-client-api.md](./ledger-client-api.md) — 線上訂單（Ledger）
- [../06-api-reference.md](../06-api-reference.md) — 本 repo API 詳細
- [ecosystem-modules.md](./ecosystem-modules.md) — 生態系總覽
