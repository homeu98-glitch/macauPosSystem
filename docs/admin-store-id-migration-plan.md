# Admin 表迁至 Store ID 体系 — 可行性评估与迁移草案

> 关联：用户需求（2026-09-06）第 1 点「将 admin 相关表 migrate 至 store ID 体系，迁移完成后删除原 admin 表（请先评估方案可行性）」。
> 状态：**仅评估 + 提供草案 SQL，未执行任何破坏性变更。** `/admin` 登录入口已在本轮实现（见末节）。

---

## 0. 现状一句话

admin 4 张表 `admin_stores` / `admin_account_users` / `admin_permission_groups` / `admin_account_store_bindings` **仍被 `/backoffice` 与 `/api/admin/*` 使用**，但它们**不在 `supabase/migrations/` 里**——只存在于 `docs/sql/admin-account-schema.sql`，是早期手动建表 + 种子数据的历史遗留。其 `admin_stores.id` 用 `'macau-store-a'` / `'macau-store-b'` 这类旧 mock 文本 ID，与 POS 订单 / 同步所用的 Ledger `merchants.id`（UUID）是**两套不同标识**。

「store ID 体系」= Ledger `merchants.id`（UUID）。POS 全线（`pos_orders.store_id`、`pos_queue_events.store_id`、kiosk 绑定、报表）都已经用这个 UUID，唯独 admin 后台还停留在 mock ID。

---

## 1. 当前 admin 表结构与引用面

| 表 | 关键字段 | 当前 ID 类型 | 代码引用 |
|----|----------|--------------|----------|
| `admin_stores` | `id text PK`, `name`, `active` | `'macau-store-a'` / `'macau-store-b'` | `admin-account-server.ts:150`、`backoffice-server.ts:170,237` |
| `admin_account_users` | `id uuid PK`, `account`(8位), `pin_code`, `role`, `permission_group_id` | uuid（人员） | `admin-account-server.ts:73,149`、`/api/admin/accounts:64,130,166` |
| `admin_permission_groups` | `id uuid PK`, `code`, `role`, `permissions jsonb` | uuid（模板） | `admin-account-server.ts:88,151`、`/api/admin/accounts` |
| `admin_account_store_bindings` | `(account_id, store_id) PK`，FK → `admin_stores.id` | store_id = mock ID | `admin-account-server.ts:89,152`、`/api/admin/accounts:84,136,138,165` |

**结论**：admin 表本身承载的是「后台管理账号 + 权限 + 账号⇄门店绑定」，属于**全局后台配置**，本来就应该是跨店的。真正需要「按 store ID 对齐」的，是 `admin_stores` 那层门店标识，以及 `bindings.store_id` 指向的门店。

---

## 2. 两种迁移路径（可行性）

### 选项 A：Re-key（推荐，低风险，可增量）

给 `admin_stores` 加 `merchant_id text`（**唔建 FK**——POS 数据库冇 `merchants` 表，该表系 Ledger 另一边 DB 嘅；全 POS 表统一用 `store_id text` 存 Ledger merchant UUID），把 mock 行回填成真实 merchant UUID；`bindings` 增加 `merchant_id text` 并存（过渡期双写），令 code 直接用 merchant UUID 解析门店。**admin_* 表继续存在**，只是门店标识对齐到 merchant UUID。

- ✅ 可行性：**高**。纯增量 DDL + 一次回填，不动账号/权限逻辑。
- ✅ 风险：**低**。admin 登录/权限流程零改动（仍然查 admin_account_users）。
- ⚠️ 代价：admin 表仍在；`macau-store-a` 的 mock 残留（见 §4）要另行清理。
- 「删除原 admin 表」在此选项下 = 删除 mock 的 `macau-store-a`/`macau-store-b` 旧行，**表本身保留**（它是 admin 认证系统的载体，删了后台就瘫）。

### 选项 B：彻底替换（高风险的「真删除」）

删掉 `admin_stores`，门店列表改由 Ledger `merchants` 提供；`bindings` 直接引用 `merchants.id`；`admin_account_users` 改由 Ledger `staff_accounts` 接管；`admin_permission_groups` 映射到 `staff_accounts` 的 role 字段。

- ✅ 可行性：**技术上可行**，但属于一次后台认证体系重写。
- ❌ 风险：**高**。admin 表是**活表**，当下 `/backoffice` 与 `/api/admin/accounts` 直接读写它们；未验证新体系就 DROP = 后台立即瘫痪。
- ❌ 代价：要重写 `admin-account-server.ts`、`backoffice-server.ts`、`/api/admin/accounts`、`/api/admin/session`，并把账号+PIN 体系与 Ledger `staff_accounts` 对齐（含 PIN 哈希、权限映射、seed 数据迁移）。
- 结论：**不推荐现在做**，除非明确要废掉自建 admin 账号体系、全面改用 Ledger 员工账号。

---

## 3. 可行性结论与阻塞点

1. **「删除原 admin 表」必须等到新体系验证后才执行。** admin 表是活表，盲目 DROP 直接打挂后台。无论选 A 还是 B，删除都应是**最后一步**，且需先有可回滚备份。
2. **最大阻塞点：merchant UUID 映射缺失。** `'macau-store-a'` / `'macau-store-b'` 对应哪个 `merchants.id` UUID，repo 里没有自动化映射（它们是早期手写种子）。需要你提供映射，或我写一条 `SELECT id, name FROM merchants` 让你核对后回填。
3. **`macau-store-a` 是系统性残留。** 除了 `admin_stores`，`src/lib/pos/store-id-guard.ts`、`src/components/login-screen.tsx:90`、`src/lib/use-kiosk-order.ts:153` 都拿 `macau-store-a` 当 fallback 示范店代码（非 merchant UUID）。只改 admin 表治标不治本，建议另开一轮统一清理 `macau-store-a` 约定。
4. **admin 表不在 migration 管理。** 当前靠手动跑 `docs/sql/admin-account-schema.sql` 建表，重建环境会漏表。无论 A/B，都应补一条正式 migration（见 §5 草案 0024）把建表纳入部署。

---

## 4. 推荐分阶段执行

- **阶段 1（安全，本轮可落）**：补 0024 migration，给 `admin_stores` 加 `merchant_id`，回填已知映射，给 `merchant_id` 加 unique；`bindings` 增加 `merchant_id` 列并回填；admin 账号登录流程不变。同时把建表纳入 migration 管理。
- **阶段 2（等你确认映射 + 验证后）**：删除 `macau-store-a`/`macau-store-b` 旧 mock 行；若走选项 B，再重写后台认证并 DROP admin_* 表。

---

## 5. 草案 SQL

### 5.1 阶段 1：增量对齐（安全，可回滚）

```sql
-- 0024: admin_stores 对齐 merchant UUID（选项 A 阶段 1）
-- ⚠️ 下面系「示意草案」；实际落地版见 supabase/migrations/0024_admin_store_id_align.sql
--    （该版已移除所有 FK——POS DB 冇 merchants 表，实测 42P01；亦唔加 unique，保持简单安全）。
-- 1) admin_stores 加 merchant_id（text，存 Ledger merchant UUID，唔建 FK）
alter table admin_stores
  add column if not exists merchant_id text;

-- 2) 回填：把 mock 行指去真实 merchant UUID。
--    ⚠️ 下面两行是「示意」，merchant UUID 要由你提供 / 由 SELECT id,name FROM merchants 核对后填入。
--    update admin_stores set merchant_id = '<UUID-of-store-a>' where id = 'macau-store-a';
--    update admin_stores set merchant_id = '<UUID-of-store-b>' where id = 'macau-store-b';

-- 3) merchant_id 唯一，避免重复绑定同一商户
create unique index if not exists uq_admin_stores_merchant
  on admin_stores (merchant_id) where merchant_id is not null;

-- 4) bindings 增加 merchant_id，对齐到 merchant UUID（与 store_id 并存，过渡期双写）
alter table admin_account_store_bindings
  add column if not exists merchant_id text;

-- 5) bindings.merchant_id 由 admin_stores.merchant_id 推导（过渡期用，mapping 齐咗再跑）
--    update admin_account_store_bindings b
--      set merchant_id = s.merchant_id
--      from admin_stores s
--      where b.store_id = s.id and s.merchant_id is not null;

-- 6) （可选）之后把 bindings 的 FK 由 store_id 改指向 merchant_id，并让代码改读 merchant_id
```

### 5.2 阶段 2：删除原 admin 表（⚠️ 待你拍板选项 B + 验证后才跑）

```sql
-- ⚠️ 以下为「彻底替换（选项 B）」才需要。阶段 1 完成后请勿直接跑。
-- begin;
--   -- 先确认后台已改读 merchants + staff_accounts，且 bindings 已迁到 merchant_id
--   drop table if exists admin_account_store_bindings cascade;
--   drop table if exists admin_account_users cascade;
--   drop table if exists admin_permission_groups cascade;
--   drop table if exists admin_stores cascade;
-- rollback;  -- 确认无误再改 commit;
```

---

## 6. `/admin` 登录入口（本轮已实现）

- 重写 `src/app/admin/page.tsx`：由「redirect 去 /backoffice/stores」改为**独立 admin 登录页**（8 位账号 + 4 位 PIN）。
- 登录走既有 `POST /api/admin/session` 换 12h 短效 token，存入 auth session 后跳 `/backoffice`。
- 仅 `manageAccounts` 权限账号（admin / manager）能拿到 token（见 `/api/admin/session/route.ts:59`）。
- 链接 `https://macau-pos-system.vercel.app/admin` 现已可用作管理后台入口。

---

## 7. 下一步需你确认

1. **选 A 还是 B？** 我推荐 A（低风险、增量、不删表）。
2. **提供 `macau-store-a` / `macau-store-b` → `merchants.id` UUID 的映射**（或授权我跑 `SELECT id, name FROM merchants` 让你核对）。
3. 确认后我再跑 0024 migration（阶段 1），并把建表纳入 migration 管理。
4. 选项 B 的彻底删除**留待新体系验证后**单独执行，绝不现在跑。

*评估生成时间：2026-09-06*
