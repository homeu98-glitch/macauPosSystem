const fs = require("fs");
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else if (c !== "\r") cur += c; }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const rows = parseCsv(fs.readFileSync(process.argv[2], "utf8")).filter((r) => r.length > 1);
const H = rows[0].map((h) => h.trim());
console.log("Vercel 欄位:", H.join(" | "));
const I = {}; H.forEach((h, i) => (I[h] = i));
const unq = (v) => (v == null ? "" : String(v).replace(/^"+|"+$/g, ""));
console.log("樣本:", JSON.stringify(rows[1].map(unq)).slice(0, 900));
