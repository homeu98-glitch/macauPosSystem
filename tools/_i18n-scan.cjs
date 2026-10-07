// 臨時：掃全 src/ 嘅 t("...") key，檢查有冇漏翻譯 / key 拼錯
const fs = require("fs");
const path = require("path");

const ROOT = "C:/dev/macauPos/macauPosSystem";
const en = fs.readFileSync(path.join(ROOT, "src/lib/i18n-dict-en.ts"), "utf8");
const zh = fs.readFileSync(path.join(ROOT, "src/lib/i18n-dict-zh.ts"), "utf8");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(path.join(ROOT, "src")).filter((f) => {
  if (/i18n-dict-|i18n\.ts$/.test(f)) return false;
  // 🔴 只查真正 import 咗 `useT` / `useTShort` 嘅檔案。
  // 其它地方（例如 order/page.tsx、kiosk/*）有自己嘅 `t`（kioskT），
  // 用英文 key，唔屬於本次 i18n 字典範圍 ⇒ 掃到佢哋會大量誤報。
  const code = fs.readFileSync(f, "utf8");
  return /from "@\/components\/lang-provider"/.test(code);
});
const RE = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g;
const map = new Map();
for (const f of files) {
  const code = fs.readFileSync(f, "utf8");
  for (const m of code.matchAll(RE)) {
    const k = m[1];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(path.relative(ROOT, f) + ":" + (code.slice(0, m.index).split("\n").length));
  }
}

const has = (dict, k) => dict.includes('"' + k + '"') || dict.includes(k + ":");
const missEn = [];
const missZh = [];
for (const [k, sites] of map) {
  if (/^[a-z0-9-]+$/.test(k) && !/[\u4e00-\u9fff]/.test(k)) continue; // 純 ascii key（多數係變數名）
  if (!has(en, k)) missEn.push([k, sites[0]]);
  if (!has(zh, k)) missZh.push([k, sites[0]]);
}
console.log("掃描 t() key 總數:", map.size);
console.log("\n=== 英文缺翻譯 (" + missEn.length + ") ===");
missEn.forEach(([k, s]) => console.log("  " + JSON.stringify(k) + "  @ " + s));
console.log("\n=== 繁中缺 identity (" + missZh.length + ") ===");
missZh.forEach(([k, s]) => console.log("  " + JSON.stringify(k) + "  @ " + s));
