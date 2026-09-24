-- ============================================================================
-- 2026-09-24 補建事故 —— 數據修復（只修「日期歸屬」）
-- ============================================================================
--
-- 【背景】
-- 「補建入 POS」功能（2026-09-24 新增）誤將**昨日（09-23）已經存在**嘅線上單
-- （取餐碼 002 / 003）當成「漏帳單」補建 ⇒ `upsert` 覆蓋原有 POS 單。
-- 而 `/api/pos/sync` 嘅 `updated_at` 係 **server 蓋章**（Vercel 時鐘，見 route.ts:342-349）
-- ⇒ 兩張單嘅 `updated_at` 被推成 **09-24**：
--      · 09-23 報表少 2 張
--      · 09-24 報表多 2 張（28 張／1,778 → 37 張／2,423）
--      · 同日出現兩個相同取餐碼（取餐碼每日重用）⇒ 睇落好似「重複」
--
-- 【本腳本做乜】
--   只把兩張單嘅 `updated_at` 還原返 **09-23**（＝原本嘅澳門時間），令日界歸屬回復正確。
--
-- 【本腳本唔做乜（重要）】
--   ❌ 唔改 `items` / `total`。
--      補建用 Ledger 明細重建，**冇店內加菜** ⇒ 取餐碼 002 由 MOP 69 變 59（差 10）。
--      原始 items 冇備份（本機 localStorage 已被覆蓋、`pos_print_jobs` 已過 anon 24h 窗口），
--      要靠收據／廚房單／Ledger 明細人手核對後另行處理。
--
-- 【安全】
--   ① 執行前先跑 §1 睇清楚係唔係呢兩行；
--   ② 用 `begin;` … 確認無誤先 `commit;`
--
-- 執行位置：Supabase Dashboard → SQL Editor（需要寫入權限）
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- §1 先睇現況（應該見到 updated_at 係 09-24 13:24Z 左右、created_at 係 09-23）
-- ─────────────────────────────────────────────────────────────────────────────
select id,
       local_order_no,
       status,
       total,
       table_name,
       created_at,
       updated_at,
       client_updated_at,
       online_order_id
  from public.pos_orders
 where id in (
   'ledger-0f2c52b2-8edd-44cd-a0fd-a2750a983b1e',   -- 取餐碼 002（09-23, 原 MOP 69）
   'ledger-79f94f1f-b2bb-48bf-8389-b71686c30f8d'    -- 取餐碼 003（09-23, MOP 129）
 )
 order by id;


-- ─────────────────────────────────────────────────────────────────────────────
-- §2 還原 `updated_at` 到 09-23（澳門時間 12:57:19 / 18:48:42 ⇒ UTC 04:57:19 / 10:48:42）
--
-- 🔴🔴 呢兩行包在 `begin;` … `commit;` 之間 —— **跑完 §2 一定要跑 §3 再跑 `commit;`**。
--      只跑 §2 而唔 commit，其他連線（POS 機、Vercel）見到嘅仍然係舊值（09-24）。
-- ─────────────────────────────────────────────────────────────────────────────
begin;

update public.pos_orders
   set updated_at = '2026-09-23T04:57:19.000Z'
 where id = 'ledger-0f2c52b2-8edd-44cd-a0fd-a2750a983b1e'
   and updated_at > '2026-09-24T00:00:00Z';   -- 安全閘：只喺「確實被推遲」時才改

update public.pos_orders
   set updated_at = '2026-09-23T10:48:42.000Z'
 where id = 'ledger-79f94f1f-b2bb-48bf-8389-b71686c30f8d'
   and updated_at > '2026-09-24T00:00:00Z';

-- §3 核對：兩行嘅 updated_at 應該變返 09-23
select id, local_order_no, total, created_at, updated_at
  from public.pos_orders
 where id in (
   'ledger-0f2c52b2-8edd-44cd-a0fd-a2750a983b1e',
   'ledger-79f94f1f-b2bb-48bf-8389-b71686c30f8d'
 )
 order by id;

-- 確認無誤才執行：
-- commit;
-- 有問題就：
-- rollback;


-- ─────────────────────────────────────────────────────────────────────────────
-- §4 附：確認冇其他單被同一 bug 影響（應該只回呢兩行）
--     判準＝「created_at 喺 09-23 或更早，但 updated_at 係 09-24T13:2x」
-- ─────────────────────────────────────────────────────────────────────────────
select id, local_order_no, created_at, updated_at, total
  from public.pos_orders
 where created_at < '2026-09-23T16:00:00Z'
   and updated_at >= '2026-09-24T13:20:00Z'
   and updated_at <  '2026-09-24T13:30:00Z'
 order by created_at;
