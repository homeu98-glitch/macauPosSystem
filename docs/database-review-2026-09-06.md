# macauPos Database 审查报告（2026-09-06）

> **审查范围**：Supabase 内 POS 相关表结构、代码引用、以及 per-store 隔离现状。  
> **结论先行**：admin 4 张表**仍在使用**；online order 4 张表 + pos member 2 张表**已废弃**；per-store settings 仍有 6 处需要调整。  
> **状态**：仅整理分析，未修改任何代码或数据。

---

## 1. Admin 相关 4 张表：仍在使用中，不建议直接删除

| 表名 | 设计用途 | 代码引用位置 | 是否仍在使用 |
|------|----------|--------------|--------------|
| `admin_stores` | POS 后台维护的「门店列表」，给 backoffice 用 | `src/lib/admin-account-server.ts:150`<br>`src/lib/backoffice-server.ts:170, 237`<br>`src/app/api/admin/accounts/route.ts` | ✅ 是 |
| `admin_account_users` | POS 本地管理员 / 店员账号（8 位账号 + 4 位 PIN） | `src/lib/admin-account-server.ts:73, 114, 149`<br>`src/app/api/admin/accounts/route.ts:64, 130, 166` | ✅ 是 |
| `admin_permission_groups` | 账号权限模板（admin / manager / cashier） | `src/lib/admin-account-server.ts:88, 151`<br>`src/app/api/admin/accounts/route.ts` | ✅ 是 |
| `admin_account_store_bindings` | 账号与门店的多对多绑定 | `src/lib/admin-account-server.ts:89, 152`<br>`src/app/api/admin/accounts/route.ts:84, 136, 138, 165` | ✅ 是 |

### 重要发现

1. **DDL 不在 migrations 里**：这 4 张表的创建脚本只在 `docs/sql/admin-account-schema.sql`，不在 `supabase/migrations/`。这意味着它们不是由自动化 migration 部署的，很可能是在项目早期手动建表/种子数据。如果将来要重建环境，会漏掉这 4 张表。

2. **store_id 类型与主系统不一致**：
   - `admin_stores.id` 是 `text`，种子数据是 `'macau-store-a'`、`'macau-store-b'` 这类旧 mock ID。
   - POS 订单/同步/报表里真正的 store scope 现在是 Ledger `merchants.id`（UUID，例如 `60000003` 对应的 UUID）。
   - 这会造成后台管理的「门店」与 POS 订单里的 `store_id` 不是同一套标识，可能存在概念混淆。

3. **是否需要 per-store 改造**：admin 表本身就是**全局后台配置**（用来管理有哪些门店、谁可以登录），它们本来就该是全局表。真正该 per-store 的不是 admin 表，而是 admin 表引用的那些「门店配置」（bootstrap / device-config / settings）是否按门店隔离。见第 4 节。

---

## 2. Online Order 相关 4 张表：已废弃，可以安全清理

| 表名 | 原本用途 | 代码引用 | 是否仍在使用 |
|------|----------|----------|--------------|
| `online_orders` | 早期 POS 自己保存的线上订单 | 无代码引用。仅在旧文档 `docs/integration/ledger-client-api.md`、`ledger-client-api-v2-source.md` 里出现过历史记录 | ❌ 否 |
| `online_order_items` | 早期线上订单的菜品明细 | 同上 | ❌ 否 |
| `online_order_settings` | 早期线上订单自动接单开关 | 同上。已被 `pos_online_order_settings` 取代 | ❌ 否 |
| `online_order_status_logs` | 早期线上订单状态日志 | 同上 | ❌ 否 |

### 重要发现

1. **没有任何 migration 创建这 4 张表**：全 repo 搜索 `CREATE TABLE ... online_order` 只找到 `pos_online_order_settings` 的创建脚本（`0019_pos_online_order_settings.sql`）。说明这 4 张表是更早期的历史遗留，或者由外部系统/旧版本创建。

2. **当前线上订单走 Ledger**：
   - 线上订单数据权威在 Ledger 侧 `orders` 表。
   - POS 本地只保存同步后的 `pos_orders`（`online_order_id` 字段）。
   - 自动接单开关保存在 `pos_online_order_settings`（`store_id` 为 PK，per-store）。

3. **处理建议**：
   - 可以在确认无业务依赖后 `DROP TABLE` 或清空这 4 张表。
   - 建议先跑 `SELECT count(*) FROM ...` 确认它们是否有数据；如果为空，删除无风险。

---

## 3. POS Member 相关 2 张表：已废弃，且没有 store_id 字段

| 表名 | 原本用途 | 代码引用 | 是否仍在使用 | 是否有 store_id |
|------|----------|----------|--------------|-----------------|
| `pos_members` | 早期 POS 本地 mock 会员 | 无代码引用。仅在旧文档 `docs/04-data-model-and-storage.md`、`docs/integration/pos-member-system-requirements.md`、`docs/integration/main-system-integration.md` 中提到 | ❌ 否 | ❌ 无 |
| `pos_member_coupons` | 早期 POS 本地 mock 会员券 | 同上 | ❌ 否 | ❌ 无 |

### 重要发现

1. **代码已全面迁移到 Ledger RPC**：
   - `/api/members` 路由已返回 `410 GONE`。
   - `src/components/members-page.tsx` 直接使用 Ledger RPC：
     - `merchant_lookup_customer_wallet`
     - `list_merchant_customers`
     - `merchant_apply_pos_txn`（充值 / 扣点）
     - `redeem_reward_grants` 相关券接口
   - 会员 PII 明确禁止写入 POS DB / localStorage（`clearLegacyMembersCache()` 会清理旧 key）。

2. **没有任何 migration 创建这 2 张表**：与 online order 4 张表一样，是历史遗留。

3. **为什么「缺少 store_id」不是问题**：
   - 这两张表本身就已经被废弃，即使加上 `store_id` 也不会再用。
   - 真正该做 store 隔离的会员数据在 **Ledger 侧**，由 `merchant_lookup_customer_wallet(p_merchant_id)` 等 RPC 控制。
   - 结论：**不需要给 pos_members / pos_member_coupons 加 store_id，直接清理/删除这两张表即可。**

---

## 4. 需要调整为 per-store 的 setting / 配置项目

> 这部分是本次审查中**最需要工程化改造**的地方。当前有多个配置在「没有 storeId 参数时」会 fallback 到「全库最新一条」，导致多店环境下 A 店可能读到 B 店配置。

### 4.1 高优先级：DB 查询 fallback 导致跨店串配置

| # | 配置项 | 当前表 | 问题描述 | 是否已有 store_id | 建议 |
|---|--------|--------|----------|-------------------|------|
| 1 | **Bootstrap（餐牌、桌台、分类、规则）** | `pos_bootstrap_config` | `GET /api/pos/bootstrap` 在不传 `storeId` 时会 `order("updated_at").limit(1)`，取**全库最新一条**，可能拿到别店配置 | ✅ 有（store_id PK） | **强制要求 storeId**，无 storeId 时返回 400 或 mock，不允许 fallback |
| 2 | **设备配置 / localSettings** | `pos_device_configs` | `GET /api/pos/device-config` 在不传 `storeId` 时同样取全库最新一条；注释里也承认这是 bug（`docs/98 问题二`） | ✅ 有（store_id 列） | **强制要求 storeId**；并建议给 `(store_id, device_id)` 加 unique constraint，避免同一设备被多个店重复写入 |
| 3 | **打印任务** | `pos_print_jobs` | `GET /api/pos/state` 在 `storeId` 为空时仍然 `select(*).limit(200)` 拉取**所有店**的 print jobs | ✅ 有（store_id 列） | storeId 为空时 `limit(0)`，与 queue 的处理方式保持一致 |

### 4.2 中优先级：localStorage 仍为全局 key

| # | 配置项 | 当前 localStorage key | 问题描述 | 建议 |
|---|--------|----------------------|----------|------|
| 4 | **Offline 模式开关** | `macau-pos/offline-mode` | 全局一个开关；切店后 offline 状态共享 | 评估是否需要 per-store。如果是「整台机器」概念，可以保持全局；如果是「某店某终端」概念，应改为 per-store |
| 5 | **人工人流记录** | `macau-pos-footfall` | 全局 key，所有店共用同一组人流数据 | 改为 `macau-pos/stores/{merchantId}/footfall` |
| 6 | **打印桥接/Companion 配对** | `macau-pos-print-relay-*`、`macau-pos-companion-*` | 当前按终端存储，无 per-store scope。如果同一终端切换门店，可能把 A 店打印任务推到 B 店已配对的打印机 | 评估是否需要把配对信息也按 store scope 存储，或至少存 `store_id` 并在切店时要求重新配对 |

### 4.3 低优先级 / 需确认

| # | 配置项 | 当前状态 | 说明 |
|---|--------|----------|------|
| 7 | `admin_stores` 里的 mock ID | 全局 | `macau-store-a` / `macau-store-b` 与真实 Ledger merchant UUID 不对应，需确认是否还需要保留这些旧 ID，或者改为同步 Ledger `merchants.id` |
| 8 | `pos_device_configs` 的 PK 设计 | `device_id` PK | 同一 `device_id` 理论上全局唯一，但如果一台设备被多家店共用（或门店切换时未重置），`store_id` 会互相覆盖。建议 `(store_id, device_id)` 唯一，或者 reset 时清理旧设备记录 |

### 4.4 已经正确 per-store 的项目（无需改动）

| 配置项 | 表 / 存储位置 | 说明 |
|--------|---------------|------|
| Bootstrap | `pos_bootstrap_config.store_id` PK | 只要 GET 时强制传 storeId 即可 |
| 线上订单自动接单 | `pos_online_order_settings.store_id` PK | 已按店隔离 |
| Kiosk 自助点餐开关 | `pos_kiosk_settings.store_id` PK | 已按店隔离 |
| 沽清 | `pos_soldout.store_id` + `menu_item_id` unique | 已按店隔离 |
| 本地订单 / queue / print jobs | localStorage `macau-pos/stores/{merchantId}/...` | 已按店隔离 |
| 每日序号 | `pos_daily_sequences (store_id, kind, biz_date)` PK | 已按店隔离 |
| 打印代理 | `pos_print_agents.store_id` | 已按店隔离 |

---

## 5. 推荐的下一步动作清单

### 5.1 废弃表清理（无业务风险）

1. 确认 `online_orders`、`online_order_items`、`online_order_settings`、`online_order_status_logs`、`pos_members`、`pos_member_coupons` 6 张表当前 row count。
2. 如果有数据，先备份。
3. 在 migration 中增加 `DROP TABLE IF EXISTS ...`（或先 truncate 观察）。

### 5.2 per-store 配置加固（需要改代码）

1. `GET /api/pos/bootstrap`：无 `storeId` 时返回 400（或只返回 mock），禁止全库 fallback。
2. `GET /api/pos/device-config`：同上；并考虑给 `pos_device_configs` 加 `(store_id, device_id)` unique constraint。
3. `GET /api/pos/state` 中的 `printJobsQuery`：无 `storeId` 时 `limit(0)`。
4. `restaurant-footfall.ts`：把 `macau-pos-footfall` 改成 per-store key。
5. 评估 `offlineMode`、`print-relay` 配对是否需要 per-store。

### 5.3 Admin 表规范化（可选）

1. 把 `docs/sql/admin-account-schema.sql` 整理成正式的 `supabase/migrations/0023_admin_account_tables.sql`（或补上 migration），避免重建环境时漏表。
2. 统一 `admin_stores.id` 与 Ledger `merchants.id` 的标识体系，避免 `macau-store-a` 这种旧 mock ID 继续存在。

---

## 6. 不涉及修改的数据查询语句（供你核对）

```sql
-- 查看 6 张废弃表的数据量
SELECT 'online_orders' AS t, COUNT(*) AS rows FROM online_orders
UNION ALL SELECT 'online_order_items', COUNT(*) FROM online_order_items
UNION ALL SELECT 'online_order_settings', COUNT(*) FROM online_order_settings
UNION ALL SELECT 'online_order_status_logs', COUNT(*) FROM online_order_status_logs
UNION ALL SELECT 'pos_members', COUNT(*) FROM pos_members
UNION ALL SELECT 'pos_member_coupons', COUNT(*) FROM pos_member_coupons;

-- 查看 per-store 配置表的分布
SELECT 'pos_bootstrap_config' AS t, store_id, COUNT(*) AS rows
  FROM pos_bootstrap_config GROUP BY store_id
UNION ALL
SELECT 'pos_online_order_settings', store_id, COUNT(*) FROM pos_online_order_settings GROUP BY store_id
UNION ALL
SELECT 'pos_kiosk_settings', store_id, COUNT(*) FROM pos_kiosk_settings GROUP BY store_id
UNION ALL
SELECT 'pos_device_configs', COALESCE(store_id,'(null)'), COUNT(*) FROM pos_device_configs GROUP BY store_id
UNION ALL
SELECT 'pos_print_jobs', COALESCE(store_id,'(null)'), COUNT(*) FROM pos_print_jobs GROUP BY store_id;

-- 查看 admin 表当前内容
SELECT 'admin_stores' AS t, id, name, active FROM admin_stores
UNION ALL
SELECT 'admin_account_users', account, name, active::text FROM admin_account_users;
```

---

## 7. 结论

| 问题 | 结论 | 下一步 |
|------|------|--------|
| admin 4 张表是否废弃 | **否**，仍在使用 | 规范化到 migration；统一 store ID 体系 |
| online order 4 张表是否废弃 | **是** | 确认数据量后备份并删除 |
| pos member 2 张表是否废弃、是否缺 store_id | **是**，已废弃；不需要补 store_id | 确认数据量后备份并删除 |
| settings 是否全店共用 | **部分共用**，存在 fallback 到全库最新一条的漏洞 | 按第 4 节清单逐项加固 |

---

*报告生成时间：2026-09-06*  
*未修改任何代码或数据库。*
