# 主系统对接说明

## 对接范围

这个 POS 前端已经具备基本业务骨架，主系统对接重点集中在以下几类接口：

- 基础配置下发
- 设备与打印配置回写
- 订单与支付回写
- 线上订单读写
- 库存 / 沽清同步

## 当前接口映射

### 1. POS 基础配置

- `GET /api/pos/bootstrap`
- 作用：
  - 下发店铺名、货币、分类、菜品、桌台、规则、打印分区

建议主系统最终提供：

- `GET /pos/bootstrap`
- 返回字段建议：
  - `storeId`
  - `storeName`
  - `currency`
  - `categories`
  - `menuItems`
  - `tables`
  - `rules`
  - `printerGroups`

### 2. 设备配置

- `GET /api/pos/device-config`
- `POST /api/pos/device-config`

当前前端会回写：

- 本机名
- 打印机列表
- 本地设置
  - 打印分区
  - 菜品打印覆盖
  - 规格模板
  - 常用备注
  - 支付方式
  - 线上订单自动接单

建议主系统表结构至少可存：

- `device_id`
- `terminal_name`
- `store_id`
- `printers` `jsonb`
- `local_settings` `jsonb`
- `updated_at`

### 3. POS 订单与支付

- `GET /api/pos/orders`
- `POST /api/pos/sync`

当前同步事件包含：

- `ORDER_CREATED`
- `ORDER_UPDATED`
- `ORDER_SETTLED`
- `PRINT_JOB_CREATED`
- `DEVICE_CONFIG_UPDATED`
- `TEST_PRINT_REQUESTED`

建议主系统支持批量补传：

- `POST /pos/sync/batch`

每条事件建议包含：

- `event_id`
- `event_type`
- `entity_id`
- `payload`
- `created_at`

### 4. 线上订单

- `GET /api/online-orders`
- `POST /api/online-orders`

当前已覆盖动作：

- `accept`
- `assign_table`
- `complete`
- `cancel`
- `confirm_customer_cancel`
- `reject_customer_cancel`
- `auto_accept`
- `handoff_to_rider`
- `convert_quick`

建议 `online_orders` 至少具备字段：

- `id`
- `order_no`
- `type`
- `status`
- `payment_status`
- `paid_amount`
- `customer_name`
- `customer_phone`
- `total`
- `created_at`
- `accepted_at`
- `assigned_table_name`
- `cancelled_at`
- `cancel_rejected_at`

明细表建议：

- `online_order_items`
  - `order_id`
  - `product_name`
  - `qty`

### 5. 沽清 / 库存

- `GET /api/inventory/soldout`
- `POST /api/inventory/soldout`

建议主系统支持字段：

- `menu_item_id`
- `remaining_qty`
- `initial_qty`
- `updated_at`

## 打印机对接建议

前端现在只负责：

- 生成打印任务
- 管理打印机配置
- 标记打印角色与分区

真正落地打印时，建议由本地桥接服务负责：

1. 前端生成 `PrintJob`
2. 本地服务读取任务
3. 根据 `role / zoneId / model / paperSize / connectionType` 选路
4. 输出到 LAN / USB 打印机

建议打印驱动层兼容：

- EPSON ESC/POS 80mm / 58mm
- Star 收据打印机
- Brother / TSC 标签机

## SQL 说明

当前仓库已经提供两份可选 SQL，仅在数据库 `status` 字段是 enum 时需要：

- `db_optional_add_paid_status_enum.sql`
- `db_optional_add_online_completed_status_enum.sql`

如果 `status` 是 `text` 或 `varchar`，这两份都不用跑。
