-- 0009_seed_store_demo-salon-001.sql
-- 將 30 項產品目錄補入示範店 demo-salon-001 嘅 bootstrap（products jsonb + staff_level_multipliers）。
--
-- ⚠️ store_id 說明（好重要）：
--    frontend 嘅 salon 模組 currently 寫死讀 DEFAULT_SALON_STORE_ID = 'demo-salon-001'
--    （src/lib/salon/mock-data.ts:20；workbench.tsx:52 ensureSalonBootstrap(DEFAULT_SALON_STORE_ID)）。
--    Ledger 嘅 8 位登入號碼（例：60000002）暫時只係 topUp / 會員充值用，
--    仲未接去 salon 嘅 store_id（industry-config.ts 話 Phase 2+ 先由 Ledger login session 帶入）。
--    所以而家想喺 salon app 見到產品，必須種落 'demo-salon-001'；種落 60000002 係睇唔到嘅。
--    等真 Ledger 綁定落實、salon store_id 改為對應 60000002 嗰陣，
--    只要將本檔同 0008 嘅 'demo-salon-001' 字串 replace 成新 store_id 再跑一次就得。
--
-- 內含：salon_products 表 30 項 + salon_bootstrap_config 嘅 products jsonb / staff_level_multipliers。
-- 全部 idempotent，可以重複跑：
--   - products 表：on conflict (id) do nothing
--   - bootstrap：insert ... on conflict (store_id) do update（冇該店 row 就建、有就更新）
-- 建議順序：先跑 0005 → 0006 → 0007（建表 + demo 店），再跑 0008（demo-salon-001 產品表）→ 本檔（demo-salon-001 bootstrap）。
-- 本檔亦自帶 add column if not exists 安全網，即使 0007 冇喺呢個 DB 跑過都唔會報錯。

-- 安全網：確保 salon_bootstrap_config 有 products / staff_level_multipliers 欄（0007 加嘅）
alter table public.salon_bootstrap_config
  add column if not exists products jsonb not null default '[]'::jsonb;
alter table public.salon_bootstrap_config
  add column if not exists staff_level_multipliers jsonb not null
    default '{"junior":1,"senior":1.3,"master":1.6}'::jsonb;

-- 1) 產品目錄表（雲端同步模式用）
insert into public.salon_products (id, store_id, name, category, price, cost, commission_rate, active, sort_order)
values
  ('prod-001','demo-salon-001','保濕精華 30ml','護膚',320,120,10,true,1),
  ('prod-002','demo-salon-001','抗老血清 15ml','護膚',580,220,12,true,2),
  ('prod-003','demo-salon-001','淨膚洗面乳 120ml','護膚',180,60,8,true,3),
  ('prod-004','demo-salon-001','補水面膜 5片','護膚',260,90,10,true,4),
  ('prod-005','demo-salon-001','緊緻眼霜 15ml','護膚',420,160,12,true,5),
  ('prod-006','demo-salon-001','維C美白精華 30ml','護膚',480,180,12,true,6),
  ('prod-007','demo-salon-001','控油爽膚水 200ml','護膚',150,50,8,true,7),
  ('prod-008','demo-salon-001','舒緩保濕噴霧 100ml','護膚',130,45,8,true,8),
  ('prod-009','demo-salon-001','晚間修護霜 50ml','護膚',360,130,10,true,9),
  ('prod-010','demo-salon-001','唇部護理膏','護膚',80,25,8,true,10),
  ('prod-011','demo-salon-001','指甲營養油','美甲',90,30,8,true,11),
  ('prod-012','demo-salon-001','快乾頂油','美甲',70,22,8,true,12),
  ('prod-013','demo-salon-001','指緣修護霜','美甲',110,35,9,true,13),
  ('prod-014','demo-salon-001','凝膠卸除包','美甲',60,18,8,true,14),
  ('prod-015','demo-salon-001','護手霜 玫瑰','美甲',95,30,9,true,15),
  ('prod-016','demo-salon-001','睫毛養護液','美睫',150,55,10,true,16),
  ('prod-017','demo-salon-001','睫毛增長精華','美睫',220,80,12,true,17),
  ('prod-018','demo-salon-001','眼唇卸妝液','美睫',100,32,8,true,18),
  ('prod-019','demo-salon-001','持久粉底液','彩妝',380,140,10,true,19),
  ('prod-020','demo-salon-001','定妝蜜粉','彩妝',250,90,10,true,20),
  ('prod-021','demo-salon-001','絲絨唇釉','彩妝',180,60,10,true,21),
  ('prod-022','demo-salon-001','持久眉筆','彩妝',120,40,9,true,22),
  ('prod-023','demo-salon-001','修護洗髮露 300ml','髮品',180,60,8,true,23),
  ('prod-024','demo-salon-001','護髮精油 30ml','髮品',200,70,10,true,24),
  ('prod-025','demo-salon-001','豐盈髮霧','髮品',150,50,8,true,25),
  ('prod-026','demo-salon-001','身體乳 薰衣草','身體護理',220,75,9,true,26),
  ('prod-027','demo-salon-001','香薰精油 10ml','香薰',280,95,11,true,27),
  ('prod-028','demo-salon-001','身體磨砂膏','身體護理',200,65,9,true,28),
  ('prod-029','demo-salon-001','清爽防曬 SPF50','防曬',260,90,10,true,29),
  ('prod-030','demo-salon-001','防曬噴霧','防曬',180,60,9,true,30)
on conflict (id) do nothing;

-- 2) 店家 bootstrap 配置（offline / mock 模式 POS 讀呢份 products jsonb）
--    products 用 camelCase 鍵，對齊前端 SalonProduct 型；staff_level_multipliers 為級別工錢倍率。
insert into public.salon_bootstrap_config (store_id, products, staff_level_multipliers, updated_at)
values (
  'demo-salon-001',
  '[
    {"id":"prod-001","name":"保濕精華 30ml","category":"護膚","price":320,"cost":120,"commissionRate":10,"active":true,"sortOrder":1},
    {"id":"prod-002","name":"抗老血清 15ml","category":"護膚","price":580,"cost":220,"commissionRate":12,"active":true,"sortOrder":2},
    {"id":"prod-003","name":"淨膚洗面乳 120ml","category":"護膚","price":180,"cost":60,"commissionRate":8,"active":true,"sortOrder":3},
    {"id":"prod-004","name":"補水面膜 5片","category":"護膚","price":260,"cost":90,"commissionRate":10,"active":true,"sortOrder":4},
    {"id":"prod-005","name":"緊緻眼霜 15ml","category":"護膚","price":420,"cost":160,"commissionRate":12,"active":true,"sortOrder":5},
    {"id":"prod-006","name":"維C美白精華 30ml","category":"護膚","price":480,"cost":180,"commissionRate":12,"active":true,"sortOrder":6},
    {"id":"prod-007","name":"控油爽膚水 200ml","category":"護膚","price":150,"cost":50,"commissionRate":8,"active":true,"sortOrder":7},
    {"id":"prod-008","name":"舒緩保濕噴霧 100ml","category":"護膚","price":130,"cost":45,"commissionRate":8,"active":true,"sortOrder":8},
    {"id":"prod-009","name":"晚間修護霜 50ml","category":"護膚","price":360,"cost":130,"commissionRate":10,"active":true,"sortOrder":9},
    {"id":"prod-010","name":"唇部護理膏","category":"護膚","price":80,"cost":25,"commissionRate":8,"active":true,"sortOrder":10},
    {"id":"prod-011","name":"指甲營養油","category":"美甲","price":90,"cost":30,"commissionRate":8,"active":true,"sortOrder":11},
    {"id":"prod-012","name":"快乾頂油","category":"美甲","price":70,"cost":22,"commissionRate":8,"active":true,"sortOrder":12},
    {"id":"prod-013","name":"指緣修護霜","category":"美甲","price":110,"cost":35,"commissionRate":9,"active":true,"sortOrder":13},
    {"id":"prod-014","name":"凝膠卸除包","category":"美甲","price":60,"cost":18,"commissionRate":8,"active":true,"sortOrder":14},
    {"id":"prod-015","name":"護手霜 玫瑰","category":"美甲","price":95,"cost":30,"commissionRate":9,"active":true,"sortOrder":15},
    {"id":"prod-016","name":"睫毛養護液","category":"美睫","price":150,"cost":55,"commissionRate":10,"active":true,"sortOrder":16},
    {"id":"prod-017","name":"睫毛增長精華","category":"美睫","price":220,"cost":80,"commissionRate":12,"active":true,"sortOrder":17},
    {"id":"prod-018","name":"眼唇卸妝液","category":"美睫","price":100,"cost":32,"commissionRate":8,"active":true,"sortOrder":18},
    {"id":"prod-019","name":"持久粉底液","category":"彩妝","price":380,"cost":140,"commissionRate":10,"active":true,"sortOrder":19},
    {"id":"prod-020","name":"定妝蜜粉","category":"彩妝","price":250,"cost":90,"commissionRate":10,"active":true,"sortOrder":20},
    {"id":"prod-021","name":"絲絨唇釉","category":"彩妝","price":180,"cost":60,"commissionRate":10,"active":true,"sortOrder":21},
    {"id":"prod-022","name":"持久眉筆","category":"彩妝","price":120,"cost":40,"commissionRate":9,"active":true,"sortOrder":22},
    {"id":"prod-023","name":"修護洗髮露 300ml","category":"髮品","price":180,"cost":60,"commissionRate":8,"active":true,"sortOrder":23},
    {"id":"prod-024","name":"護髮精油 30ml","category":"髮品","price":200,"cost":70,"commissionRate":10,"active":true,"sortOrder":24},
    {"id":"prod-025","name":"豐盈髮霧","category":"髮品","price":150,"cost":50,"commissionRate":8,"active":true,"sortOrder":25},
    {"id":"prod-026","name":"身體乳 薰衣草","category":"身體護理","price":220,"cost":75,"commissionRate":9,"active":true,"sortOrder":26},
    {"id":"prod-027","name":"香薰精油 10ml","category":"香薰","price":280,"cost":95,"commissionRate":11,"active":true,"sortOrder":27},
    {"id":"prod-028","name":"身體磨砂膏","category":"身體護理","price":200,"cost":65,"commissionRate":9,"active":true,"sortOrder":28},
    {"id":"prod-029","name":"清爽防曬 SPF50","category":"防曬","price":260,"cost":90,"commissionRate":10,"active":true,"sortOrder":29},
    {"id":"prod-030","name":"防曬噴霧","category":"防曬","price":180,"cost":60,"commissionRate":9,"active":true,"sortOrder":30}
  ]'::jsonb,
  '{"junior":1,"senior":1.3,"master":1.6}'::jsonb,
  now()
)
on conflict (store_id) do update
  set products = excluded.products,
      staff_level_multipliers = excluded.staff_level_multipliers,
      updated_at = now();
