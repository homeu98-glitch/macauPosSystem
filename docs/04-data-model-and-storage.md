# 資料模型與儲存

> **最後更新**：2026-08-12  
> 類型定義權威：`src/lib/types.ts`

---

## 1. localStorage 鍵一覽

| 鍵 | 類型 | 說明 |
|----|------|------|
| `macau-pos/bootstrap` | `PosBootstrap` | 菜單、分類、桌台、規則 |
| `macau-pos/device-config` | `DeviceConfig` | 終端名、打印機列表 |
| `macau-pos/local-settings` | `PosLocalSettings` | 樓層、支付、打印模板、備註、線上單設定 |
| `macau-pos/orders` | `PosOrder[]` | 店內訂單 |
| `macau-pos/print-jobs` | `PrintJob[]` | 打印任務隊列 |
| `macau-pos/sync-queue` | `QueueEvent[]` | 待上傳同步事件 |
| `macau-pos/members` | `MemberProfile[]` | 會員 |
| `macau-pos/auth-session` | session object | Ledger tokens、merchantId |
| `macau-pos/offline-mode` | `"0"` / `"1"` | 離線模式 |
| `macau-pos/sold-out` | sold-out map | 沽清狀態 |
| `macau-pos/shift` | shift state | 當前班次 |
| `macau-pos/shift-history` | shift[] | 歷史班次 |
| `macau-pos/operating-mode` | `"dinein"` / `"quick"` | 工作模式 |
| `macau-pos/quick-auto-accept` | boolean string | 快餐自動接單 |
| `macau-pos/quick-completed-minutes` | number string | 自動完成分鐘數 |
| `macau-pos/account-users` | `AccountUser[]` | Admin 帳戶 |
| `macau-pos/account-stores` | `AccountStore[]` | 門店列表 |
| `macau-pos/permission-groups` | `AccountPermissionGroup[]` | 權限組 |

讀寫封裝：`src/lib/storage.ts`

---

## 2. 核心 TypeScript 類型

### 訂單與同步

```typescript
// PosOrder — 店內訂單
interface PosOrder {
  id: string;
  orderNo: string;
  mode: "dinein" | "quick";
  status: "draft" | "open" | "settled" | "completed" | "cancelled";
  items: OrderItem[];
  tableId?: string;
  tableName?: string;
  // ... payments, totals, notes, timestamps
}

// QueueEvent — 同步事件
type QueueEventType =
  | "ORDER_CREATED" | "ORDER_UPDATED" | "ORDER_SETTLED"
  | "PRINT_JOB_CREATED" | "DEVICE_CONFIG_UPDATED" | "TEST_PRINT_REQUESTED";

interface QueueEvent {
  id: string;
  type: QueueEventType;
  entityId: string;
  payload: unknown;
  createdAt: string;
  synced?: boolean;
}
```

### 打印

```typescript
type PrinterRole = "zone" | "receipt" | "label";
type ConnectionType = "lan" | "usb";

interface DevicePrinterConfig {
  id: string;
  name: string;
  role: PrinterRole;
  zoneId?: string;
  connectionType: ConnectionType;
  // lan: host, port; usb: deviceId
}

interface PrintJob {
  id: string;
  orderId: string;
  type: "kitchen" | "receipt" | "label";
  status: "pending" | "sent" | "failed";
  printerId: string;
  content: string;
  createdAt: string;
}
```

### Bootstrap 與設定

```typescript
interface PosBootstrap {
  storeId: string;
  storeName: string;
  currency: string;
  categories: MenuCategory[];
  menuItems: MenuItem[];
  tables: StoreTable[];
  rules: PosRules;
  printerGroups: string[];
}

interface PosLocalSettings {
  floors: FloorConfig[];
  paymentMethods: string[];
  printZones: PrintZone[];
  notePresets: string[];
  specTemplates: SpecTemplate[];
  onlineOrderSettings: { autoAccept: boolean };
}
```

### 帳戶與權限

```typescript
type UserRole = "admin" | "manager" | "cashier";

interface UserPermissions {
  refundOrder: boolean;
  voidItem: boolean;
  manageAccounts?: boolean;
}
```

### Ledger 映射（`src/lib/ledger/order-mapper.ts`）

- `LedgerOrderRow` — Supabase `orders` 表 row
- `LedgerOnlineOrder` — UI 展示模型
- `LedgerOrderTab` — 分 tab 篩選（待接、製作中…）

---

## 3. POS Supabase 表（可選）

當配置 `SUPABASE_URL` + keys 時，API Routes 使用以下表：

| 表 | 用途 |
|----|------|
| `pos_bootstrap_config` | Bootstrap 配置 |
| `pos_orders` | 店內訂單 |
| `pos_queue_events` | 同步事件 |
| `pos_print_jobs` | 打印任務 |
| `pos_device_configs` | 設備配置 |
| `pos_members` | 會員 |
| `pos_member_coupons` | 會員券 |
| `online_order_settings` | 自動接單設定 |
| `admin_stores` | Admin 門店 |
| `admin_account_users` | Admin 帳戶 |
| `admin_permission_groups` | 權限組 |
| `backoffice_sync_jobs` | 同步任務審計 |

Admin 表 DDL：[sql/admin-account-schema.sql](./sql/admin-account-schema.sql)

---

## 4. Ledger Supabase（必配）

本 POS **不擁有** Ledger schema；透過 RPC 與 Realtime 存取：

| 資源 | 操作 |
|------|------|
| `orders` 表 | Realtime subscribe + 寫 RPC |
| `list_merchant_orders` | 讀列表、增量 |
| `get_order_detail` | 讀明細 |
| `accept_order_with_deduct` | 扣點接單 |
| `accept_order_in_store` | 到店付款接單 |
| `update_order_status` | 狀態推進 |
| `set_order_paid_in_store` | 標記已收款 |
| `get_merchant_report_summary` | 報表 |
| `list_merchant_order_menu` | 菜單對照 |

契約詳見 [integration/ledger-client-api.md](./integration/ledger-client-api.md)。

---

## 5. Mock 與 Fallback

| 資料 | 無 Supabase 時 |
|------|----------------|
| Bootstrap | `mock-data.ts` → `mockBootstrap` |
| 會員 | `defaultMembers` |
| 訂單 / 隊列 / 打印 | 空陣列或 localStorage 已有資料 |
| Admin 帳戶 | mock-data 種子 |
| 序號 | 本地隨機數 |

---

## 6. 資料流

```
用戶操作
  → React state 更新
  → storage.ts 寫 localStorage
  → QueueEvent 入 sync-queue（如需同步）
  → 有網：POST /api/pos/sync → POS Supabase

線上訂單（獨立路徑）
  → Ledger Realtime → order-mapper → UI
  → 接單 RPC → ledger-pos-bridge → 本地 PosOrder + PrintJob
```

---

## 7. 遷移計劃

- [ ] sync-queue / orders 大資料 → IndexedDB
- [ ] 版本化 bootstrap（`since_version` 增量）
- [ ] 顧客 PII 不寫 localStorage（Ledger 線上單已遵守）
