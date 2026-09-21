/**
 * 列出 Vercel log 內所有非空 message（去重），用嚟捉「應用層 error / warning」（2026-09-21）。
 * 唯讀。用法: node tools/_vc-messages-20260921.cjs "<vercel csv>"
 */
const fs = require("fs");
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
const rows = parseCsv(fs.readFileSync(process.argv[2], "utf8"));
const head = rows[0].map((h) => h.trim());
const iMsg = head.indexOf("message");
const iPath = head.indexOf("requestPath");
const iLv = head.indexOf("level");
const iT = head.indexOf("TimeUTC");
const seen = new Map();
for (let i = 1; i < rows.length; i += 1) {
  if (!rows[i].length) continue;
  const msg = (rows[i][iMsg] || "").trim();
  if (!msg) continue;
  const sig = msg.replace(/\d+/g, "<n>").slice(0, 240);
  if (!seen.has(sig)) seen.set(sig, { n: 0, path: rows[i][iPath], lv: rows[i][iLv], t: rows[i][iT], raw: msg });
  seen.get(sig).n += 1;
}
console.log("distinct message signatures =", seen.size);
for (const [sig, v] of [...seen].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`\n×${v.n}  [${v.lv || "-"}]  ${v.t}  ${v.path}`);
  console.log("   " + v.raw.slice(0, 300));
}
console.log("\nDONE");
