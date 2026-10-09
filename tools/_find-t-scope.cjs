/**
 * 找出一個檔案內「邊幾個 top-level function 用咗 `t(...)`」，
 * 用嚟精準補 `const t = useT();`（唔想盲加落全部 component）。
 *
 * 用法：node tools/_find-t-scope.cjs src/components/restaurant-daily-report.tsx
 */
const fs = require("fs");
const path = require("path");
const ts = require(path.join("C:/dev/macauPos/macauPosSystem/node_modules/typescript"));

const ROOT = "C:/dev/macauPos/macauPosSystem";
const rel = process.argv[2];
const p = path.join(ROOT, rel);
const code = fs.readFileSync(p, "utf8");
const sf = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** top-level（SourceFile 直接子節點）嘅 function 宣告 */
const tops = [];
for (const stmt of sf.statements) {
  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
    tops.push({ name: stmt.name.text, node: stmt, body: stmt.body });
  } else if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && ts.isArrowFunction(d.initializer)) {
        tops.push({ name: d.name.text, node: d, body: d.initializer.body });
      }
    }
  }
}

const uses = new Map(); // name -> Set(lines)
const visit = (node) => {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "t"
  ) {
    // 搵最細嘅包住佢嘅 top-level function
    const pos = node.getStart(sf);
    let best = null;
    for (const top of tops) {
      const s = top.node.getStart(sf);
      const e = top.node.getEnd();
      if (pos >= s && pos <= e) {
        if (!best || top.node.getEnd() - top.node.getStart(sf) < best.node.getEnd() - best.node.getStart(sf)) {
          best = top;
        }
      }
    }
    const key = best ? best.name : "<module scope!>";
    if (!uses.has(key)) uses.set(key, []);
    uses.get(key).push(sf.getLineAndCharacterOfPosition(pos).line + 1);
  }
  ts.forEachChild(node, visit);
};
visit(sf);

console.log(`使用 t() 嘅 top-level function：${uses.size} 個\n`);
for (const [name, lines] of uses) {
  console.log(`${name.padEnd(30)} ${lines.length} 處  (行 ${lines[0]}…)`);
}

// 順便列出「完全冇用到 t」嘅 component，方便對照
const unused = tops.filter((x) => !uses.has(x.name)).map((x) => x.name);
console.log(`\n冇用到 t() 嘅 top-level function（${unused.length}）：`);
console.log("  " + unused.join(", "));
