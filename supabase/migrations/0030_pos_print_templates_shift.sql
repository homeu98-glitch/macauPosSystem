-- 0030 · pos_print_templates 加「交班模板」兩個欄（shift / shift_presets）
-- 對應 2026-09-10 新增嘅「交班模板」功能：商家可以自訂交班結算單嘅排版，
-- 並建立多套具名範本（例如「日結單」「現金班」）隨時套用。
--
-- 背景：交班單以前係 `shift-page.tsx` 硬編成一串文字塞入 PrintJob.items
-- （每行 quantity: 1），job 冇 template 快照 → 打印通道退回硬編廚房渲染器 →
-- 出紙變「【廚房單】」標題 + 每行尾多個 x1（見 docs/103 同交班單根因分析）。
-- 而家交班單同收據一樣走模板管線，所以模板要跟其他四個槽位一齊存 DB。
--
-- 兩個欄嘅分工：
--   shift          = 生效中嘅交班模板（工作中模板）。出紙一律讀呢個。
--   shift_presets  = 範本庫 + 上次套用嘅 id：{ "presets": [...], "activeId": "..." }
--                    「套用」= 把範本拷貝落 shift；所以兩者係「來源」同「現行」嘅關係，
--                    唔係同一份物件（商家微調唔應該污染範本本身）。
--
-- 向後兼容：兩個欄都係 nullable + default '{}'，舊 row 唔使 backfill ——
-- server route 會用 `normalizePrintTemplateSet()` / `normalizeShiftTemplatePresets()`
-- 補返出廠預設，client 收到嘅永遠係完整結構。
-- ============================================================================

alter table pos_print_templates
  add column if not exists shift         jsonb not null default '{}'::jsonb,
  add column if not exists shift_presets jsonb not null default '{}'::jsonb;

comment on column pos_print_templates.shift is
  '生效中嘅交班結算單模板（ShiftTemplate：blocks/order/headerText/footerText/sectionTitles）';
comment on column pos_print_templates.shift_presets is
  '交班模板範本庫 { presets: ShiftTemplateVariant[], activeId: string }（2026-09-10）';

-- ============================================================================
-- 權限：0027 已 revoke anon/authenticated + grant service_role。
-- ALTER TABLE 加欄唔會繼承 column-level grant，但呢張表係 table-level grant，
-- 所以新欄自動跟表嘅權限，唔使再落一次。以下保留 idempotent 版本以防有人重跑。
-- ============================================================================
revoke all on table public.pos_print_templates from anon, authenticated;
grant all on table public.pos_print_templates to service_role;

-- ============================================================================
-- 驗收
-- ============================================================================
-- select column_name, data_type, column_default
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'pos_print_templates'
--  order by ordinal_position;
--
-- -- 舊 row 唔會有 null（兩個欄都 not null default '{}'）
-- select store_id, shift = '{}'::jsonb as shift_empty, shift_presets = '{}'::jsonb as presets_empty
--   from pos_print_templates;
