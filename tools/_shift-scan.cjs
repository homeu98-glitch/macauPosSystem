const fs = require("fs");
const src = fs.readFileSync("src/components/shift-page.tsx", "utf8").replace(/\r\n/g, "\n");
const lines = src.split("\n");
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
const isComment = (s) => /^(\/\/|\*|\/\*|\{\/\*|\*\/)/.test(s);
const out = [];
lines.forEach((ln, i) => {
  const s = ln.trim();
  if (!CJK.test(ln)) return;
  if (isComment(s)) return;
  const stripped = ln.replace(/t\(\s*"((?:[^"\\]|\\.)*)"\s*(?:,[^)]*)?\)/g, "");
  if (CJK.test(stripped)) out.push([i + 1, s]);
});
console.log("UNWRAPPED CODE CJK lines: " + out.length);
out.forEach(([n, s]) => console.log(String(n).padStart(5) + "  " + s));
