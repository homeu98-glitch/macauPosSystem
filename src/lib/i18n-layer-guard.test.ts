import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { EN_DICT, missingEnKeys, orphanEnKeys, SHORT_EN_DICT, SIDEBAR_EN_DICT } from "./i18n-dict-en.ts";
import { SHORT_ZH_DICT, SIDEBAR_ZH_DICT, ZH_HANT_DICT } from "./i18n-dict-zh.ts";
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

test("🔴 第 2 層：純資料值唔可以做咗字典 key", () => {
  /**
   * ⚠️ 2026-10-08 修訂（P2b）。
   *
   * 原本呢個測試係「**一律**禁止業務資料值做字典 key」，FORBIDDEN 包埋
   * `自取` / `外賣`。但實際去查證之後發現呢條禁令**執行唔到**，而且係
   * 錯嘅抽象：
   *
   * 1. `堂食` **一直**都係字典 key（`restaurant-daily-report.tsx` 等都用
   *    `t("堂食")`），但佢同樣係 `quickTypeTableName()` 嘅回傳值
   *    （寫入 `order.tableName` ＋ 單號抬頭）。即係話「業務值唔可以做 key」
   *    呢條規則**早就已經被 `堂食` 破咗**，只係冇人發現。
   * 2. 禁令混淆咗「字串相等」同「值嘅流向」。`lookup()` 嘅 fallback 係
   *    「唔中就直接回中文原文」，所以字典 key **只會**影響完全相等嘅字串；
   *    真正嘅持久化值係由 `quickTypeTableName()` / `quick-labels.ts` 嘅
   *    **字面量**寫入同比較 —— 嗰啲由下面兩組 FROZEN guard 鎖死。
   * 3. 快餐類型選擇器（堂食 / 外賣 / 自取）係**第 1 層按鈕文案**。
   *    唔畀佢入字典 ⇒ 英文版永遠有 3 粒中文掣。
   *
   * ⇒ 收窄成：**冇任何第 1 層用途**嘅純資料值先禁止做 key。
   *    兩用值（堂食 / 自取 / 外賣）改為由下面
   *    「t() 唔可以套用喺持久化業務值上面」嘅**正面 guard** 保護。
   */
  const PURE_DATA = ["零售", "斑馬", "立象"];
  const hit = PURE_DATA.filter((k) => k in ZH_HANT_DICT);
  assert.deepEqual(hit, [], `純資料值唔應該做咗字典 key：${hit.join(" / ")}`);
  const badShort = PURE_DATA.filter((k) => k in SHORT_ZH_DICT);
  assert.deepEqual(badShort, [], `short 字典唔應該有純資料值：${badShort.join(" / ")}`);

  /**
   * 兩用值（第 1 層按鈕文案 ∩ 第 2 層持久化值）**必須**留在字典 ——
   * 佢哋係 UI 文案。若呢度紅，代表有人改咗文案但冇同步
   * （或者有人「順手」把 key 刪走）⇒ 英文版會靜靜變返中文。
   *
   * ⚠️ 呢個清單同時係「**已知**兩用值」嘅記錄：加一個新兩用值之前，
   *    一定要先喺 `FROZEN` 釘死佢嘅**持久化字面量**，再入呢度。
   *    （2026-10-08 P2b：`快餐` / `退款金額` / `退款原因` / `已完成` / `收銀` 就係咁加。）
   */
  const DUAL_USE = [
    "堂食",
    "自取",
    "外賣",
    "快餐",
    "全部退菜",
    "退桌",
    "訂單",
    "會員餘額",
    "免單",
    "退款金額",
    "退款原因",
    "已完成",
    "收銀",
  ];
  const gone = DUAL_USE.filter((k) => !(k in ZH_HANT_DICT));
  assert.deepEqual(
    gone,
    [],
    `兩用值唔見咗字典 key：${gone.join(" / ")}\n` +
      "  佢哋係快餐類型選擇器（堂食 / 外賣 / 自取）嘅第 1 層按鈕文案，\n" +
      "  唔可以刪；刪咗英文版會靜靜 fallback 返中文。",
  );
});

test("🔴 第 2 層：t() 唔可以套用喺持久化業務值上面", () => {
  /**
   * 呢個係上面「兩用值」放寬之後嘅**正面保護**：真正嘅危險唔係
   * 「字串做咗字典 key」，而係「把 `t()` 套用喺一個持久化值上面」。
   *
   * 例如 `t(order.tableName)` —— 一旦有人覺得 `{order.tableName}`
   * 「好似漏咗 i18n」而包一層 `t()`：
   *   · 快餐單（`自取` / `外賣` / `堂食`）會被譯走 ⇒ 同紙單、DB 唔一致；
   *   · 之後任何人再加「寫返 / 比較」邏輯就會靜靜壞。
   *
   * 全 `src/` 掃描（650 個檔）。要新增例外必須喺呢度寫明理由。
   */
  const BAD: ReadonlyArray<readonly [RegExp, string]> = [
    /**
     * ⚠️ `[^,()]*` 唔可以放寬成 `[^)]*`：後者會橫跨逗號，誤報
     *    `t("{table} 已落單", { table: order.tableName })` —— 呢種係
     *    **把桌名當 placeholder 值**插入（原樣輸出，唔經字典），係安全嘅。
     *    真正危險嘅係把持久化值當**第一個引數（= 字典 key）**。
     */
    [
      /\bt\(\s*[^,()]*\.(tableName|paymentMethod|brand|zoneId)\b/,
      "把 t() 嘅 **key** 用咗 tableName／paymentMethod／brand／zoneId（第 2 層持久化值）",
    ],
    [/\bt\(\s*quickTypeTableName\s*\(/, "把 t() 套用喺 quickTypeTableName()（回傳值直接寫入 order.tableName）"],
  ];

  const offenders: string[] = [];
  for (const abs of walkSrc("src/")) {
    const code = stripComments(readFileSync(abs, "utf8"));
    const lines = code.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [re, why] of BAD) {
        if (re.test(line)) {
          // ⚠️ 唔可以用 `SRC.pathname` 拼相對路徑：Windows 下係 `/C:/…`，
          //    同 `fileURLToPath` 出嘅 `C:\…` 對唔上（2026-10-08）。
          offenders.push(`${abs}:${i + 1} — ${why}\n      ${line.trim()}`);
        }
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `有 ${offenders.length} 處把 t() 套用喺持久化業務值：\n  ${offenders.join("\n  ")}\n` +
      "  呢啲值係寫入 DB／紙單／單號抬頭嘅資料，翻譯會靜靜壞功能（唔會 throw）。",
  );
});

// ─── 🔴 P2 前置：高風險持久化值凍結（2026-10-08）──────────────────
//
// P2 要批量包 `t()`。以下三個值**同時餵 UI 同紙單／持久化**，
// 一旦被包成 `t()`，UI 切英文就會連寫入 DB 嘅值都變英文 ⇒ 靜靜壞功能（唔會 throw）。

test("🔴 P2 前置：交班現金統計 key 凍結（同時餵 UI 同紙單）", () => {
  const code = readSrc("src/components/shift-page.tsx");
  assert.ok(
    code.includes('const cashKeys = ["現金", "會員餘額 + 現金", "優惠券 + 現金"];'),
    "shift-page.tsx 嘅 cashKeys 被改動！\n" +
      "  呢三個值係交班現金對帳嘅比對 key（`key.includes(cashKey)`），\n" +
      "  翻譯成英文就永遠 match 唔到 ⇒ 交班現金差額靜默變 0。",
  );
});

test("🔴 P2 前置：paymentMethod 持久化 enum 凍結（寫入 DB，唔係文案）", () => {
  const code = readSrc("src/components/pos-app.tsx");
  const FROZEN: ReadonlyArray<readonly [string, string]> = [
    ["paymentMethod: \"免單\"", "全額減免單寫入 DB 嘅值；翻譯後報表／對帳分唔出免單"],
    ["paymentMethod: \"線上已支付\"", "線上已付清嘅持久化值；翻譯後結帳目標單認唔返"],
  ];
  for (const [needle, why] of FROZEN) {
    assert.ok(
      code.includes(needle),
      `pos-app.tsx 搵唔到 \`${needle}\`\n  原因：${why}\n` +
        "  呢個係持久化資料值，唔係 UI 文案，唔可以用 t() 包。",
    );
  }
});

test("🔴 P2b 前置：pos-app 其餘第 2／3 層中文值凍結", () => {
  /**
   * 呢批係 `tools/_i18n-inventory.cjs --layer2` 掃出嚟嘅地雷（2026-10-08）。
   * 全部都係**結構上同文案一模一樣**嘅字面量，但語意上係資料值／紙單內容。
   *
   * 🔴 佢哋全部係「靜默失敗」：翻咗唔會 throw、唔會報錯，
   *    但會令比較唔中／DB 寫入值突變／紙單變英文。
   */
  const code = readSrc("src/components/pos-app.tsx");

  /**
   * ⚠️ 用 **regex** 唔用 `includes`：有啲值喺**多行三元運算式**入面，
   *    例如 `paymentMethod:` 同 `: "會員餘額"` 相隔 3 行 —— 用 `includes`
   *    寫 `paymentMethod: "會員餘額"` 會永遠 match 唔到（2026-10-08 踩過）。
   */
  const FROZEN: ReadonlyArray<readonly [RegExp, string]> = [
    [
      /:\s*"會員餘額"/,
      "會員餘額付款嘅持久化值（同 `LEDGER_PAYMENT_MODE_LABELS.member_balance` 一口徑）；" +
        "翻譯後報表「支付方式分項」同對帳分唔出呢一類單",
    ],
    [
      /if \(quickOrderType === "pickup"\) return "自取";/,
      "`quickTypeTableName()` 嘅回傳值**直接寫入 `order.tableName`**；" +
        "`quick-labels.ts:25` 用 `tableName === \"自取\"` 判「待取餐」—— 翻譯即出餐文案全錯",
    ],
    [
      /if \(quickOrderType === "delivery"\) return "外賣";/,
      "同上；`quick-labels.ts:26` 用 `tableName === \"外賣\"` 判「待交付」",
    ],
    [
      /\{ name: "退款金額", quantity: 1, note: formatMoney\(/,
      "退款單嘅**打印品項名**（第 3 層：實體紙單）。紙單係畀客人嘅憑證，" +
        "唔應該因為店員切英文而變英文；而且 escpos-render 契約要求「介面 ≡ 預覽 ≡ 實際打印」",
    ],
    [
      /\{ name: "退款原因", quantity: 1, note: reason \}/,
      "同上（退款單打印品項名）",
    ],
    // ── 2026-10-08（P2b 收尾）：以下係逐行覆核過嘅**持久化 fallback 字面量** ──
    //    佢哋同 UI 文案撞樣，但寫入 DB／紙單／單號，翻譯就靜默壞功能。
    [
      /voidedReason: reason \|\| "未填寫原因"/,
      "退菜原因嘅持久化 fallback（寫入 `order.voidedReason`）；翻譯後報表退菜原因變英文",
    ],
    [
      /cancelledReason: isRefundedRule \? undefined : reason \|\| "全部退菜"/,
      "整單取消原因嘅持久化 fallback（寫入 `order.cancelledReason`）",
    ],
    [
      /const reasonText = reason\?\.trim\(\) \|\| "退桌"/,
      "退桌原因嘅持久化 fallback（寫入 `order.cancelledReason`）",
    ],
    [
      /localOrderNo \?\? "未落單"/,
      "未落單時嘅 `localOrderNo` 佔位值；會上紙單同訂單列表",
    ],
    [
      /storeName \?\? "門店"/,
      "店名 fallback（`bootstrap.storeName` 冇值時）；**直接餵打印 job** ⇒ 紙單抬頭",
    ],
    [
      /account \?\? "收銀"/,
      "操作人 fallback（`session.name` / `session.account` 都冇值時）；寫入稽核記錄",
    ],
    [
      /action: "completed", label: options\?\.label \?\? "已完成"/,
      "完成狀態嘅 sync event payload label（持久化）；翻譯後雲端／Ledger 對唔上",
    ],
    [
      /orderNoSuffix: " \(重打\)"/,
      "重打單嘅單號後綴；直接印落紙單（第 3 層）",
    ],
    [
      /title = "退款單號"/,
      "退款單嘅紙單標題（第 3 層）",
    ],
    [
      /"部分退款單號"/,
      "部分退款單嘅紙單標題（第 3 層）",
    ],
    [
      /`會員餘額 \+ \$\{method\}`/,
      "混合付款嘅 `paymentMethod` 持久化值（會員餘額 + 其他方式）",
    ],
    [
      /`會員券 \+ \$\{method\}`/,
      "同上（會員券 + 其他方式）",
    ],
    [
      /paymentMethods\[0\] \?\? "現金"/,
      "預設付款方式 `paymentMethod` 持久化值",
    ],
    [
      /activeTable\?\.name \?\? "堂食"/,
      "打印用嘅桌名 fallback（第 2 層 tableName 形狀）",
    ],
  ];

  for (const [re, why] of FROZEN) {
    assert.match(
      code,
      re,
      `pos-app.tsx 搵唔到 ${re}\n  原因：${why}\n` +
        "  呢個係資料值／紙單內容，唔係 UI 文案，唔可以用 t() 包。",
    );
  }
});

test("🔴 P2b：快餐模式嘅合成桌名要喺**渲染期**翻譯，唔可以改資料", () => {
  /**
   * `pos-app.tsx` 快餐模式會合成一個假桌：`{ id: "counter", name: "快餐", area: "" }`。
   *
   * 佢**唔會**寫入 `tableName`（`tableName: isQuickMode ? quickTypeTableName() : activeTable.name`），
   * 所以唔屬於第 2 層 —— 但佢住喺一個 `tables[number]` 形狀嘅物件裡面，
   * 同真正嘅 DB 桌名（第 2 層，**絕對唔可以譯**）**位置完全一樣**。
   *
   * ⇒ 唯一安全做法：**資料保持 `"快餐"`，喺渲染點 special-case**。
   *    一旦有人為咗「順手」而改咗 `name: "快餐"` 個字面量，就會連真正桌名一齊誤譯。
   */
  const code = readSrc("src/components/pos-app.tsx");

  assert.ok(
    code.includes('{ id: "counter", name: "快餐", area: "" }'),
    "合成桌物件改咗樣 —— 要確認 `name` 仍然係未翻譯嘅資料值，翻譯只喺渲染點做。",
  );

  assert.match(
    code,
    /activeTable\?\.id === "counter"\s*\?\s*t\("快餐"\)/,
    "渲染點應該係 `activeTable?.id === \"counter\" ? t(\"快餐\") : activeTable?.name`。\n" +
      "  唔可以直接 `t(activeTable?.name)` —— 真正桌名係第 2 層 DB 值，會誤譯。",
  );
});

test("🔴 P2 前置：LEDGER_PAYMENT_MODE_LABELS 凍結（紙單＋報表依賴）", () => {
  const code = readSrc("src/lib/pos/payment-method-label.ts");
  const FROZEN = [
    'in_store: "到店付款"',
    'balance: "餘額扣點"',
    'member_balance: "會員餘額"',
    'online_paid: "線上已支付"',
    'prepaid: "線上已支付"',
  ];
  for (const needle of FROZEN) {
    assert.ok(
      code.includes(needle),
      `payment-method-label.ts 缺少 \`${needle}\`。\n` +
        "  呢個表係支付方式標籤唯一真源（紙單＋報表都靠佢），\n" +
        "  改動會令 Ledger enum 原文（in_store / balance）漏上畫面或紙單。",
    );
  }
});

// ─── 🔴 第 2 層：共用 chips 元件嘅 `translateLabels` opt-out ──────

test("🔴 第 2 層：付款方式 chips 必須傳 translateLabels={false}", () => {
  /**
   * `DateRangeFilterChips` 預設會將 `options[].label` 當第 1 層文案去 `t()`。
   * 但 `inventory-view` 借咗同一個元件去渲染**付款方式** chips ——
   * 嗰啲 label 係 admin 主檔嘅付款方式名，即**第 2 層持久化資料值**。
   *
   * 一旦有人刪咗 `translateLabels={false}`，而 admin 又咁啱改咗個付款方式叫
   * `全部` / `自訂`（撞正 chips 字典 key），個 chip 就會顯示英文但 value
   * 仍然係中文原文 ⇒ 篩選靜靜壞掉（唔會 throw、唔會紅）。
   */
  const code = readSrc("src/components/inventory/inventory-view.tsx");
  assert.match(
    code,
    /<DateRangeFilterChips\s+options=\{methodFilterOptions\}[\s\S]{0,200}?translateLabels=\{false\}/,
    "inventory-view 嘅付款方式 chips 唔見咗 `translateLabels={false}`。\n" +
      "  嗰啲 label 係第 2 層持久化資料值（admin 主檔付款方式名），\n" +
      "  翻譯 = 篩選靜靜壞掉。詳見 date-range-filter-chips.tsx 嘅 i18n 註解。",
  );
});

test("🔴 第 1 層：付款方式 chips 嘅「全部（N）」仍然要翻譯", () => {
  // 同一個 chips 入面混住兩層：`全部（N）` 係第 1 層（要譯）、
  // 付款方式名係第 2 層（唔譯）。呢條釘死「混合」嗰半邊冇被一刀切掉。
  const code = readSrc("src/components/inventory/inventory-view.tsx");
  assert.ok(
    code.includes('t("全部（{n}）", { n: receipts.length })'),
    "inventory-view 嘅「全部（N）」chip 應該經 `t(\"全部（{n}）\", { n: receipts.length })`。\n" +
      "  佢係第 1 層顯示文案（唔似付款方式名），唔應該跟 chips 一齊唔譯。",
  );
});

// ─── 🔴 靜態掃描盲點：經 state 傳入 t() 嘅 key ─────────────────

test("🔴 報表頁：經 state / map 傳入 t() 嘅標籤全部要有英文", () => {
  /**
   * 呢幾處嘅 key 係**動態**傳入 `t()`，所以
   * `tools/_t-keys-missing.cjs` 同「全專案 t() 嘅 key」守衛都掃唔到 ——
   * 漏翻譯會靜靜 fallback 中文（畫面中英夾雜），冇任何 error。
   *
   * 每個 case 由原始碼抽出字面標籤，逐個查 `EN_DICT`。
   */
  const code = readSrc("src/components/restaurant-daily-report.tsx");

  /**
   * [說明, 抽 block 嘅 regex（capture group 1 = block）, 抽標籤嘅 regex]
   *
   * ⚠️ 一定要分開「抽 block」同「抽標籤」兩個 regex：`FILTERS` 係
   * `{ key: "today", label: "今天" }`，用 `:\s*"…"` 會連 `key` 一齊抽，
   * 變成「today 冇英文翻譯」嘅假 failure（2026-10-08 實測）。
   */
  const CASES: Array<[string, RegExp, RegExp]> = [
    [
      "POS_ORDER_STATUS_LABELS（報表「狀態分佈」）",
      /const POS_ORDER_STATUS_LABELS[\s\S]*?\{([\s\S]*?)\n\};/,
      /:\s*"((?:[^"\\]|\\.)*)"/g,
    ],
    [
      "LEVEL_LABEL（優化建議卡嘅「立即 / 關注 / 資訊」徽章）",
      /const LEVEL_LABEL[\s\S]*?=\s*\{([^}]*)\}/,
      /:\s*"((?:[^"\\]|\\.)*)"/g,
    ],
    [
      "FILTERS（報表頁時間範圍 chips ＋ 建議卡標題）",
      /const FILTERS[\s\S]*?=\s*\[([\s\S]*?)\n\];/,
      /\blabel:\s*"((?:[^"\\]|\\.)*)"/g,
    ],
  ];

  for (const [label, blockRe, valueRe] of CASES) {
    const block = blockRe.exec(code);
    assert.ok(block, `搵唔到 ${label}（改名／搬位就要更新呢條守衛）`);

    const labels = [...block[1].matchAll(valueRe)].map((m) => m[1]);
    assert.ok(labels.length > 0, `${label} 抽唔到任何標籤`);

    const missing = labels.filter((l) => !(l in EN_DICT));
    assert.deepEqual(
      missing,
      [],
      `${label} 冇英文翻譯（英文版會出中文）：\n  ${missing.join("\n  ")}`,
    );
  }
});

test("🔴 報表頁：ledgerError 嘅 state key 要喺字典（靜態掃描盲點）", () => {
  /**
   * `setLedgerError("尚未連線 Ledger…")` 存嘅係**字典 key**，
   * render 期 `t(ledgerError)` 才翻譯。呢種寫法靜態掃描睇唔到，
   * 一旦漏加字典 key，英文版會靜靜出中文（2026-10-08 真實踩過）。
   */
  const code = readSrc("src/components/restaurant-daily-report.tsx");
  const setter = /setLedgerError\(\s*"((?:[^"\\]|\\.)*)"/.exec(code);
  assert.ok(setter, "搵唔到 setLedgerError(\"…\") 嘅字面值");

  const key = setter[1];
  assert.ok(key in ZH_HANT_DICT, `字典冇呢條 key：${key}`);
  assert.ok(key in EN_DICT, `英文字典冇呢條 key（英文版會出中文）：${key}`);
});

test("🔴 訂單狀態／付款徽章標籤：每個都要有英文翻譯（靜態掃描盲點）", () => {
  /**
   * `getOrderStatusBadge()` / `getPaymentBadge()` / `localOrderStatusLabel()` 回傳**純中文**。
   *
   * 點解 lib 唔直接回英文？—— 呢啲值同時餵**顯示**（`t(badge.label)`）同
   * **CSV 匯出**（`orders-hub.tsx` 直接攞 `.label` 寫入商家對帳檔）。
   * lib 保持純函式（可單測、語言無關），由 consumer 喺顯示位決定翻唔翻。
   *
   * ⇒ 靜態掃描只認 `t("字面值")`，睇唔到 `t(badge.label)`。
   *    漏加字典 key = 英文版靜靜出中文、冇 error、冇 clip、測試全綠。
   *    呢條守衛由原始碼抽出所有**顯示用**標籤字面值，逐個查兩本字典。
   */
  const filters = readSrc("src/lib/pos-order-filters.ts");
  const quickLabels = readSrc("src/lib/pos/quick-labels.ts");

  /**
   * ⚠️ 只抽「顯示用」嘅 `label:` / `return "…"` 字面值。
   * `String(order.status)`（raw enum passthrough）唔係字面值，自然抽唔到 —— 正確。
   * `quickCompleteLabel()` 嘅回傳係**持久化 payload**（`markQuickOrderCompletedInStore`
   * 寫入 sync event），所以下面只抽 `quickCompletionLabel` 嘅函式體，唔好連佢一齊抽。
   */
  const labelRe = /\blabel:\s*"((?:[^"\\]|\\.)*)"/g;
  const returnRe = /\breturn\s+"((?:[^"\\]|\\.)*)"/g;

  const labels = [
    ...[...filters.matchAll(labelRe)].map((m) => m[1]),
    ...[...filters.matchAll(returnRe)].map((m) => m[1]),
  ];

  const quickCompletion = /export function quickCompletionLabel[\s\S]*?\n\}/.exec(quickLabels);
  assert.ok(quickCompletion, "搵唔到 quickCompletionLabel（改名／搬位就要更新呢條守衛）");
  labels.push(...[...quickCompletion[0].matchAll(returnRe)].map((m) => m[1]));

  assert.ok(labels.length >= 12, `抽唔到足夠標籤（只有 ${labels.length} 條）`);

  const uniq = [...new Set(labels)];
  const missingEn = uniq.filter((l) => !(l in EN_DICT));
  assert.deepEqual(
    missingEn,
    [],
    `徽章標籤冇英文翻譯（英文版會出中文）：\n  ${missingEn.join("\n  ")}`,
  );

  const missingZh = uniq.filter((l) => !(l in ZH_HANT_DICT));
  assert.deepEqual(missingZh, [], `中文主字典冇呢啲 key：\n  ${missingZh.join("\n  ")}`);
});

test("🔴 訂單頁 toast：state 存嘅字典 key 要齊（靜態掃描盲點）", () => {
  /**
   * `local-orders-panel.tsx` 嘅 toast 係 `setToast("…")` 存**字典 key**，
   * render 期 `{t(toast)}` 才翻譯（同報表頁 `setLedgerError` 同一寫法）。
   *
   * ⇒ 靜態掃描只認 `t("字面值")`，睇唔到 `t(toast)`。
   *    漏加字典 key = 英文版靜靜出中文 toast、冇 error、測試全綠。
   *
   * 同時守住 lib 回傳嘅錯誤訊息（`result.error ?? "…"` 嘅來源）——
   * 呢啲字串由 `src/lib/pos-orders.ts` 直接餵入 toast。
   */
  /**
   * ⚠️ 只抽**確定係顯示文案**嘅來源。用 `?? "…"` 做通配會夾埋
   * `zoneId ?? "label"` / `storeName ?? "門店"` 呢類**持久化 fallback**（假 failure）。
   */
  const SOURCES: Array<[string, RegExp, boolean]> = [
    // ① 元件內直接寫入 toast 嘅字面值（`true` = 直接抽 capture group 1）
    ["src/components/local-orders-panel.tsx", /\bsetToast\(\s*"((?:[^"\\]|\\.)*)"/g, true],
    // ② `result.error` 嘅來源（`src/lib/pos-orders.ts` 嘅 `{ ok: false, error: "…" }`）
    ["src/lib/pos-orders.ts", /\berror:\s*"((?:[^"\\]|\\.)*)"/g, true],
    // ③ `setToast(describeNoReceiptPrinterError())` 嘅來源（`false` = 抽函式體再抽 return）
    ["src/lib/print-jobs.ts", /export function describeNoReceiptPrinterError[\s\S]*?\n\}/, false],
  ];

  const keys: string[] = [];
  for (const [f, re, isLiteral] of SOURCES) {
    const code = readSrc(f);
    if (isLiteral) {
      // ⚠️ 一定要 `matchAll`（`exec` 只會回第一個 match ⇒ 抽得 2 條，假 failure）。
      keys.push(...[...code.matchAll(re)].map((m) => m[1]));
      continue;
    }
    const m = re.exec(code);
    assert.ok(m, `搵唔到來源（改名／搬位就要更新呢條守衛）：${f}`);
    keys.push(...[...m[0].matchAll(/return\s+"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]));
  }

  // ⚠️ `收銀` 係**持久化 operator fallback**（寫入稽核），唔係顯示文案 ⇒ 排除。
  const EXCLUDE = new Set(["收銀", "門店", "label"]);
  const uniq = [...new Set(keys)].filter((k) => !EXCLUDE.has(k));

  assert.ok(uniq.length >= 10, `抽唔到足夠 toast key（只有 ${uniq.length} 條）`);

  const missing = uniq.filter((k) => !(k in EN_DICT));
  assert.deepEqual(missing, [], `toast key 冇英文翻譯（英文版會出中文）：\n  ${missing.join("\n  ")}`);
});

// ─── 🔴 第 3 層：紙單唔跟 UI 語言 ───────────────────────────────
test("🔴 第 3 層：出紙／預覽元件唔可以依賴 UI 語言", () => {
  // 紙單係畀客人睇嘅收款憑證，唔應該因為店員切咗語言就變英文（J 2026-10-07 拍板）。
  //
  // ⚠️ 2026-10-08 改：舊寫法係硬編 8 個「紙單 label」字串，檢查佢哋唔可以入字典。
  //    呢個係**假守衛**，兩邊都唔成立：
  //      ① 同一批字串有部分同時係正常 UI 文案。例：`菜品明細` 係
  //         `escpos-template.ts` 嘅**區塊名**（只喺 print-center 設定頁嘅區塊清單
  //         顯示，`escpos-render.ts` 從來冇印過呢個字），同時又係
  //         `online-orders.tsx` 詳情彈窗嘅分區標題 ⇒ 唔翻就係英文版漏一句。
  //      ② 真係會印上紙嘅字（`總計` / `折扣` / `服務費`…）本身已經喺字典入面
  //         （餐牌、結帳頁共用）—— 即係「紙單 label 唔准入字典」由一開始就
  //         同現實矛盾，佢捉唔到任何真 bug。
  //
  // 真正嘅不變量係：**出紙／預覽路徑唔可以呼叫 `t()`**。因為紙單係喺 renderer
  // 直接砌字串，只要佢唔 import i18n，字典點改都唔會影響出紙。
  const PAPER_RENDERERS = [
    "src/lib/escpos-render.ts",
    "src/lib/escpos-template.ts",
    "src/components/receipt-ticket-preview.tsx",
  ];
  const FORBIDDEN = ["@/lib/i18n", "i18n-dict", "useLang", "LangProvider", "lang-provider", "useT"];
  for (const f of PAPER_RENDERERS) {
    const code = stripComments(readSrc(f));
    for (const token of FORBIDDEN) {
      assert.ok(
        !code.includes(token),
        `${f} 依賴咗 \`${token}\` —— 紙單／螢幕預覽唔可以跟 UI 語言變（違反第 3 層）`,
      );
    }
  }
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

test("🔴 P1：側欄 label 用 tNav()（短譯文）而唔係 t()，且唔加 truncate", () => {
  // 病：2026-10-08 J 實機截圖 —— `t()` 嘅長譯文喺 56px 淨闊度**被直接裁走**
  // （`Members` → `Member`、`Sold out` → `Sold our`、`Printing` → `Printin`）。
  // 修法係改用側欄專用字典 `tNav()`（≤6 字母），**唔係**加 truncate。
  const code = stripComments(readSrc("src/components/app-sidebar.tsx"));
  assert.ok(code.includes("tNav(item.label)"), "側欄 label 應該經 tNav()（側欄專用短譯文）");
  // ⚠️ 唔可以用 `!code.includes("t(item.label)")` —— `tNav(item.label)` 內含
  // `t(item.label)` 子字串 ⇒ 會誤判。改為禁止「非 tNav 嘅裸調用」。
  assert.ok(!/[^N]\(\s*item\.label\s*\)/.test(code.replace(/tNav\(item\.label\)/g, "")),
    "側欄唔應該用 t(item.label) —— 會被裁字；應該用 tNav()");
  assert.ok(code.includes("tShort(item.short)"), "側欄 short 應該經 tShort()");
  assert.ok(code.includes('{t("設置")}'), "側欄設置連結應該翻譯");
  // 加 truncate = 主動剪字，唔係解決辦法
  assert.ok(!/className="[^"]*truncate/.test(code), "側欄唔可以加 truncate（會剪走文字）");
  // ⚠️ `<span>` 一定要 block：inline 唔會斷行 ⇒ `tNav` 將來加長都會被靜靜剪
  assert.ok(
    /<span className="block[^"]*">\s*\{tNav\(/.test(code),
    "側欄 label 個 span 要 block + break-words（inline 唔會斷行，會被靜靜剪）",
  );
});

test("🔴 側欄專用字典：英文全部 ≤6 字母 + 兩字典 key 對齊", () => {
  // 🔴 守「行為不變量」（實際字串長度），唔守「代碼字串」。
  // 桌面側欄淨內容闊 56px、text-xs(12px) ⇒ 6 字母大約係上限。
  const tooLong = Object.entries(SIDEBAR_EN_DICT).filter(([, en]) => en.length > 6);
  assert.deepEqual(
    tooLong.map(([zh, en]) => `${zh}=${en}(${[...en].length})`),
    [],
    "側欄英文標籤太長，會喺 56px 闊度被裁走",
  );
  // 繁中字典要完全對齊（漏咗就會 fallback 返 EN_DICT 嘅長譯文 ⇒ 又爆）
  const missZh = Object.keys(SIDEBAR_EN_DICT).filter((k) => !(k in SIDEBAR_ZH_DICT));
  assert.deepEqual(missZh, [], `側欄字典缺繁中：${missZh.join(" / ")}`);
  const orphanZh = Object.keys(SIDEBAR_ZH_DICT).filter((k) => !(k in SIDEBAR_EN_DICT));
  assert.deepEqual(orphanZh, [], `側欄字典有孤兒 key：${orphanZh.join(" / ")}`);
});

test("🔴 登出掣淨係顯示短文案（長譯文會喺 56px 摺成 4 行）", () => {
  // 病：2026-10-08 "Sign out of this role" 喺側欄摺成 4 行，把底部撑到成條好長。
  // J 指示：掣面淨係 "登出" / "Sign out"，完整語境放 `title`。
  const code = stripComments(readSrc("src/components/app-sidebar.tsx"));
  assert.ok(code.includes('<span title={t("以此身份登出")}>{t("登出")}</span>'),
    "登出掣應該係 <span title={完整語境}>{短文案}</span>");
  assert.equal(EN_DICT["登出"], "Sign out");
  // 🔴 唔可以用 `!code.includes('{t("以此身份登出")}')` —— `title={t("以此身份登出")}`
  // 本身含呢段子字串 ⇒ 永遠误判。改為：長文案只可以出現喺 `title=` / `aria-label=` 位置。
  const longAsText = /(^|[^=\w])\{t\("以此身份登出"\)\}/.test(
    code.replace(/title=\{t\("以此身份登出"\)\}/g, ""),
  );
  assert.ok(!longAsText, "長文案只可以出現喺 title/aria-label，唔可以係掣面文字");
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

test("🔴 唔可以 t() 一個「已填值」字串（永遠命中唔到字典 ⇒ 靜默漏譯）", () => {
  // 病（2026-10-08，orders 頁）：`orderCodeLabel(order)` 回 `取餐碼 005`，
  // 但字典 key 係 `取餐碼 {code}` ⇒ `t(orderCodeLabel(order))` 兩邊永遠唔相等，
  // `lookup()` 靜靜 fallback 返中文（英文版第一欄全部殘留中文）——
  // **唔會 throw、唔會報錯、唔會有 warning**，係最難發現嘅一種漏譯。
  //
  // 同類（都係「回已填值字串」）：`scheduledPickupRelativeText()`（`18 分鐘後`）、
  // `autoAcceptToast().message`（`已自動接單並已送廚：取餐碼 005`）。
  // ⚠️ 呢個 pattern 靜態掃描**捉唔到**（`t(someVar)` 睇唔出個 var 有冇填值），
  //    所以下面只釘死已知嘅幾支；新增同類函式時要自己補落 BANNED。
  //
  // 正確做法：加一支 `*Parts()` 回 `{ key, vars }`，顯示位 `t(parts.key, parts.vars)`。
  // 已經有：`orderCodeLabelParts()` / `scheduledPickupRelativeParts()` /
  // `paymentSummaryLabelParts()`（`已支付 {amount}`）。
  const BANNED: Array<[RegExp, string]> = [
    [/\bt\(\s*orderCodeLabel\s*\(/, "改用 orderCodeLabelParts() → t(parts.key, parts.vars)"],
    [/\bt\(\s*scheduledPickupRelativeText\s*\(/, "改用 scheduledPickupRelativeParts()"],
    [/\bt\(\s*paymentSummaryLabel\s*\(/, "改用 paymentSummaryLabelParts() → t(parts.key, parts.vars)"],
  ];
  const files = walkSrc("src/").filter((f) =>
    /from "@\/components\/lang-provider"/.test(readFileSync(f, "utf8")),
  );
  assert.ok(files.length > 5, `只掃到 ${files.length} 個檔，掃描範圍可能壞咗`);
  const hits: string[] = [];
  for (const f of files) {
    const code = stripComments(readFileSync(f, "utf8"));
    for (const [re, hint] of BANNED) {
      if (re.test(code)) {
        const line = code.slice(0, code.search(re)).split("\n").length;
        hits.push(`${f.replace(/\\/g, "/").split("/macauPosSystem/")[1]}:${line} → ${hint}`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    `t() 咗一個「已填值」字串（英文版會靜默殘留中文）：\n  ${hits.join("\n  ")}`,
  );
});

test("🔴 兩本字典嘅結構完整（object literal 真 parse + 位置正確）", () => {
  // 🔴 2026-10-08 病：注入字典 key 時用 `indexOf("export const SHORT_EN_DICT")` 定位，
  // 命中嘅係**檔案頂部 import 行** ⇒ 149 行插咗入 JSDoc 中間 → 整個檔案 lexing 爆。
  // 呢個守衛確保：`t()` 查嘅主字典真係一個可 parse 嘅 object literal，
  // 而補漏 block 一定喺 `ZH_HANT_DICT` / `EN_DICT` **內**（唔係另開字典）。
  const MARK = "P1 補漏 · device-settings / scan-mode-panel";
  for (const [file, name] of [
    ["src/lib/i18n-dict-zh.ts", "ZH_HANT_DICT"],
    ["src/lib/i18n-dict-en.ts", "EN_DICT"],
  ] as const) {
    const code = readSrc(file);
    // 抽主字典 literal（由宣告位置搵配對括號，唔可以用 indexOf 全名 ——
    // 會命中 import 行）
    const decl = `export const ${name}: Record<string, string> = {`;
    const start = code.indexOf(decl);
    assert.ok(start > 0, `${file} 搵唔到 ${name} 宣告`);
    const open = code.indexOf("{", start);
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
    const parsed = new Function(`return ${literal};`)() as Record<string, string>;
    assert.ok(Object.keys(parsed).length > 100, `${name} 字典好細（${Object.keys(parsed).length}）— 注入插錯位置？`);

    // 補漏 block 必須喺主字典 span 內
    const markIdx = code.indexOf(MARK);
    if (markIdx > 0) {
      assert.ok(markIdx > start && markIdx < end,
        `${file} 補漏 block 喺 ${name} 外面（start=${start} end=${end} mark=${markIdx}）`);
    }
  }
});

test("UI_LANGS：暫時 2 個（繁中 + 英文），預設繁中", () => {
  assert.equal(UI_LANGS.length, 2);
  assert.deepEqual([...UI_LANGS], ["zh-Hant", "en"]);
  assert.equal(DEFAULT_UI_LANG, "zh-Hant");
  for (const l of UI_LANGS) assert.equal(isUiLang(l), true);
});