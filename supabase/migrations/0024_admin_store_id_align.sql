-- 0024: admin 表对齐 store ID 体系（选项 A，阶段 1：增量迁移，唔删原表）
-- ---------------------------------------------------------------------------
-- 背景：
--   admin_stores.id 系旧 mock 文本（'macau-store-a' / 'macau-store-b'），
--   同全线 POS / Ledger 使用嘅 store 識別（Ledger merchant UUID）唔夹。
--   交叉串店 bug 嘅根源之一就系呢类「两套 ID」对唔齐。
--
-- 重要事实（实测）：
--   呢个 POS 数据库「冇 merchants 表」——`merchants` 系 Ledger 另一边 DB 嘅表，
--   code 入面 from("merchants") 系经 Ledger 独立 client 连嘅（见 expense-inventory.ts /
--   topup/*）。所以本 POS DB 入面唔可以 build FK 去 merchants.id。
--   全 POS 表嘅 store 識別统一用 store_id text 存 Ledger merchant UUID（见 0011/0012/
--   0022 migration）。故 admin_stores.merchant_id 同样用 text，唔建 FK。
--
-- 本 migration 目的：
--   1. 畀 admin_stores 加 merchant_id (text) 锚点，存对应 Ledger merchant UUID；
--      （保留 admin_stores.id 不变，后台继续正常运作，零停机）
--   2. 畀 admin_account_store_bindings 加 merchant_id (text)，
--      令 code 可以直接用「merchant UUID」解析「边个 admin 管边间店」，
--      唔使再经 macau-store-a 呢类旧文本 ID 转桥。
--   3. 自动回填 bindings.merchant_id（stores.merchant_id 填咗之后）。
--
-- 唔做嘅嘢（见 docs/admin-store-id-migration-plan.md）：
--   - 唔删 admin_* 原表（活表，删咗后台即瘫）
--   - 唔改 admin_stores.id 类型
--   - 唔建 FK 去 merchants（跨库唔存在，实测 42P01）
--   - stores.merchant_id 嘅实际 UUID 映射由用户按下面「手动回填」段执行
--
-- 安全：本文件可直接 supabase db push 跑，store mapping 留空时只系加栏位 + 索引，
--       唔会产生任何破坏性改动。无 begin/commit（supabase runner 已整文件包 transaction）。
-- ---------------------------------------------------------------------------

-- ⚠️ 跑之前先攞 merchants 列表（喺 Ledger DB / 后台攞，结果贴返畀我 confirm 映射）：
--   对应该 POS DB 嘅 merchant UUID（即 login 后 authSession.merchantId 见到嘅值）。

-- 1) admin_stores 加 merchant_id 锚点（text，与全 POS store_id 一致，唔建 FK）
alter table admin_stores
  add column if not exists merchant_id text;

create index if not exists idx_admin_stores_merchant_id
  on admin_stores (merchant_id);

-- 2) bindings 直接带 merchant_id（text，唔建 FK）
alter table admin_account_store_bindings
  add column if not exists merchant_id text;

-- 3) 自动回填 bindings.merchant_id = 对应 admin_stores.merchant_id
--    （stores.merchant_id 未填时呢句系 no-op，安全）
update admin_account_store_bindings b
set merchant_id = s.merchant_id
from admin_stores s
where b.store_id = s.id
  and s.merchant_id is not null
  and b.merchant_id is distinct from s.merchant_id;

-- 4) 手动回填 stores.merchant_id（用户按 Ledger merchant UUID 结果填，取消注释后跑）：
-- update admin_stores
--   set merchant_id = '<macau-store-a 对应嘅 Ledger merchant UUID>'
--   where id = 'macau-store-a';
-- update admin_stores
--   set merchant_id = '<macau-store-b 对应嘅 Ledger merchant UUID>'
--   where id = 'macau-store-b';
-- -- 填完再跑一次第 3) 步嘅 bindings 回填（或下次 deploy 自动跑）：
-- update admin_account_store_bindings b
--   set merchant_id = s.merchant_id
--   from admin_stores s
--   where b.store_id = s.id and s.merchant_id is not null
--     and b.merchant_id is distinct from s.merchant_id;

-- ===========================================================================
-- 阶段 2（gated，验证通过先执行）：删除原 admin_* 表（选项 B 路径）
-- ---------------------------------------------------------------------------
-- 前提：code 已全面改用 merchant UUID / admin_stores.merchant_id 解析店舖，
--       且 /backoffice 同 /api/admin/* 已迁移到新体系。未满足前绝对唔好跑！
-- 草案（放喺 docs/admin-store-id-migration-plan.md，唔喺本 migration）：
--   drop table if exists admin_account_store_bindings cascade;
--   drop table if exists admin_account_users cascade;
--   drop table if exists admin_permission_groups cascade;
--   drop table if exists admin_stores cascade;
-- ===========================================================================
