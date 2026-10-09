/**
 * 讀出 i18n 字典檔內每個 object literal 嘅 key（精準，唔靠 regex）。
 *
 * 用法：node tools/_dict-keys.cjs src/lib/i18n-dict-zh.ts
 * 輸出：每個 object 一行 JSON key 陣列 + 全部 key 嘅聯集（方便同新 key 對比）。
 */
const fs = require("fs");
const path = require("path");
const ts = require(path.join("C:/dev/macauPos/macauPosSystem/node_modules/typescript"));

const ROOT = "C:/dev/macauPos/macauPosSystem";
const rel = process.argv[2];
const sf = ts.createSourceFile(
  rel,
  fs.readFileSync(path.join(ROOT, rel), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

const all = new Set();
for (const stmt of sf.statements) {
  if (!ts.isVariableStatement(stmt)) continue;
  for (const d of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isObjectLiteralExpression(d.initializer)) continue;
    const keys = [];
    for (const prop of d.initializer.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const n = prop.name;
        if (ts.isIdentifier(n)) keys.push(n.text);
        else if (ts.isStringLiteral(n)) keys.push(n.text);
      }
    }
    keys.forEach((k) => all.add(k));
    console.log(`\n=== ${d.name.text} (${keys.length}) ===`);
    console.log(JSON.stringify(keys));
  }
}
console.log(`\n=== 聯集 ${all.size} ===`);
console.log(JSON.stringify([...all]));
