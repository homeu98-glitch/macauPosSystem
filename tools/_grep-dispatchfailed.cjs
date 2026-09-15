// 全域搜「dispatch failed」真身：掃 C:/dev 全部文字檔（避開 node_modules/.git/build）
const fs = require("fs");
const path = require("path");

const ROOT = "C:/dev";
const SKIP_DIR = new Set(["node_modules", ".git", ".gradle", ".idea", ".kotlin", "build", "dist", ".next", "out", "coverage", ".workbuddy", ".workbuddy-ai"]);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|kt|kts|java|py|rs|go|cs|rb|php|swift|vue|svelte|json|md|yml|yaml|xml|gradle|pro|properties|html|css|scss)$/i;
const NEEDLE = /dispatch\s*failed/i;

const hits = [];
let scanned = 0;

(function walk(d, dep) {
  let es = [];
  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      if (dep > 8) continue;
      walk(p, dep + 1);
    } else {
      if (!TEXT_EXT.test(e.name)) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.size > 3_000_000) continue;
      let t = null;
      try { t = fs.readFileSync(p, "utf8"); } catch { continue; }
      scanned++;
      t.split(/\r?\n/).forEach((ln, i) => {
        if (NEEDLE.test(ln)) hits.push(p + ":" + (i + 1) + ": " + ln.trim().slice(0, 200));
      });
    }
  }
})(ROOT, 0);

console.log("scanned files =", scanned);
console.log(hits.length ? hits.join("\n") : "(C:/dev 全文本都搵唔到)");
