/**
 * 精準改寫套用器（2026-10-08）。
 *
 * 讀一個 `[[old, new], …]` 表，逐條做**唯一字串替換**。
 * 每條都報「命中次數」，`0` 或者 `>1`（而冇標 replaceAll）都要人手覆核 ——
 * 唔可以靜默放過，因為「冇命中」通常代表上游 codemod 已經改過個位。
 *
 * 用法：`node tools/_apply-map.cjs <map.cjs> <target> [--write]`
 */
const fs = require("fs");
const path = require("path");

const ROOT = "C:/dev/macauPos/macauPosSystem";
const [mapFile, target] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const WRITE = process.argv.includes("--write");

const pairs = require(path.join(ROOT, mapFile));
const p = path.join(ROOT, target);
let code = fs.readFileSync(p, "utf8");

let ok = 0;
const problems = [];

for (const [oldText, newText] of pairs) {
  const n = code.split(oldText).length - 1;
  if (n === 0) {
    problems.push(`❌ 0 命中：${JSON.stringify(oldText).slice(0, 90)}`);
    continue;
  }
  if (n > 1) {
    problems.push(`⚠️ ${n} 命中（全部替換）：${JSON.stringify(oldText).slice(0, 90)}`);
  }
  code = code.split(oldText).join(newText);
  ok++;
}

console.log(`套用 ${ok}/${pairs.length} 條`);
for (const s of problems) console.log("  " + s);

if (WRITE) {
  fs.writeFileSync(p, code);
  console.log(`✅ 已寫入 ${target}`);
} else {
  console.log("（dry-run，加 --write 才寫）");
}
