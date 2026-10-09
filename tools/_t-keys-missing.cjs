#!/usr/bin/env node
/**
 * 掃一個（或幾個）檔案，列出所有 `t("…")` / `tShort("…")` / `tNav("…")` 用嘅 key，
 * 同字典對照，報告**字典冇嘅 key**（＝會 fallback 返中文，即係漏翻譯）。
 *
 * 用法：
 *   node tools/_t-keys-missing.cjs src/components/restaurant-daily-report.tsx
 *   node tools/_t-keys-missing.cjs src/components/pos-app.tsx --all
 *
 * `--all` = 連字典已經有嘅 key 都列出（睇 coverage 用）。
 *
 * ## ⚠️ 呢個工具唔取代 `i18n-layer-guard.test.ts`
 *
 * 權威守衛係 `src/lib/i18n-layer-guard.test.ts` 嘅
 * 「🔴 全專案 t() 嘅 key 必須喺兩本字典都有」—— 佢掃全 `src/`、會 strip 註解，
 * 而且 `npm test` 一定會跑。呢個工具係**開發期診斷**（單檔、帶行號、有統計）。
 *
 * ## 呢個工具多咗一樣守衛睇唔到嘅嘢
 *
 * 🔴 **動態 key**：`setLedgerError("尚未連線 Ledger…")` → `t(ledgerError)`
 * 呢種「key 經 state 傳入」嘅寫法，兩邊都靜態掃唔到（守衛只認 `t("字面值")`）。
 * 漏咗字典 key 就會靜靜出中文、冇任何 error —— 2026-10-08 真實踩過。
 * 所以呢個工具會**額外列出**動態 key，逼你人手覆核。
 *
 * ## 為何唔用 AST
 *
 * 呢個係一次性診斷工具，唔係 codemod。字典檔本身有 unquoted key
 * （`取消: "取消"`）同**跨行 value**，用 regex 逐行掃比 AST 更簡單可靠。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

/**
 * 剝註解（但**保留行號** —— 用空格頂替，換行照留）。
 *
 * 🔴 為何一定要剝：註解入面成日有示例 code。
 *  - `// {t(activeTable?.name)}` → 會被當成「動態 key」假警報
 *  - `// 說明: 中文` → 字典 key 抽取會抽出 `// 說明` 呢個假 key
 * （2026-10-08 兩樣都真實踩過。）
 *
 * 手寫狀態機而唔用 regex：要正確跳過字串入面嘅 `//`（例：`"https://…"`）。
 */
function stripComments(src) {
  let out = "";
  let state = "code"; // code | line | block | dq | sq | tpl
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1];
    if (state === "code") {
      if (c === "/" && d === "*") { state = "block"; out += "  "; i++; continue; }
      if (c === "/" && d === "/") { state = "line"; out += "  "; i++; continue; }
      if (c === '"') state = "dq";
      else if (c === "'") state = "sq";
      else if (c === "`") state = "tpl";
      out += c;
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; out += "  "; i++; continue; }
      out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; continue; }
      out += " ";
      continue;
    }
    // 字串狀態：只認同款引號結尾
    const quote = state === "dq" ? '"' : state === "sq" ? "'" : "`";
    if (c === "\\") { out += c + (d ?? ""); i++; continue; }
    if (c === quote) state = "code";
    out += c;
  }
  return out;
}

/** 由字典檔抽 key（支援 quoted / unquoted key、跨行 value）。 */
function dictKeys(rel) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  const out = new Set();
  // 只認「行首（可縮排）就係 key，後面跟冒號」嘅行。
  // 跨行 value 嘅續行係 `"…",`（尾隨逗號）→ 唔會誤判成 key。
  // ⚠️ unquoted key 唔一定係 ASCII —— 呢個 repo 有 `取消: "取消"` / `連接埠: "連接埠"`
  //    （打印機區塊），所以唔可以寫 `[A-Za-z_$]`，要收任何「冇引號冇冒號」嘅字。
  const re = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^\s:"][^\s:]*?))\s*:/;
  for (const line of src.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    const raw = m[1] !== undefined ? m[1] : m[2];
    out.add(m[1] !== undefined ? raw.replace(/\\(.)/g, "$1") : raw);
  }
  return out;
}

/**
 * 由原始碼抽 `t("…")` 用嘅 key。
 *
 * ⚠️ 手寫 scanner 而唔用 regex：要正確跳過字串內嘅 `\"`，
 * 同埋要跨行搵到 `t(\n  "…"` 呢種寫法。
 *
 * 🔴 同時記錄 `t(<變數>)` —— 呢啲**靜態驗證唔到**，係呢個工具嘅盲點：
 *    例：`setLedgerError("尚未連線 Ledger…")` 之後 `t(ledgerError)`，
 *    個 key 唔會以 `t("…")` 形式出現。盲點一定要講出嚟，
 *    否則「0 missing」會畀人一種假嘅安全感（2026-10-08 真實踩過）。
 */
function tKeys(src) {
  const out = [];
  const dyn = [];
  const CALL = /\b(t|tShort|tNav)\s*\(/g;
  let m;
  while ((m = CALL.exec(src))) {
    let i = m.index + m[0].length;
    // 跳過空白（含換行）
    while (i < src.length && /\s/.test(src[i])) i++;
    const line = src.slice(0, m.index).split("\n").length;
    if (src[i] !== '"') {
      // 動態 key：變數 / 模板字串 / 表達式 —— 靜態睇唔到，記低提醒人手覆核。
      const rest = src.slice(i, i + 60).split("\n")[0];
      if (rest && !/^\s*\)/.test(rest)) dyn.push({ fn: m[1], expr: rest.trim(), line });
      continue;
    }
    i++;
    let buf = "";
    let closed = false;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        buf += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') {
        closed = true;
        break;
      }
      if (c === "\n") break; // 未閉合 → 唔當係 key
      buf += c;
      i++;
    }
    if (closed) out.push({ fn: m[1], key: buf, line });
  }
  return { out, dyn };
}

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const files = args.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  console.error("用法：node tools/_t-keys-missing.cjs <檔案…> [--all]");
  process.exit(2);
}

const zh = dictKeys("src/lib/i18n-dict-zh.ts");
const en = dictKeys("src/lib/i18n-dict-en.ts");
const shortZh = dictKeys("src/lib/i18n-dict-zh.ts"); // short/nav 字典同檔，下面用 name 過濾
const allKeys = new Set([...zh, ...en, ...shortZh]);

let grandMissing = 0;
let grandDyn = 0;

for (const f of files) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, f), "utf8"));
  const { out: keys, dyn } = tKeys(src);
  const uniq = new Map();
  for (const k of keys) {
    if (!uniq.has(k.key)) uniq.set(k.key, k);
  }

  const missing = [...uniq.values()].filter((k) => !allKeys.has(k.key));
  const present = [...uniq.values()].filter((k) => allKeys.has(k.key));

  console.log(`\n### ${f}`);
  console.log(`  t() 呼叫 ${keys.length} 個 · 唔同 key ${uniq.size} 個`);
  console.log(`  ✅ 字典有：${present.length}`);
  console.log(`  ❌ 字典冇（會 fallback 中文）：${missing.length}`);

  if (missing.length) {
    grandMissing += missing.length;
    for (const k of missing.sort((a, b) => a.line - b.line)) {
      console.log(`     L${k.line}  ${k.fn}(${JSON.stringify(k.key)})`);
    }
  }

  if (dyn.length) {
    grandDyn += dyn.length;
    console.log(`  ⚠️ 動態 key（靜態驗證唔到，要人手覆核）：${dyn.length}`);
    for (const d of dyn.sort((a, b) => a.line - b.line)) {
      console.log(`     L${d.line}  ${d.fn}(${d.expr})`);
    }
  }

  if (showAll && present.length) {
    console.log("  --- 已有嘅 key ---");
    for (const k of present.sort((a, b) => a.line - b.line)) {
      console.log(`     L${k.line}  ${k.fn}(${JSON.stringify(k.key)})`);
    }
  }
}

console.log(`\n=== 總計：${grandMissing} 個 key 未入字典 · ${grandDyn} 個動態 key 要人手覆核 ===`);
if (grandDyn) {
  console.log("    （動態 key 嘅來源：`setXxxError(\"…\")` → `t(xxxError)` 呢類 state 傳遞）");
}
process.exit(grandMissing > 0 ? 1 : 0);
