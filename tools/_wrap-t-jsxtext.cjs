/**
 * AST 版 `t()` 包裹 —— **第 2 版：混合 children 嘅 JsxText**（2026-10-08）。
 *
 * ## 同第 1 版（`_wrap-t-ast.cjs`）嘅分別
 *
 * 第 1 版有條保守安全閘：「父元素嘅 children 全部都要係 JsxText 先翻」。
 * 結果 `pos-app.tsx` 有 56 處**被跳過**，全部係呢種形狀：
 *
 *     <span>{n} 張待重結</span>
 *     <span>備註：{item.note}</span>
 *     <p>平台單作廢（覆寫）：<b>{t("…")}</b>（含已結帳／已完成）。</p>
 *
 * ## 點解可以逐個 JsxText 包（安全論證）
 *
 * JSX 會將 JsxText **先做一次空白正規化**（Babel `cleanJSXElementLiteralChild`）：
 *   · 每行去掉行首空白（第一行除外）同行尾空白（最後一行除外）；
 *   · 非最後一個非空行補一個空格；
 *   · 純空白行丟棄。
 *
 * ⇒ 原始 raw 渲染出嚟嘅字串 = `rendered`。我哋直接寫 `{t("rendered")}`，
 *    輸出嘅就係 `rendered` 本身 —— **渲染結果逐字節相同**，所以無論
 *    有冇 `whitespace-pre-wrap`（CSS 唔影響 JSX 解析）都安全。
 *
 * 呢個係「等價變換」，唔係「近似」。
 *
 * ## 仍然會跳過
 *
 *   · `rendered` 冇 CJK（純英文／數字／符號）；
 *   · `rendered.trim()` 為空；
 *   · JsxText 住喺 `<style>` / `<script>` 裡面（唔係文案）。
 */
const fs = require("fs");
const path = require("path");
const ts = require(path.join("C:/dev/macauPos/macauPosSystem/node_modules/typescript"));

const ROOT = "C:/dev/macauPos/macauPosSystem";
const WRITE = process.argv.includes("--write");
const TARGETS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FILES = TARGETS.length ? TARGETS : ["src/components/pos-app.tsx"];

const hasCJK = (s) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s);
const SKIP_TAGS = new Set(["style", "script"]);

/**
 * Babel `cleanJSXElementLiteralChild` 嘅忠實實作。
 * 輸入係 JsxText 嘅 raw source text，輸出係 JSX 實際會渲染嘅字串。
 */
function jsxRenderedText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i])) lastNonEmpty = i;
  }
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\t/g, " ");
    const isFirst = i === 0;
    const isLast = i === lines.length - 1;
    if (!isFirst) line = line.replace(/^ +/, "");
    if (!isLast) line = line.replace(/ +$/, "");
    if (line) {
      if (i !== lastNonEmpty) line += " ";
      out += line;
    }
  }
  return out;
}

let grandApplied = 0;
const grandSkipped = [];

for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  const code0 = fs.readFileSync(p, "utf8");
  const sf = ts.createSourceFile(rel, code0, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const skipped = [];

  const tagStack = [];
  const visit = (node) => {
    const pushed = ts.isJsxElement(node);
    if (pushed) {
      const opening = node.openingElement;
      const name = opening.tagName && ts.isIdentifier(opening.tagName) ? opening.tagName.text : "";
      tagStack.push(name.toLowerCase());
    }

    if (ts.isJsxText(node)) {
      const inSkipped = tagStack.some((t) => SKIP_TAGS.has(t));
      const raw = node.getText(sf);
      const rendered = jsxRenderedText(raw);
      if (inSkipped) {
        // 唔出聲：<style>/<script> 內容
      } else if (!rendered.trim()) {
        // 純空白，唔出聲
      } else if (!hasCJK(rendered)) {
        // 純英文／數字，唔出聲
      } else {
        edits.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          newText: `{t(${JSON.stringify(rendered)})}`,
          key: rendered,
        });
      }
    }

    ts.forEachChild(node, visit);
    if (pushed) tagStack.pop();
  };
  visit(sf);

  const out = edits.length
    ? code0.slice(0, edits[0].start) +
      edits
        .map((e, i) => e.newText + code0.slice(e.end, edits[i + 1] ? edits[i + 1].start : code0.length))
        .join("")
    : code0;

  grandApplied += edits.length;
  if (skipped.length) grandSkipped.push(...skipped);

  console.log(`\n### ${rel}`);
  console.log(`  包咗 ${edits.length} 處 JsxText`);
  for (const e of edits) console.log(`    + ${JSON.stringify(e.key)}`);
  if (WRITE) {
    fs.writeFileSync(p, out);
    console.log(`  ✅ 已寫入 ${rel}`);
  }
}

console.log(`\n=== 總計：${grandApplied} 處${WRITE ? "（已寫入）" : "（dry-run，加 --write 才寫）"} ===`);
if (grandSkipped.length) console.log(`跳過 ${grandSkipped.length} 處`);
