/**
 * 紙張尺寸 → 每行字數（**純模組，可 `node --experimental-strip-types` 直接載入**）。
 *
 * 【為何要另開呢個檔】
 * 呢段邏輯原本散落喺 `escpos-render.ts`（收據常數）同 `escpos-template.ts`
 * （`paperColumnsFromSize`），但兩邊都 import 咗 `@/lib/...` runtime 依賴
 * → 測試載入唔到 → **冇任何自動化測試守住**。結果就出咗呢個 bug：
 *
 * 🔴 2026-09-13 修：`paperColumnsFromSize("60x40mm")` 一直回 **48**（= 80mm 票據機
 * 欄數），而 60mm 標籤紙實際係 **34 字**。因為舊實作只做
 * `paperSize.includes("58") ? 32 : 48`，完全唔識 WxH 格式嘅標籤紙尺寸。
 *
 * 為害：`print-jobs.ts` 嘅標籤 job 靠
 * `Math.min(模板欄數, paperColumnsFromSize(printer.paperSize))` 截頂，
 * 打印機側永遠回 48 → **min() 形同虛設** → 標籤機紙寬設定完全失效。
 * 例：模板 100×75（61 字）＋ 60mm 標籤機 → min(61, 48) = 48 字印落 34 字嘅紙
 * → 嚴重溢出、亂版。
 *
 * 第二個相關嘅坑：**同一尺寸有兩種 id 寫法** ——
 *   - `types.ts` `LABEL_PAPER_PRESETS` = `"60x40"`（設計頁 / 模板用）
 *   - `print-bridge/printer-models.ts` = `"60x40mm"`（打印機型號表用，帶 mm）
 * 兩者字串唔相等 → `labelPaperPreset("60x40mm")` 搵唔到 → 靜靜跌去 62mm 預設
 * → 欄數由 34 變 36（多 2 字，超出紙寬）。`labelPaperPresetId()` 就係為咗歸一化。
 *
 * ⚠️ 呢個檔**只可以** import `./types.ts`（佢只有 `import type`，會被 type-strip
 * 抹掉，所以 Node 載得到）。**唔可以** import `@/lib/escpos-render`
 * （嗰邊有 rxjs 等 runtime 依賴 → 測試即刻載入唔到，呢個檔就白做）。
 */
import { DEFAULT_LABEL_PAPER_ID, LABEL_PAPER_PRESETS, type LabelPaperPreset } from "./types.ts";

// ─────────────────────────────────────────────────────────────
// 收據機（連續紙）欄數常數
// ─────────────────────────────────────────────────────────────

/**
 * 80mm 熱敏連續紙，font A（s 檔）每行字數。
 *
 * 同 `print hub` `EscPosRenderer.kt`、`desktop-companion` 同一個數
 * （203dpi、紙闊 80mm − 導軌 → 48 字）。**改呢個值要三端同步**。
 */
export const RECEIPT_PAPER_COLUMNS = 48;

/** 58mm 熱敏連續紙，font A 每行字數。 */
export const RECEIPT_PAPER_COLUMNS_58MM = 32;

// ─────────────────────────────────────────────────────────────
// 標籤紙尺寸 id 歸一化
// ─────────────────────────────────────────────────────────────

/**
 * 標籤紙尺寸 id 歸一化：`"60x40mm"` → `"60x40"`。
 *
 * ⚠️ `"62mm"` / `"58mm"` / `"80mm"` **唔可以**剝 `mm` —— 佢哋唔係 WxH 格式
 * （`"62mm"` 係標籤紙舊預設，`"58mm"`/`"80mm"` 係收據機連續紙）。
 * 所以只有 `/^\d+x\d+mm$/` 先剝。
 */
export function labelPaperPresetId(raw: string | undefined | null): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  return /^\d+x\d+mm$/i.test(v) ? v.slice(0, -2) : v;
}

/**
 * 係唔係**標籤紙**尺寸（`"60x40"` / `"60x40mm"` / `"62mm"`）。
 *
 * ⚠️ 收據機嘅 `"58mm"` / `"80mm"` **唔算**。呢個判斷一定要**行先**，
 * 因為 `"58x40"`（標籤，32 字）同 `"58mm"`（收據，32 字）都含 "58" 但係唔同嘢。
 */
export function isLabelPaperSize(v: string | undefined | null): boolean {
  const s = (v ?? "").trim();
  if (!s) return false;
  if (/^\d+x\d+(mm)?$/i.test(s)) return true; // 40x30 / 60x40mm
  return s === "62mm"; // 舊標籤預設（唯一唔係 WxH 格式嘅標籤尺寸）
}

/**
 * 由標籤紙尺寸 id 搵 preset。**容忍兩種寫法**，搵唔到回 `undefined`
 * （唔會偷偷 fallback —— 咁樣呼叫端可以自己決定 fallback 策略）。
 */
export function findLabelPaperPreset(
  id: string | undefined | null,
): LabelPaperPreset | undefined {
  const normalized = labelPaperPresetId(id);
  if (!normalized) return undefined;
  return LABEL_PAPER_PRESETS.find((p) => p.id === normalized);
}

/**
 * 由標籤紙尺寸 id 推**每行字數**。
 *
 * 未知 / 缺省 → 回 62mm（`DEFAULT_LABEL_PAPER_ID`）嘅欄數，
 * 保證舊 localStorage 設定唔會因為多咗呢欄而變形
 * （同 `escpos-template.labelPaperPreset()` 同一口徑）。
 */
export function labelPaperColumns(id: string | undefined | null): number {
  return (
    findLabelPaperPreset(id) ??
    findLabelPaperPreset(DEFAULT_LABEL_PAPER_ID) ??
    LABEL_PAPER_PRESETS[0]!
  ).columns;
}

/** 標籤紙闊度（mm）。未知 → `undefined`（唔可以扮 0） */
export function labelPaperWidthMmOf(id: string | undefined | null): number | undefined {
  return findLabelPaperPreset(id)?.widthMm;
}

// ─────────────────────────────────────────────────────────────
// 統一入口
// ─────────────────────────────────────────────────────────────

/**
 * 由打印機 `paperSize` 字串推每行字符數 —— **收據 / 廚房 / 交班 / 標籤共用**。
 *
 * 兩條分支：
 *   - **標籤紙**（`"60x40mm"` / `"60x40"` / `"62mm"`）→ `labelPaperColumns()`
 *   - **票據機**（`"58mm"` → 32，其餘 → 48）→ 同 `print hub` `EscPosRenderer.kt`
 *     既有嘅 `paperColumns()` 同一套規則（2026-09-10）
 *
 * 🔴 2026-09-13 修：舊實作只做 `contains("58")`，對所有標籤紙尺寸回 48。
 * 詳見檔頭註釋。
 */
export function paperColumnsFromSize(paperSize: string | undefined | null): number {
  const v = (paperSize ?? "").trim();
  // ⚠️ 標籤判斷一定要行先（見 `isLabelPaperSize` 註釋）。
  if (isLabelPaperSize(v)) return labelPaperColumns(v);
  return v.includes("58") ? RECEIPT_PAPER_COLUMNS_58MM : RECEIPT_PAPER_COLUMNS;
}
