import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { EN_DICT, missingEnKeys, orphanEnKeys, SHORT_EN_DICT } from "./i18n-dict-en.ts";
import { SHORT_ZH_DICT, ZH_HANT_DICT } from "./i18n-dict-zh.ts";
import {
  DEFAULT_UI_LANG,
  interpolate,
  isUiLang,
  lookup,
  missingTranslations,
  normalizeUiLang,
  UI_LANGS,
} from "./i18n.ts";

/**
 * i18n 三層分離守衛（2026-10-07）。
 *
 * 呢個檔釘死 UI 語言化嘅**邊界**。最重要嘅一條：
 * 全 repo 嘅中文分三層，**只有第 1 層（顯示文案）可以翻譯**。
 * 第 2 層（持久化資料值）翻譯 = 靜靜壞功能，唔會 throw。
 *
 * 寫法參考 `inventory-contract-guard.test.ts`（源碼掃描）——
 * `node --test` 唔認 `@/` alias、唔支援 `.tsx`，所以讀原始碼做字串斷言。
 */

const SRC = new URL("../../", import.meta.url);

function readSrc(rel: string): string {
  return readFileSync(new URL(rel, SRC), "utf8");
}

/** 遞歸列出 `src/` 底下所有 `.ts` / `.tsx`（絕對路徑）。 */
function walkSrc(rel: string): string[] {
  const dir = new URL(rel, SRC); // SRC 尾部有 `/`，`rel` 為相對路徑（如 "src/" / "src/app/"）
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walkSrc(rel + e.name + "/"));
    // ⚠️ 唔可以用 `new URL(...).pathname` —— Windows 會變成 `/C:/…`，
    // 拼埋 `readFileSync` 就變 `C:\C:\…`（2026-10-07 實測）。
    else if (/\.tsx?$/.test(e.name)) out.push(fileURLToPath(new URL(e.name, dir)));
  }
  return out;
}

/**
 * 剝走 JSX／JS 註解再掃描。
 *
 * 🔴 唔可以靠 `indexOf("if (x) return null;")` 判斷 hook 順序 ——
 * 呢啲 guard 檔本身**寫滿咗解釋呢個陷阱嘅註解**，一旦註解入面出現同一段
 * 字串，`indexOf` 就會命中註解，測試會報一個**完全唔存在嘅假 failure**
 * （2026-10-07 實測：workbench-picker 同 layout 各中一次）。
 *
 * 粗暴但可靠：把內容換成等長空白，字元位置不變 ⇒ `indexOf` 語意正確。
 */
function stripComments(code: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return code
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + " ".repeat(200));
}

// ─── 第 0 層：純邏輯 ───────────────────────────────────────────

test("normalizeUiLang：兩個正式值 + en 變體 + 中文變體 + 垃圾值", () => {
  assert.equal(normalizeUiLang("zh-Hant"), "zh-Hant");
  assert.equal(normalizeUiLang("en"), "en");

  // en 變體一律收斂到 en
  assert.equal(normalizeUiLang("en-US"), "en");
  assert.equal(normalizeUiLang("en_GB"), "en");
  assert.equal(normalizeUiLang("  EN  "), "en");

  // 其他中文變體 → zh-Hant（同一種字，唔使區分）
  assert.equal(normalizeUiLang("zh-HK"), "zh-Hant");
  assert.equal(normalizeUiLang("zh-TW"), "zh-Hant");
  assert.equal(normalizeUiLang("zh"), "zh-Hant");

  // 垃圾值永不 throw
  for (const bad of [null, undefined, "", "xx", 42, {}, [], true]) {
    assert.equal(normalizeUiLang(bad), "zh-Hant");
  }

  // 🔴 防回歸：唔可以將 zh 誤判為 en
  assert.equal(normalizeUiLang("zh-XX"), "zh-Hant");
});

test("isUiLang：只認兩個值（en-US 唔算）", () => {
  assert.equal(isUiLang("zh-Hant"), true);
  assert.equal(isUiLang("en"), true);
  assert.equal(isUiLang("en-US"), false);
  assert.equal(isUiLang("fr"), false);
});

test("interpolate：變數替換，未提供嘅原樣保留（唔會 undefined）", () => {
  assert.equal(interpolate("共 {n} 項", { n: 5 }), "共 5 項");
  assert.equal(interpolate("{a} 張收據 · {b} 款品項", { a: 12, b: 3 }), "12 張收據 · 3 款品項");
  assert.equal(interpolate("共 {n} 項"), "共 {n} 項");
  assert.equal(interpolate("無變數"), "無變數");
  assert.equal(interpolate("無變數", undefined), "無變數");
});

test("lookup：漏翻譯安全降級成中文（唔會 undefined / 空白）", () => {
  const dict = { 打印機: "Printer" };
  assert.equal(lookup(dict, "打印機"), "Printer");
  assert.equal(lookup(dict, "交班"), "交班");
  // 字典未載入都一樣安全
  assert.equal(lookup(undefined, "廚房"), "廚房");
  // 刻意翻譯成空字串 → 顯示空（唔當漏翻譯）
  assert.equal(lookup({ x: "" }, "x"), "");
  // 翻譯值會做變數替換
  assert.equal(lookup({ "共 {n} 項": "{n} items" }, "共 {n} 項", { n: 7 }), "7 items");
});

test("missingTranslations：列出 zh 有 en 缺嘅 key", () => {
  assert.deepEqual(missingTranslations({ a: "1", b: "2" }, { a: "1" }), ["b"]);
  assert.deepEqual(missingTranslations({ a: "1" }, { a: "1" }), []);
});

// ─── 第 1 層：字典完整性 ───────────────────────────────────────

test("🔴 英文字典冇漏翻譯（漏咗會永遠顯示中文）", () => {
  const missing = missingEnKeys();
  assert.deepEqual(missing, [], `英文字典漏咗：${missing.join(" / ")}`);
});

test("英文字典冇孤兒 key（en 有但 zh 冇 = typo 或刪漏）", () => {
  const orphans = orphanEnKeys();
  assert.deepEqual(orphans, [], `英文字典有多餘 key：${orphans.join(" / ")}`);
});

test("🔴 單字徽章 short：英文縮寫 ≤3 字母 + key 全單字 + 兩字典對齊", () => {
  // 圓形徽章 / min-w-[64px] 導航鈕闊度限制：>3 字母會令圓形橢圓化
  const tooLong = Object.entries(SHORT_EN_DICT)
    .filter(([, v]) => v.length > 3)
    .map(([k, v]) => `${k}→${v}(${v.length})`);
  assert.deepEqual(tooLong, [], `縮寫超過 3 字母：${tooLong.join(" ")}`);

  const notSingle = Object.keys(SHORT_ZH_DICT).filter((k) => k.length !== 1);
  assert.deepEqual(notSingle, [], `short key應該係單字：${notSingle.join(" ")}`);

  assert.deepEqual(Object.keys(SHORT_EN_DICT).sort(), Object.keys(SHORT_ZH_DICT).sort());
});

// ─── 🔴 第 2 層：持久化資料值絕對唔可以被翻譯 ─────────────────────

test("🔴 第 2 層：中文業務資料值被凍結（翻譯 = 靜靜壞功能）", () => {
  const FROZEN: ReadonlyArray<readonly [string, string, string]> = [
    [
      "src/lib/pos/quick-labels.ts",
      'order.tableName === "自取"',
      "翻譯後全部落入 default 分支 ⇒ 外賣/自取單狀態永遠顯示「待出餐」（唔會 throw）",
    ],
    [
      "src/lib/pos/quick-labels.ts",
      'order.tableName === "外賣"',
      "同上，quickCompleteLabel亦依賴佢",
    ],
    [
      "src/lib/retail/returns.ts",
      'order.tableName === "零售"',
      "翻譯後零售退貨頁完全載唔到單據（靜默空白）",
    ],
    [
      "src/lib/print-bridge/printer-models.ts",
      'b.includes("斑馬")',
      "打印語言判斷錯 ⇒ 斑馬機出唔到 ZPL",
    ],
    [
      "src/lib/print-bridge/printer-models.ts",
      'b.includes("立象")',
      "同上，Argox 出唔到 EPL",
    ],
  ];

  for (const [file, needle, why] of FROZEN) {
    const code = readSrc(file);
    assert.ok(
      code.includes(needle),
      `${file} 嘅中文資料值被改動咗！\n` +
        `  期望包含：${needle}\n` +
        `  原因：${why}\n` +
        `  呢個係持久化業務資料，唔係 UI 文案，唔可以用 t() 翻譯。`,
    );
  }
});

test("🔴 第 2 層：業務資料值唔可以做咗字典 key", () => {
  const FORBIDDEN = ["自取", "外賣", "零售", "斑馬", "立象"];
  const hit = FORBIDDEN.filter((k) => k in ZH_HANT_DICT);
  assert.deepEqual(hit, [], `業務資料值唔應該做咗字典 key：${hit.join(" / ")}`);
  const badShort = FORBIDDEN.filter((k) => k in SHORT_ZH_DICT);
  assert.deepEqual(badShort, [], `short 字典唔應該有業務值：${badShort.join(" / ")}`);
});

// ─── 🔴 第 3 層：紙單唔跟 UI 語言 ───────────────────────────────

test("🔴 第 3 層：紙單 label 唔可以入 UI 語言字典", () => {
  // 紙單係畀客人睇嘅收款憑證，唔應該因為店員切咗語言就變英文（J 2026-10-07 拍板）
  const PAPER_LABELS = [
    "單號",
    "菜品明細",
    "原價合計",
    "实收",
    "找零",
    "應收現金",
    "實收現金",
    "現金差額",
  ];
  const leaked = PAPER_LABELS.filter((k) => k in ZH_HANT_DICT);
  assert.deepEqual(leaked, [], `紙單 label 被放入 UI 字典 = ${leaked.join(" / ")}`);
});

test("🔴 第 3 層：出紙路徑唔可以依賴 UI 語言", () => {
  const code = readSrc("src/lib/escpos-render.ts");
  for (const forbidden of ["@/lib/i18n", "i18n-dict", "useLang", "LangProvider"]) {
    assert.ok(
      !code.includes(forbidden),
      `escpos-render.ts 出現 \`${forbidden}\` —— 出紙路徑唔應該依賴 UI 語言！`,
    );
  }
});

test("🔴 第 3 層：紙單預設文案維持繁中（翻譯咗會改變客人收到嘅單）", () => {
  const code = readSrc("src/lib/escpos-template.ts");
  assert.ok(code.includes("多謝惠顧"), "收據頁尾預設文案唔可以被翻譯/刪除");
  assert.ok(code.includes("交班人簽名"), "交班單頁尾預設文案唔可以被翻譯/刪除");
});

// ─── 儲存層：唔上雲 ───────────────────────────────────────────

test("🔴 語言偏好唔可以入 PosLocalSettings（會經 device-config 上雲）", () => {
  const types = readSrc("src/lib/types.ts");
  // ⚠️ 係 `export interface`（types.ts:873），唔係 `export type`
  const start = types.indexOf("export interface PosLocalSettings");
  assert.ok(start > 0, "搵唔到 PosLocalSettings 型別");
  // 由定義行開始，掃到檔案尾（interface 喺 873 行之後完結）
  const section = types.slice(start);
  assert.ok(
    !/uiLang|ui_lang/.test(section),
    "PosLocalSettings 入面出現咗語言欄位！\n" +
      "  佢會經 device-settings.tsx:933 → device-config/route.ts:109 上雲，\n" +
      "  違反「偏好只存本機 device」需求（J 2026-10-07 拍板）。",
  );
});

test("ui-preference.ts：獨立 key + 唔經 savePosLocalSettings + try/catch", () => {
  const code = readSrc("src/lib/ui-preference.ts");
  assert.ok(code.includes("pos.uiLang"), "應該用獨立 localStorage key `pos.uiLang`");
  assert.ok(
    !code.includes("savePosLocalSettings"),
    "ui-preference.ts 唔可以呼叫 savePosLocalSettings（會上雲）",
  );
  // 無痕模式 / 私隱設定會令 localStorage throw ⇒ 讀寫都要 try/catch
  const tryCount = (code.match(/try\s*{/g) ?? []).length;
  assert.ok(tryCount >= 2, `應該至少有 2 個 try（read + write），實際 ${tryCount}`);
});

// ─── Provider 掛載位置 ───────────────────────────────────────

test("LangProvider 掛喺 ClientOnly 內、AppErrorBoundary 外（包住）、worker 外", () => {
  // ⚠️ 必須剝註釋 —— layout.tsx 嘅註解入面**本身就**提到 `<AppErrorBoundary>`
  const layout = stripComments(readSrc("src/app/layout.tsx"));
  const clientOnly = layout.indexOf("<ClientOnly");
  const lang = layout.indexOf("<LangProvider");
  const worker = layout.indexOf("<PrintFlushWorker");
  const boundary = layout.indexOf("<AppErrorBoundary");
  const langEnd = layout.indexOf("</LangProvider>");

  assert.ok(clientOnly > 0 && lang > 0, "搵唔到 ClientOnly / LangProvider");
  assert.ok(lang > clientOnly, "LangProvider 必須喺 ClientOnly 之內（否則首次閃爍）");
  assert.ok(lang > worker, "LangProvider 唔應該包住 background worker");
  // LangProvider 包住 AppErrorBoundary ⇒ Provider 出錯時邊界仍然有自救入口
  assert.ok(
    lang < boundary && boundary < langEnd,
    "LangProvider 應該**包住** AppErrorBoundary（Provider 出錯都要見到自救入口）",
  );
});

test("<html lang> 預設仍然係 zh-Hant（server 讀唔到本機儲存）", () => {
  assert.ok(readSrc("src/app/layout.tsx").includes('lang="zh-Hant"'));
});

// ─── Provider 行為 ────────────────────────────────────────────

test("useLang 搵唔到 Provider 就要 throw（唔可以靜靜 fallback）", () => {
  const code = readSrc("src/components/lang-provider.tsx");
  assert.ok(
    /throw new Error/.test(code),
    "useLang() 應該 throw —— 靜靜 fallback 會造成「全部顯示中文」嘅隱蔽 bug",
  );
});

test("LangProvider 唔可以有 loading gate（會自己製造閃爍）", () => {
  const code = readSrc("src/components/lang-provider.tsx");
  assert.ok(
    !/isLoading|setLoading/.test(code),
    "LangProvider 出現 loading 字樣 —— 唔可以加 gating",
  );
});

test("🔴 LangProvider 首次載入就要同步 <html lang>（唔可以淨靠 setLang）", () => {
  const code = readSrc("src/components/lang-provider.tsx");
  // `layout.tsx` 嘅 lang="zh-Hant" 係 server 預設值；本機揀咗英文之後
  // refresh 頁面必須重新同步，否則 CSS :lang() / 螢幕閱讀器發音會錯。
  assert.ok(
    /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]{0,200}documentElement\.lang/.test(code),
    "LangProvider 必須有 useEffect 同步 document.documentElement.lang",
  );
});

// ─── P1 示範區翻譯完整度 ──────────────────────────────────────

test("P1：設置頁 tab 經 t() + 掛住 LanguageSection", () => {
  const code = readSrc("src/components/device-settings.tsx");
  assert.ok(/\{\s*t\(label\)\s*\}/.test(code), "設置頁 tab 應該 render {t(label)}");
  assert.ok(code.includes("<LanguageSection"), "設置頁應該掛住 LanguageSection");
});

test("P1：側欄 label / short 經 t() / tShort()，且冇加 truncate", () => {
  const code = readSrc("src/components/app-sidebar.tsx");
  assert.ok(code.includes("t(item.label)"), "側欄 label 應該經 t()");
  assert.ok(code.includes("tShort(item.short)"), "側欄 short 應該經 tShort()");
  assert.ok(code.includes('{t("設置")}'), "側欄設置連結應該翻譯");
  // 桌面側欄 label 靠 whitespace-pre-line 摺行，加 truncate 會剪走英文
  assert.ok(
    !/className="[^"]*whitespace-pre-line[^"]*truncate/.test(code),
    "側欄 label 加咗 truncate —— 英文會被剪走，應該靠 whitespace-pre-line 摺行",
  );
});

test("P1：工作台卡片 label / desc / short 全部經 t() / tShort()", () => {
  const code = readSrc("src/components/workbench-picker.tsx");
  assert.ok(code.includes("{t(w.label)}"), "workbench label 未翻譯");
  assert.ok(code.includes("{t(w.desc)}"), "workbench desc 未翻譯");
  assert.ok(code.includes("{tShort(w.short)}"), "workbench short 未翻譯");
});

test("🔴 workbench-picker hook 必須喺 early return 之前（React hook 順序）", () => {
  // ⚠️ 必須剝註釋 —— 該處註解會提到 early return 本身
  const code = stripComments(readSrc("src/components/workbench-picker.tsx"));
  const hookIdx = code.indexOf("useT();");
  const early = code.indexOf("if (workbenches.length === 0) return null;");
  assert.ok(hookIdx > 0 && early > 0, "搵唔到 useT() / early return");
  assert.ok(
    hookIdx < early,
    "useT() 喺 early return 之後！\n" +
      "  props 令 workbenches 由非空變空時 hook 數目會變少 ⇒ " +
      "React 爆「Rendered fewer hooks than expected」。",
  );
});

test("module-catalog 嘅 label / short 維持中文（係字典 key 來源）", () => {
  const code = readSrc("src/lib/pos/module-catalog.ts");
  for (const zh of ['label: "點餐"', 'label: "堂食收銀台"', 'short: "點"']) {
    assert.ok(
      code.includes(zh),
      `module-catalog 嘅 \`${zh}\` 被改咗 —— 呢啲係字典 key／單字徽章來源，必須維持中文`,
    );
  }
});

test("🔴 字典 key 覆蓋 module-catalog 全部 label / short / desc", () => {
  // ⚠️ 2026-10-07 病：`desc: "逐件菜撳 ✓（…）"` 多咗個空格，
  // 字典寫 `"逐件菜撳✓（…）"`（冇空格）⇒ `t()` 查唔到，英文版顯示中文。
  // **零 throw、零 error** —— 肉眼先捉到。所以呢個守衛唔可以只查 label/short，
  // `desc` 一定要包（工作台卡片副標就係佢）。
  const code = readSrc("src/lib/pos/module-catalog.ts");
  const raws = [...code.matchAll(/(label|short|desc):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]] as const);
  assert.ok(raws.length > 30, `只抽到 ${raws.length} 條，掃描範圍可能壞咗`);

  const miss: string[] = [];
  for (const [kind, raw] of raws) {
    // `short` 係單字徽章 ⇒ 查 SHORT 字典；`label` / `desc` 查主字典
    const dicts = kind === "short" ? [SHORT_ZH_DICT, SHORT_EN_DICT] : [ZH_HANT_DICT, EN_DICT];
    if (!(raw in dicts[0])) miss.push(`${kind} 缺繁中：${raw}`);
    if (!(raw in dicts[1])) miss.push(`${kind} 缺英文：${raw}`);
  }
  assert.deepEqual(miss, [], `module-catalog 文案冇翻譯：\n  ${miss.join("\n  ")}`);
});

test("WORKBENCH_GROUP_LABEL 兩個值都有翻譯", () => {
  assert.ok("收銀工作台" in ZH_HANT_DICT);
  assert.ok("呢部機專用 · 廚房／出餐屏" in ZH_HANT_DICT);
});

// ─── P1 翻譯完整度（唔可以只做一半）──────────────────────────

test("P1：選擇頁全部可見文案都經 t()（唔可以有漏網硬編中文）", () => {
  const code = stripComments(readSrc("src/components/select-workbench-screen.tsx"));
  // 🔴 只可以保留「角色值插值」（帳號 / 標點 / emoji / 「、」分隔符）
  for (const forbidden of [
    "登出",
    "以此身份登出",
    "載入中…",
    "搵唔到想用嘅模組？",
    "記住呢部機嘅選擇",
    "管理員",
    "店長",
    "收銀員",
  ]) {
    // 全部都應該只出現喺 t("…") 之內
    const bare = [...code.matchAll(new RegExp(`(?<!t\\()"${forbidden.slice(0, 4)}`, "g"))];
    assert.deepEqual(
      bare.map((m) => m[0]),
      [],
      `「${forbidden}」似乎有冇經 t() 嘅硬編殘留`,
    );
  }
  // 插值一定要翻譯：`w.label` 係中文原文
  assert.ok(code.includes("lockedWorkbenches.map((w) => t(w.label))"), "未開通清單應該翻譯 label");
  assert.ok(code.includes("roleLabel(session.role, t)"), "roleLabel 應該收 t");
});

test("P1：設置頁 header + 打印機卡經 t()", () => {
  const settings = readSrc("src/components/device-settings.tsx");
  assert.ok(settings.includes('{t("返回收銀台")}'), "返回收銀台應該翻譯");
  assert.ok(settings.includes('{t("設置")}'), "設置頁標題應該翻譯");

  const card = readSrc("src/components/printer-card-v2.tsx");
  assert.ok(card.includes("useT()"), "打印機卡應該用 useT()");
  // 🔴 `role` 係持久化業務值，只能翻譯顯示層
  assert.ok(
    card.includes('role === "receipt"'),
    "printer.role 判斷必須維持英文 enum（唔可以翻譯 role 本身）",
  );
  for (const pair of [
    ['t("已連線")', "已連線"],
    ['t("未連線")', "未連線"],
    ['t("測試打印")', "測試打印"],
    ['t("添加打印機")', "添加打印機"],
  ]) {
    assert.ok(card.includes(pair[0]), `打印機卡應該翻譯「${pair[1]}」`);
  }
});

test("🔴 打印機 role / connectionType enum 唔可以被翻譯", () => {
  const card = readSrc("src/components/printer-card-v2.tsx");
  // 呢啲值會寫入 PosLocalSettings 再上雲 ⇒ 一旦比人改成中文，
  // `suggestLabelCommandSet` / 打印路由全部對唔上。
  for (const lit of ['"receipt"', '"label"', '"zone"', '"lan"', '"usb"']) {
    assert.ok(card.includes(lit), `printer-card-v2 嘅 enum literal ${lit} 唔可以被改動`);
  }
});

// ─── 語言清單 ─────────────────────────────────────────────────

test("🔴 字典 key 語法：含中文標點嘅 key 一定要加引號", () => {
  // 病：2026-10-07 連續 4 次 SyntaxError（ERR_INVALID_TYPESCRIPT_SYNTAX）。
  // 原因係 `…`(U+2026) / `，`(U+FF0C) / `？`(U+FF1F) **唔係合法 JS 标识符字符** ——
  // CJK 漢字（U+4E00–U+9FFF）可以裸寫，但中文標點唔可以。
  // 症狀好難睇：報錯只會指去下一行，睇落好似無關字串有問題。
  //
  // ⚠️ 唔好用 regex 掃「行首 key」—— 多行 value（`key:\n  "long value",`）
  // 會被誤判。改為**抽 object literal 再交俾真 parser**。
  for (const [file, name] of [
    ["src/lib/i18n-dict-zh.ts", "ZH_HANT_DICT"],
    ["src/lib/i18n-dict-zh.ts", "SHORT_ZH_DICT"],
    ["src/lib/i18n-dict-en.ts", "EN_DICT"],
    ["src/lib/i18n-dict-en.ts", "SHORT_EN_DICT"],
  ] as const) {
    const code = readSrc(file);
    const marker = `export const ${name}`;
    const start = code.indexOf(marker);
    assert.ok(start > 0, `${file} 搵唔到 ${name}`);
    const open = code.indexOf("{", start);
    // 括號配對（字典入面冇字串內含大括號，夠用）
    let depth = 0;
    let end = -1;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    assert.ok(end > open, `${name} 括號唔配對`);
    const literal = code.slice(open, end);
    // 真 parser：語法錯就會喺呢度 throw（比 regex 掃描準確得多）
    const parsed = new Function(`return ${literal};`)() as Record<string, string>;
    assert.ok(Object.keys(parsed).length > 0, `${name} 係空`);
  }
});

test("🔴 全專案 t() 嘅 key 必須喺兩本字典都有（漏翻譯 = 永遠顯示中文）", () => {
  // 病：2026-10-07 `t("…都設成同一個分區就得。")` 喺字典入面寫成「就行。」
  // ⇒ 差一個字就靜靜漏翻譯，**唔會 throw、唔會報錯**，英文版照樣顯示中文。
  // 之前 `missingEnKeys()` 捉唔到，因為佢只比對「zh 有、en 缺」，
  // 捉唔到「代碼用嘅 key 同字典個 key 根本唔一樣」。
  //
  // ⚠️ 只掃 `from "@/components/lang-provider"` 嘅檔案 ——
  // `order/page.tsx` / `kiosk/*` 有自己嘅 `t`（`kioskT`，用英文 key），
  // 唔屬於呢套字典，掃埋佢哋會產生 90+ 誤報。
  const files = walkSrc("src/").filter(
    (f) => !/i18n-dict-|i18n\.ts$/.test(f) && /from "@\/components\/lang-provider"/.test(readFileSync(f, "utf8")),
  );
  const RE = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g;
  /** key → 第一次出現嘅位置（方便報錯） */
  const sites = new Map<string, string>();
  for (const f of files) {
    // ⚠️ 一定要 `stripComments()` —— 呢個 guard 檔自己嘅註解就係一大堆示例 key，
    // 唔剝就會掃到自己（2026-10-07 實測：病例 key 響註解入面，變成假 failure）。
    const code = stripComments(readFileSync(f, "utf8"));
    for (const m of code.matchAll(RE)) {
      if (sites.has(m[1])) continue;
      const line = code.slice(0, m.index).split("\n").length;
      sites.set(m[1], `${f.replace(/\\/g, "/").split("/macauPosSystem/")[1]}:${line}`);
    }
  }
  assert.ok(sites.size > 100, `只掃到 ${sites.size} 個 key，掃描範圍可能壞咗`);

  // 純 ascii key 多數係變數名（`t(someVar)` 嘅值），唔算漏翻譯
  const isCjk = (k: string) => /[一-鿿]/.test(k);
  const missEn: string[] = [];
  const missZh: string[] = [];
  for (const [k, site] of sites) {
    if (!isCjk(k)) continue;
    if (!(k in EN_DICT)) missEn.push(`${k}  @ ${site}`);
    if (!(k in ZH_HANT_DICT)) missZh.push(`${k}  @ ${site}`);
  }
  assert.deepEqual(missEn, [], `英文缺 ${missEn.length} 條：\n  ${missEn.join("\n  ")}`);
  assert.deepEqual(missZh, [], `繁中缺 ${missZh.length} 條：\n  ${missZh.join("\n  ")}`);
});

test("UI_LANGS：暫時 2 個（繁中 + 英文），預設繁中", () => {
  assert.equal(UI_LANGS.length, 2);
  assert.deepEqual([...UI_LANGS], ["zh-Hant", "en"]);
  assert.equal(DEFAULT_UI_LANG, "zh-Hant");
  for (const l of UI_LANGS) assert.equal(isUiLang(l), true);
});