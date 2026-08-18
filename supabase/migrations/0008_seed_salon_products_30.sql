-- 0008_salon_products_seed_30.sql
-- store demo-salon-001 產品目錄補種 30 項（與 src/lib/salon/mock-data.ts DEFAULT_SALON_PRODUCTS 風格一致）
-- idempotent：重複執行唔會撞 id（on conflict do nothing）
--
-- offline / mock 模式嘅 POS 讀 salon_bootstrap_config.products（jsonb），
-- 呢度只寫入 salon_products 表（雲端同步模式用）。要本地 mock 都見到呢 30 項，
-- 請同時執行 0009_seed_store_demo-salon-001.sql（會將产品 jsonb 補入該店 bootstrap）。

insert into public.salon_products (id, store_id, name, category, price, cost, commission_rate, active, sort_order)
values
  -- ── 護膚 (skincare) ──
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
  -- ── 美甲 (nails) ──
  ('prod-011','demo-salon-001','指甲營養油','美甲',90,30,8,true,11),
  ('prod-012','demo-salon-001','快乾頂油','美甲',70,22,8,true,12),
  ('prod-013','demo-salon-001','指緣修護霜','美甲',110,35,9,true,13),
  ('prod-014','demo-salon-001','凝膠卸除包','美甲',60,18,8,true,14),
  ('prod-015','demo-salon-001','護手霜 玫瑰','美甲',95,30,9,true,15),
  -- ── 美睫 (lashes) ──
  ('prod-016','demo-salon-001','睫毛養護液','美睫',150,55,10,true,16),
  ('prod-017','demo-salon-001','睫毛增長精華','美睫',220,80,12,true,17),
  ('prod-018','demo-salon-001','眼唇卸妝液','美睫',100,32,8,true,18),
  -- ── 彩妝 (makeup) ──
  ('prod-019','demo-salon-001','持久粉底液','彩妝',380,140,10,true,19),
  ('prod-020','demo-salon-001','定妝蜜粉','彩妝',250,90,10,true,20),
  ('prod-021','demo-salon-001','絲絨唇釉','彩妝',180,60,10,true,21),
  ('prod-022','demo-salon-001','持久眉筆','彩妝',120,40,9,true,22),
  -- ── 髮品 (haircare) ──
  ('prod-023','demo-salon-001','修護洗髮露 300ml','髮品',180,60,8,true,23),
  ('prod-024','demo-salon-001','護髮精油 30ml','髮品',200,70,10,true,24),
  ('prod-025','demo-salon-001','豐盈髮霧','髮品',150,50,8,true,25),
  -- ── 身體 / 香薰 (body & aroma) ──
  ('prod-026','demo-salon-001','身體乳 薰衣草','身體護理',220,75,9,true,26),
  ('prod-027','demo-salon-001','香薰精油 10ml','香薰',280,95,11,true,27),
  ('prod-028','demo-salon-001','身體磨砂膏','身體護理',200,65,9,true,28),
  -- ── 防曬 (sunscreen) ──
  ('prod-029','demo-salon-001','清爽防曬 SPF50','防曬',260,90,10,true,29),
  ('prod-030','demo-salon-001','防曬噴霧','防曬',180,60,9,true,30)
on conflict (id) do nothing;
