/**
 * CSV 匯出工具（2026-09-13 新增）。
 *
 * ## 為什麼要抽出來
 *
 * 專案原本有 **4 套各寫一次**嘅 CSV 匯出（`restaurant-daily-report.exportCsv`、
 * `shift-page`、`pos-app` 退款 ×2），每套各自處理 BOM、引號逃逸、檔名清洗。
 * 訂單頁今次加匯出時抽成共用，同時統一咗幾個一直唔一致嘅細節。
 *
 * ## 關鍵細節（唔可以省）
 *
 * 1. **BOM（`\uFEFF`）**：Excel 開 UTF-8 CSV 冇 BOM 會亂碼（中文全變問號）。
 * 2. **引號逃逸**：值內嘅 `"` 要變 `""`，否則整行欄位位移。
 * 3. **公式注入防護**（2026-09-13 加）：值以 `= + - @` 開頭時前面補 `'`。
 *    客人名／備註係用戶可控輸入，貼入 Excel 會被當公式執行（CSV injection）。
 * 4. **檔名清洗**：`/ \ : * ? " < > |` 喺 Windows 係非法字元。
 */

/** 將一個值轉成安全嘅 CSV cell（含公式注入防護）。 */
export function csvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  // 公式注入防護：Excel / Sheets 會把 = + - @ 開頭嘅內容當公式
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * 由列資料砌 CSV 字串（第一行係表頭）。
 *
 * @param rows 每行一個物件；key 順序 ＝ 欄位順序（由第一個物件決定）。
 * @param columns 可選：明確指定欄位（key → 表頭名）。唔傳就用第一行嘅 key。
 */
export function buildCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns?: Array<{ key: keyof T & string; label: string }>,
): string {
  const cols: Array<{ key: string; label: string }> = columns
    ? columns.map((c) => ({ key: c.key, label: c.label }))
    : Object.keys(rows[0] ?? { 空: "" }).map((k) => ({ key: k, label: k }));

  const header = cols.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((row) => cols.map((c) => csvCell(row[c.key])).join(","));
  return [header, ...body].join("\r\n");
}

/** 清洗檔名（Windows 非法字元 + 空白）。 */
export function sanitizeFileLabel(label: string): string {
  return label.replace(/[\\/:*?"<>|\r\n]+/g, "-").replace(/\s+/g, "_").slice(0, 60) || "export";
}

/**
 * 觸發瀏覽器下載一個 CSV。
 *
 * @param rows 資料列
 * @param baseName 檔名主體（**唔使**帶 `.csv`，亦唔使帶日期）；會被清洗
 * @param options.bom 是否加 BOM（預設 true —— Excel 中文必需）
 * @param options.columns 欄位定義
 */
export function downloadCsv<T extends Record<string, unknown>>(
  rows: T[],
  baseName: string,
  options: { bom?: boolean; columns?: Array<{ key: keyof T & string; label: string }> } = {},
): void {
  const { bom = true, columns } = options;
  const csv = buildCsv(rows, columns);
  const blob = new Blob([bom ? "\uFEFF" + csv : csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${sanitizeFileLabel(baseName)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
