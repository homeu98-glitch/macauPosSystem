const fs = require("fs");
const p = process.argv[2];
const src = fs.readFileSync(p, "utf8");
const lines = src.split(/\r?\n/);
let inBlock = false;
let n = 0;
lines.forEach((l, i) => {
  let s = l;
  if (inBlock) {
    if (s.includes("*/")) {
      inBlock = false;
      s = s.slice(s.indexOf("*/") + 2);
    } else return;
  }
  if (s.includes("/*")) {
    inBlock = !s.includes("*/");
    s = s.slice(0, s.indexOf("/*"));
  }
  s = s.replace(/\/\/.*$/, "");
  // 去掉已經包好嘅 t("…") 內容（唔算殘留）
  s = s.replace(/t\(\s*"(?:[^"\\]|\\.)*"/g, 't("«key»"');
  if (/[\u4e00-\u9fff]/.test(s)) {
    n++;
    console.log(String(i + 1).padStart(5) + ": " + s.trim().slice(0, 110));
  }
});
console.log(`\n總計 ${n} 行含非註解中文（未包 t 或非 key）`);
