/**
 * AST 版批量 t() 包裹（安全版，2026-10-08）。
 *
 * 🔴 兩版失敗記錄（唔好重蹈）：
 *  ① regex `>中文<` → 匹配到 `>{cond && "文案"}<` 動態表達式 ⇒ 幾十處 TS1003。
 *  ② AST 全量 → JSX 文字被 `{expr}` 斬開，產生 `個菜品 · 第 ` / `台機）` 呢類
 *     **碎片 key**，翻譯會斷句（「個菜品 · 第 」／「 頁（每頁 」）。
 *
 * ✅ 呢版嘅安全閘：**只有「父元素嘅 children 全部都係 JsxText」嘅文字節點先翻**
 * —— 即係呢段文字喺 JSX 裡係**獨立完整**嘅一句，唔會同鄰近 expression 拼成一句。
 * 混合 expression 嘅（會被斬碎）一律跳過並報告，交人手處理。
 */
const fs = require("fs");
const path = require("path");
const ts = require(path.join("C:/dev/macauPos/macauPosSystem/node_modules/typescript"));

const ROOT = "C:/dev/macauPos/macauPosSystem";
const WRITE = process.argv.includes("--write");
const TARGETS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FILES = TARGETS.length ? TARGETS : ["src/components/device-settings.tsx"];

/**
 * 會包 `t()` 嘅 JSX 屬性白名單。
 *
 * 🔴 `label` / `subtitle` / `tag` 一定要收：本 repo 好多卡片係
 * `<Kpi label="營業額" subtitle="線下 …" />` 咁傳文案（唔係 JsxText），
 * 唔收就會漏一大批（2026-10-08 報表頁實測：KPI 卡標題全部漏）。
 * ⚠️ 但呢啲屬性**偶爾會載資料值**（例：`label={someBusinessValue}`）——
 * 只包**字面量**（`ts.isStringLiteral`），動態 expression 一律唔掂。
 */
const ATTRS = new Set([
  "title",
  "placeholder",
  "aria-label",
  "alt",
  "description",
  "label",
  "subtitle",
  "tag",
  "hint",
  "caption",
]);
const hasCJK = (s) => /[一-鿿]/.test(s);

let grandApplied = 0;
const grandSkipped = [];

for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  const code0 = fs.readFileSync(p, "utf8");
  const sf = ts.createSourceFile(rel, code0, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const skipped = new Set();

  const visit = (node) => {
    // ── 屬性：title="中文"（永遠安全，冇 expr 混雜問題）──
    if (ts.isJsxAttribute(node) && node.name && ATTRS.has(node.name.text) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init) && hasCJK(init.text)) {
        edits.push({ start: init.getStart(sf), end: init.getEnd(), newText: `{t(${JSON.stringify(init.text)})}`, label: "@" + node.name.text });
      }
    }

    // ── JSX 元素：檢查 children 是否「純文字」──
    if (ts.isJsxElement(node)) {
      const kids = node.children.filter(
        (c) => !(ts.isJsxText(c) && c.getText(sf).trim() === ""),
      );
      const pureText = kids.length > 0 && kids.every((c) => ts.isJsxText(c));
      for (const c of kids) {
        if (!ts.isJsxText(c)) continue;
        const raw = c.getText(sf);
        const trimmed = raw.trim();
        if (!trimmed || !hasCJK(trimmed)) continue;
        if (trimmed.includes("\n")) {
          // raw 有縮排換行係正常 JSX 寫法；trim 後單行就 OK
          skipped.add("[trim 後仍多行] " + trimmed.slice(0, 50));
          continue;
        }
        if (!pureText) {
          // ⚠️ 同 expression 混喺同一個父元素 ⇒ 會被斬碎，唔翻
          skipped.add("[混合 expression] " + trimmed.slice(0, 50));
          continue;
        }
        edits.push({
          start: c.getStart(sf),
          end: c.getEnd(),
          newText: raw.replace(trimmed, `{t(${JSON.stringify(trimmed)})}`),
          label: "JsxText",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // 由後往前套用
  edits.sort((a, b) => b.start - a.start);
  let code = code0;
  let applied = 0;
  let guard = Infinity;
  for (const e of edits) {
    if (e.end > guard) continue;
    code = code.slice(0, e.start) + e.newText + code.slice(e.end);
    guard = e.start;
    applied++;
  }
  grandApplied += applied;
  grandSkipped.push(...[...skipped].map((s) => rel + " → " + s));

  console.log(`${rel}\n  套用 ${applied} 處，跳過 ${skipped.size} 處`);
  if (WRITE && applied > 0) {
    fs.writeFileSync(p, code);
    console.log("  已寫入");
  }
}

console.log("\n總共套用 " + grandApplied + " 處");
if (grandSkipped.length) {
  console.log("\n跳過（要人手處理，因為會被 expression 斬碎）：");
  grandSkipped.forEach((s) => console.log("  " + s));
}