// 臨時工具：撳出指定檔案入面所有 t("...") / t(`...`) 字串，同 ZH/EN 字典比對。
const fs = require("fs");
const path = require("path");

const files = process.argv.slice(2);
const dictDir = path.join(__dirname, "..", "src", "lib");

function loadDict(file) {
  const src = fs.readFileSync(path.join(dictDir, file), "utf8");
  // 抽取 Record<string, string> 入面嘅 key：支援 裸key: / "key": / 'key':
  const keys = new Set();
  const re = /(?:^|\n)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*))\s*:\s*(?:")/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    keys.add((m[1] ?? m[2] ?? m[3]).replace(/\\"/g, '"'));
  }
  return keys;
}

const zh = loadDict("i18n-dict-zh.ts");
const en = loadDict("i18n-dict-en.ts");

// 由 SHORT dict 額外攞（單字徽章）—— 避免誤報
function loadShort(file) {
  const src = fs.readFileSync(path.join(dictDir, file), "utf8");
  const keys = new Set();
  const re = /(?:^|\n)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*))\s*:\s*"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    keys.add((m[1] ?? m[2] ?? m[3]).replace(/\\"/g, '"'));
  }
  return keys;
}
const zhShort = loadShort("i18n-dict-zh.ts");
const enShort = loadShort("i18n-dict-en.ts");

const tRe = /\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const found = new Set();
  let m;
  while ((m = tRe.exec(src)) !== null) {
    found.add((m[1] ?? m[2]).replace(/\\"/g, '"'));
  }
  console.log("=== " + f + " ===");
  const sorted = [...found].sort();
  for (const k of sorted) {
    const inZh = zh.has(k) || zhShort.has(k);
    const inEn = en.has(k) || enShort.has(k);
    if (!inZh || !inEn) {
      console.log(`  MISSING zh=${inZh} en=${inEn} :: ${k}`);
    }
  }
  console.log(`  (checked ${sorted.length} keys)`);
}
