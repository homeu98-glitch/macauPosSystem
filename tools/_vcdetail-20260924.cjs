// Vercel: 按 requestId 去重後，列出指定 path 的請求（query + message）
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
const g = (r, n) => unq(r[I[n]]);
const mac = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(11, 19);

const byId = new Map();
for (const r of rows.slice(1)) {
  const id = g(r, "requestId"); if (!id) continue;
  if (!byId.has(id)) byId.set(id, { t: Number(g(r, "timestampInMs")), path: g(r, "requestPath"), qs: g(r, "requestQueryString"), ua: g(r, "requestUserAgent"), st: g(r, "responseStatusCode"), msgs: [] });
  const e = byId.get(id);
  const m = g(r, "message"); if (m) e.msgs.push(m);
}
const list = [...byId.values()].sort((a, b) => a.t - b.t);
const WANT = process.argv[3] || "";
console.log(`唯一請求 ${list.length}`);
if (process.argv[4] === "--dump") {
  for (const e of list.slice(0, 8)) console.log(JSON.stringify(e).slice(0, 400));
}
if (WANT === "--paths") {
  const c = {};
  for (const e of list) c[e.path] = (c[e.path] || 0) + 1;
  console.log(JSON.stringify(c, null, 1));
  process.exit(0);
}
for (const e of list) {
  if (WANT && !e.path.includes(WANT)) continue;
  console.log(`\n${mac(e.t)} ${e.st} ${e.path}${e.qs ? "?" + e.qs.slice(0, 160) : ""}  ua=${e.ua.slice(0, 30)}`);
  for (const m of e.msgs.slice(0, 14)) console.log(`      ${m.slice(0, 200)}`);
  if (e.msgs.length > 14) console.log(`      … 另 ${e.msgs.length - 14} 行`);
}
