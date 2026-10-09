/** 檢查一批 key 喺 EN_DICT / ZH_HANT_DICT 主字典入面有冇（診斷用）。 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function loadDict(rel, marker) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const start = src.indexOf(marker);
  const end = src.indexOf("\r\n};", start);
  const body = src.slice(start, end);
  // key 可能係 "xxx": 或 unquoted xxx:
  const keys = new Set();
  for (const m of body.matchAll(/^\s*("(?:[^"\\]|\\.)*"|[\w\u4e00-\u9fff][\w\u4e00-\u9fff]*)\s*:/gm)) {
    let k = m[1];
    if (k.startsWith('"')) k = JSON.parse(k);
    keys.add(k);
  }
  return keys;
}

const zh = loadDict("src/lib/i18n-dict-zh.ts", "export const ZH_HANT_DICT");
const en = loadDict("src/lib/i18n-dict-en.ts", "export const EN_DICT");

const candidates = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const missing = [];
const present = [];
for (const k of Object.keys(candidates)) {
  (zh.has(k) && en.has(k) ? present : missing).push(k);
}
console.log(`候選 ${Object.keys(candidates).length} · 已有 ${present.length} · 缺 ${missing.length}`);
console.log("\n=== 已有（唔會覆蓋）===");
for (const k of present) console.log("  " + k);
console.log("\n=== 缺 ===");
for (const k of missing) console.log("  " + k);
