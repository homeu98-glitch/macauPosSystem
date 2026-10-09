#!/usr/bin/env node
/**
 * i18n 存量盤點（AST）—— 列出一個檔案內**所有**含中文嘅顯示文案，並分類。
 *
 * 用法：
 *   node tools/_i18n-inventory.cjs src/components/pos-app.tsx
 *   node tools/_i18n-inventory.cjs src/components/pos-app.tsx --kind js      # 只看某類
 *   node tools/_i18n-inventory.cjs src/components/pos-app.tsx --layer2       # 只看疑似第 2 層
 *
 * ## 為何需要（同 `_wrap-t-ast.cjs` 嘅分別）
 *
 * `_wrap-t-ast.cjs` 只包「JsxText」＋「ATTRS 白名單嘅字面量屬性」。
 * 但一個真實頁面嘅文案仲散落喺：
 *   - JS 字串／模板字串（`toast.error("…")`、`setError("…")`、confirm 文案）
 *   - 物件屬性值（`{ title: "…", body: "…" }`）
 *   - `ATTRS` 以外嘅 JSX 屬性（`confirmText=`、`okLabel=` …）
 *   - 三元／條件運算式
 *
 * 呢個工具**唔改檔**，只係盤點 + 分類，方便規劃批次同**揾出第 2 層地雷**。
 *
 * ## 🔴 第 2 層啟發式（`--layer2`）
 *
 * 冇辦法自動判斷「呢個中文字係唔係持久化資料值」，所以呢度只做**啟發式**：
 * 同一個字面量出現喺比較／賦值語境（`===` / `!==` / `x: "…"` / `.includes("…")`），
 * 或者個名似 enum（`status` / `tableName` / `paymentMethod` / `type` …）就標記。
 * **標記唔等於確定** —— 一定要人手睇。
 */
const fs = require("node:fs");
const path = require("node:path");
const ts = require(path.join("C:/dev/macauPos/macauPosSystem/node_modules/typescript"));

const ROOT = "C:/dev/macauPos/macauPosSystem";
const args = process.argv.slice(2);
const ONLY_KIND = (() => {
  const i = args.indexOf("--kind");
  return i >= 0 ? args[i + 1] : null;
})();
const ONLY_LAYER2 = args.includes("--layer2");
const files = args.filter((a) => !a.startsWith("--") && a !== ONLY_KIND);

if (!files.length) {
  console.error("用法：node tools/_i18n-inventory.cjs <檔案…> [--kind js|jsxtext|attr] [--layer2]");
  process.exit(2);
}

const hasCJK = (s) => /[一-鿿]/.test(s);

/** 似「持久化 enum 屬性名」嘅 key（賦值語境下出現就標 Layer 2 嫌疑）。 */
const ENUMISH = /^(status|tableName|tableId|zoneId|zoneName|type|kind|brand|paymentMethod|paymentMode|role|scope|categoryId|menuItemId|storeId|name|unit|mode)$/;

for (const rel of files) {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const sf = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rows = [];

  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  /**
   * 一個字面量係唔係「已經被 t() 包住」？向上望兩層有冇 CallExpression callee 係 t/tShort/tNav。
   */
  const alreadyWrapped = (node) => {
    let cur = node;
    for (let i = 0; i < 3 && cur; i++) {
      const p = cur.parent;
      if (!p) break;
      if (
        ts.isCallExpression(p) &&
        ts.isIdentifier(p.expression) &&
        ["t", "tShort", "tNav"].includes(p.expression.text)
      ) {
        return true;
      }
      cur = p;
    }
    return false;
  };

  /** 向上判斷語境，畀 Layer-2 啟發式用。 */
  const contextOf = (node) => {
    let cur = node;
    for (let i = 0; i < 4 && cur; i++) {
      const p = cur.parent;
      if (!p) break;
      if (ts.isBinaryExpression(p) && ["===", "!==", "==", "!="].includes(p.operatorToken.getText(sf))) {
        return { kind: "compare", detail: p.getText(sf).slice(0, 70) };
      }
      if (ts.isPropertyAssignment(p)) {
        const key = p.name.getText(sf).replace(/["']/g, "");
        return { kind: "prop", detail: key, enumish: ENUMISH.test(key) };
      }
      if (
        ts.isCallExpression(p) &&
        ts.isPropertyAccessExpression(p.expression) &&
        p.expression.name.text === "includes"
      ) {
        return { kind: "includes", detail: p.getText(sf).slice(0, 70) };
      }
      cur = p;
    }
    return null;
  };

  const push = (node, kind, text) => {
    const ctx = contextOf(node);
    rows.push({
      line: lineOf(node),
      kind,
      text,
      wrapped: alreadyWrapped(node),
      ctx,
    });
  };

  const visit = (node) => {
    // JSX 文字
    if (ts.isJsxText(node)) {
      const t = node.getText(sf).trim();
      if (t && hasCJK(t)) push(node, "jsxtext", t);
    }
    // JSX 屬性（任何屬性，唔限 ATTRS）—— 只認字面量
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const t = node.initializer.text;
      if (hasCJK(t)) push(node.initializer, "attr:" + (node.name?.getText(sf) ?? "?"), t);
    }
    // 字串 / 模板字串
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const isJsxAttrInit =
        node.parent && ts.isJsxAttribute(node.parent) && node.parent.initializer === node;
      const isJsxTextChild = false;
      if (!isJsxAttrInit && !isJsxTextChild && hasCJK(node.text)) push(node, "js", node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const shown = rows.filter((r) => {
    if (ONLY_KIND) {
      if (ONLY_KIND === "js" && r.kind !== "js") return false;
      if (ONLY_KIND === "jsxtext" && r.kind !== "jsxtext") return false;
      if (ONLY_KIND === "attr" && !r.kind.startsWith("attr:")) return false;
    }
    if (ONLY_LAYER2) {
      const s = r.ctx && (r.ctx.kind === "compare" || r.ctx.kind === "includes" || (r.ctx.kind === "prop" && r.ctx.enumish));
      if (!s) return false;
    }
    return true;
  });

  const byKind = {};
  for (const r of rows) {
    const k = r.kind.startsWith("attr:") ? "attr" : r.kind;
    byKind[k] = (byKind[k] || 0) + 1;
  }
  const unwrapped = rows.filter((r) => !r.wrapped).length;
  const suspects = rows.filter(
    (r) => r.ctx && (r.ctx.kind === "compare" || r.ctx.kind === "includes" || (r.ctx.kind === "prop" && r.ctx.enumish)),
  );

  console.log(`\n### ${rel}`);
  console.log(`  含中文顯示文案總數：${rows.length}`);
  console.log(`  分類：${JSON.stringify(byKind)}`);
  console.log(`  未包 t()：${unwrapped} ／ 已包：${rows.length - unwrapped}`);
  console.log(`  ⚠️ 第 2 層嫌疑（比較／includes／enum-ish 賦值）：${suspects.length}`);

  console.log(`\n  --- 列出 ${shown.length} 條 ---`);
  for (const r of shown) {
    const flag = r.wrapped ? "✅" : "  ";
    const l2 = r.ctx && (r.ctx.kind === "compare" || r.ctx.kind === "includes" || (r.ctx.kind === "prop" && r.ctx.enumish));
    const tag = l2 ? ` 🔴L2?[${r.ctx.kind}:${r.ctx.detail}]` : "";
    console.log(`  ${flag} L${r.line} [${r.kind}] ${JSON.stringify(r.text).slice(0, 90)}${tag}`);
  }
}
