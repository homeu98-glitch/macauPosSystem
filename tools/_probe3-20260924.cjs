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
const H = rows[0].map((h) => h.trim()); const I = {}; H.forEach((h, i) => (I[h] = i));
const unq = (v) => (v == null ? "" : String(v).replace(/^"+|"+$/g, ""));
const items = rows.slice(1).map((r) => {
  const evt = unq(r[I["event_message"]]);
  return { t: Date.parse(unq(r[I["date"]])), method: unq(r[I["method"]]), url: evt.split(" | ")[2] || "", status: unq(r[I["status"]]) };
}).filter((x) => x.t).sort((a, b) => a.t - b.t);
const mac = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 19);

for (const key of process.argv.slice(3)) {
  const sel = items.filter((x) => x.url.includes(key));
  console.log(`\n### ${key}   n=${sel.length}  ${mac(sel[0]?.t)} → ${mac(sel[sel.length-1]?.t)}`);
  const gaps = [];
  for (let i = 1; i < sel.length; i++) gaps.push(Math.round((sel[i].t - sel[i-1].t) / 1000));
  console.log("   gap(s):", gaps.join(","));
}
