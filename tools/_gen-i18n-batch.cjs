// 生成 i18n 批次字典行。用法：
//   node tools/_gen-i18n-batch.cjs <批號>
//   node tools/_gen-i18n-batch.cjs <批號> --check <來源檔…>   # 額外驗證覆蓋率
//
// 讀 ZH 字典 → 過濾已存在嘅 key → 印出可直接貼嘅 ZH / EN 行。
//
// 🔴 `--check` 係防「靜靜漏翻譯」嘅閘：對照來源檔實際用到嘅 key，
//    報告「來源有、但 pairs 檔冇提供譯文」嘅 key。冇呢個閘就只會寫出
//    你記得嘅嘢，漏咗嘅唔會有任何提示（2026-10-08 P2b 加）。
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");

function stripComments(src) {
  let out = "";
  let state = "code";
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
    const quote = state === "dq" ? '"' : state === "sq" ? "'" : "`";
    if (c === "\\") { out += c + (d ?? ""); i++; continue; }
    if (c === quote) state = "code";
    out += c;
  }
  return out;
}

function dictKeys(rel) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  const out = new Set();
  const re = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^\s:"][^\s:]*?))\s*:/;
  for (const line of src.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    out.add(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
  }
  return out;
}

/** 由來源檔抽 `t("…")` 嘅 key（同 `_t-keys-missing.cjs` 同一手法）。 */
function tKeysOf(rel) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  const out = new Set();
  const CALL = /\b(t|tShort|tNav)\s*\(\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = CALL.exec(src))) out.add(m[2].replace(/\\(.)/g, "$1"));
  return out;
}

const argv = process.argv.slice(2);
const BATCH = argv[0] || "3";
const checkIdx = argv.indexOf("--check");
const CHECK_FILES = checkIdx >= 0 ? argv.slice(checkIdx + 1) : [];

const PAIRS = JSON.parse(fs.readFileSync(path.join(__dirname, `_batch${BATCH}-pairs.json`), "utf8"));

const zh = dictKeys("src/lib/i18n-dict-zh.ts");
const en = dictKeys("src/lib/i18n-dict-en.ts");

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const needZh = [];
const needEn = [];
const skipped = [];

for (const [k, v] of Object.entries(PAIRS)) {
  const inZh = zh.has(k);
  const inEn = en.has(k);
  if (inZh && inEn) {
    skipped.push(k);
    continue;
  }
  if (!inZh) needZh.push(`  "${esc(k)}": "${esc(k)}",`);
  if (!inEn) needEn.push(`  "${esc(k)}": "${esc(v)}",`);
}

fs.writeFileSync(path.join(__dirname, `_batch${BATCH}-zh.txt`), needZh.join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(__dirname, `_batch${BATCH}-en.txt`), needEn.join("\n") + "\n", "utf8");

console.log(`總共 ${Object.keys(PAIRS).length} 個 key`);
console.log(`  已存在（跳過）：${skipped.length}${skipped.length ? " -> " + skipped.join(" / ") : ""}`);
console.log(`  要加 ZH：${needZh.length} 行  -> tools/_batch${BATCH}-zh.txt`);
console.log(`  要加 EN：${needEn.length} 行  -> tools/_batch${BATCH}-en.txt`);

if (CHECK_FILES.length) {
  const all = new Set([...zh, ...en]);
  const used = new Set();
  for (const f of CHECK_FILES) for (const k of tKeysOf(f)) used.add(k);

  const isCjk = (k) => /[一-鿿]/.test(k);
  // 來源用到、但字典冇、而 pairs 又冇提供 → 一定會漏
  const forgotten = [...used].filter((k) => isCjk(k) && !all.has(k) && !(k in PAIRS));
  // pairs 提供咗、但來源其實冇用 → 多餘（唔算錯，但值得知）
  const unused = Object.keys(PAIRS).filter((k) => !used.has(k) && !all.has(k));

  console.log(`\n── 覆蓋率檢查（--check）──`);
  console.log(`  來源檔用到嘅 key：${used.size}`);
  for (const f of CHECK_FILES) console.log(`    · ${f}`);
  if (forgotten.length) {
    console.log(`  ❌ 漏咗 ${forgotten.length} 個（來源有、字典冇、pairs 又冇提供）：`);
    for (const k of forgotten) console.log(`     ${JSON.stringify(k)}`);
  } else {
    console.log(`  ✅ 冇漏 —— 來源用到嘅中文 key 全部有譯文`);
  }
  if (unused.length) {
    console.log(`  ⚠️ pairs 多出 ${unused.length} 個（來源冇用，可能係死碼或改名）：`);
    for (const k of unused) console.log(`     ${JSON.stringify(k)}`);
  }
  if (forgotten.length) process.exitCode = 1;
}
