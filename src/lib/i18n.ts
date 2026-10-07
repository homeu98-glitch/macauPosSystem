/**
 * UI 語言（顯示層）—— 單一真源。
 *
 * ## 點解要有呢個檔
 *
 * 系統原本零 i18n 基建（`package.json` 冇 `next-intl` / `i18next`），
 * 所有繁中 UI 文案硬編喺 JSX。呢個檔提供最細嘅抽取層。
 *
 * ## ⚠️ 三層分離 —— 呢個檔只管第1 層
 *
 * 全repo 嘅中文要分三層，**只有第 1 層翻譯**：
 *
 * 1. **UI 顯示文案**（按鈕 / 標題 / 提示 / toast）→✅ 翻譯，經 `t()`
 * 2. **持久化資料值**（`tableName` / `zoneId` / 打印機 `brand`）→ ❌ **絕對唔翻譯**
 * 3. **實體紙單**（收據 / 廚房單 / 交班單 / 標籤）→ ❌ 唔跟 UI 語言
 *
 * ### 點解第 2 層唔可以翻譯（J 2026-10-07拍板）
 *
 * 以下中文係**業務資料**，唔係文案，翻譯 = 靜靜壞功能（唔會 throw、唔會報錯）：
 *
 * - `src/lib/pos/quick-labels.ts:25-26,34-35` —— `tableName === "自取" / "外賣"`
 *   ⇒ 翻譯後全部落入 `default` 分支，外賣單狀態永遠顯示「待出餐」
 * - `src/lib/retail/returns.ts:36` —— `tableName === "零售"`
 *   ⇒ 零售退貨頁**完全載唔到單據**（靜默空白）
 * - `src/lib/print-bridge/printer-models.ts:1057-1058` —— `includes("斑馬") / includes("立象")`
 *   ⇒ 打印語言判斷錯
 *
 * `src/lib/pos/quick-labels.test.ts` 等守衛測試會釘死呢幾處。
 *
 * ### 點解第 3 層唔跟 UI 語言（J 2026-10-07拍板）
 *
 * 紙單係畀客人睇嘅收款憑證。店員喺自己部機切英文，唔應該令客人張單變英文。
 * 而且 `escpos-render.ts:208` 明文講「設計介面 ≡ 螢幕預覽 ≡ 實際打印 100% 一致」
 * 係 repo 核心契約 —— 一旦 UI 預覽同出紙路徑唔同步，就會違反呢個契約。
 *
 * ## ⚠️ 呢個檔零 import（刻意）
 *
 * `npm test` = `node --test`，唔認 `@/` alias。所以任何要被測試覆蓋嘅
 * 純邏輯，必須零 import（跟 `inventory-order.ts` / `quick-labels.ts` 同一做法）。
 * 字典（`./i18n-dict`）會引入 import，所以**唔喺呢個檔**——
 * 核心比對邏輯喺呢度，字典掛喺 provider（`@/components/lang-provider.tsx`）。
 */

/** 支援嘅 UI 語言。`zh-Hant` 係預設（繁體中文）。 */
export type UiLang = "zh-Hant" | "en";

export const DEFAULT_UI_LANG: UiLang = "zh-Hant";

export const UI_LANGS: readonly UiLang[] = ["zh-Hant", "en"];

/** 合法值檢查（讀本機儲存時用；唔信任任何外部輸入）。 */
export function isUiLang(value: unknown): value is UiLang {
  return value === "zh-Hant" || value === "en";
}

/** `<html lang>` 要用嘅 BCP-47 值（`layout.tsx` 硬編 `zh-Hant`，切英文時要同步）。 */
export function htmlLangOf(lang: UiLang): string {
  return lang;
}

/**
 * 語言顯示名 —— **故意用該語言自身嘅文字**（唔用 `t()`）。
 *
 * 語言選擇器嘅標準做法：`繁體中文` / `English`，
 * 一個用本族文字、一個用英文，令客人唔使猜。
 */
export const LANG_DISPLAY_NAME: Record<UiLang, string> = {
  "zh-Hant": "繁體中文",
  en: "English",
};

/**
 * 由任意字串安全收斂成 `UiLang`（唔會 throw）。
 *
 * 接受 `en-US` / `en_US` / `EN` 等變體 → 一律收斂到 `en`；
 * 其餘（`zh-Hant`、`zh-HK`、`zh-TW`、垃圾值）→ 回落 `zh-Hant`。
 */
export function normalizeUiLang(value: unknown): UiLang {
  if (isUiLang(value)) return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    // 只認「開頭就係 en」⇒ 涵蓋en / en-US / en_US / EN。
    // ⚠️ 唔可以用 `startsWith("zh")` 去認 zh-Hant —— 預設就係 zh-Hant，
    // 其他中文變體（zh-HK / zh-TW）口徑上就係同一種字，唔使區分。
    if (lower === "en" || lower.startsWith("en-") || lower.startsWith("en_")) return "en";
  }
  return DEFAULT_UI_LANG;
}

/**
 * 變數替換：`{n}` → `String(vars.n)`。
 *
 * 純函式、零import，所以可以被 `node --test` 直接測。
 * ⚠️ 未提供嘅 `{x}` **原樣保留**（唔會變 `undefined`）——
 * 寧願 UI 見到 `{count}` 都好過見到 `undefined`。
 */
export function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  if (!template.includes("{")) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

/**
 * 字典查詢：漏翻譯時 **fallback 返原文（中文）**，唔會出 `undefined`。
 *
 * 呢個係成個設計最重要嘅一點 —— 5,200 行 UI 文案唔可能一次過翻齊，
 * 漏咗嘅必須優雅降級（顯示中文），而唔係 `undefined` / 空白 / crash。
 *
 * @param dict 已解析嘅字典（`Record<string, string>`）
 * @param zh   中文原文（同時係 key，亦係 fallback 值）
 */
export function lookup(
  dict: Record<string, string> | undefined,
  zh: string,
  vars?: Record<string, string | number>,
): string {
  const hit = dict?.[zh];
  // 空字串係故意嘅翻譯（例如想顯示空白），唔可以當漏翻譯
  if (hit === undefined) return interpolate(zh, vars);
  return interpolate(hit, vars);
}

/**
 * 檢查字典有冇漏翻譯（俾維護用，唔喺 runtime 跑）。
 *
 * 用 `node --test` 做守衛測試：列出 `zh` 有但 `en` 缺嘅 key。
 */
export function missingTranslations(
  zh: Record<string, string>,
  en: Record<string, string>,
): string[] {
  return Object.keys(zh).filter((k) => !(k in en));
}