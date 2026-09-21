/**
 * 由 Vercel log 反查「邊部機／邊個瀏覽器」在拉全量 state（2026-09-21）。唯讀。
 * 用法: node tools/_egress-who-20260921.cjs "<vercel csv>"
 */
const fs = require("fs");
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function toObjects(rows) {
  const head = rows[0].map((h) => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    if (!rows[i].length || (rows[i].length === 1 && !rows[i][0])) continue;
    const o = {};
    head.forEach((h, j) => (o[h] = rows[i][j]));
    out.push(o);
  }
  return out;
}
const raw = toObjects(parseCsv(fs.readFileSync(process.argv[2], "utf8")));
const byId = new Map();
for (const r of raw) {
  const id = r.requestId || JSON.stringify(r).slice(0, 80);
  const prev = byId.get(id);
  if (!prev || (r.message || "").length > (prev.message || "").length) byId.set(id, r);
}
const rows = [...byId.values()];

/** 每個 IP 嘅所有請求（唔限 egress）—— 睇得出同一部機仲打咗咩。 */
const ipOf = (r) => {
  const m = /ip=([0-9.]+)/.exec(r.message || "");
  return m ? m[1] : null;
};
const paths = new Map(); // path → {ips:Set, uas:Set, n}
for (const r of rows) {
  const p = String(r.requestPath || "").replace("macau-pos-system.vercel.app", "");
  if (!paths.has(p)) paths.set(p, { n: 0, uas: new Map() });
  const g = paths.get(p);
  g.n += 1;
  const ua = (r.requestUserAgent || "-").slice(0, 120);
  g.uas.set(ua, (g.uas.get(ua) || 0) + 1);
}

console.log("=== /api/pos/state 請求嘅 User-Agent 分佈 ===");
const egressRows = rows.filter((r) => /\[egress\]\s+pos\/state/.test(r.message || ""));
const byUa = new Map();
for (const r of egressRows) {
  const ip = ipOf(r) ?? "(no-ip)";
  const skip = /skipQueue=1/.test(r.message) ? "skipQueue=1" : "skipQueue=0";
  const queue = (/queue=(\d+)/.exec(r.message) || [, "?"])[1];
  const key = `${ip}  ${skip}  queue=${queue}  ${(r.requestUserAgent || "-").slice(0, 90)}`;
  if (!byUa.has(key)) byUa.set(key, { n: 0, first: r.TimeUTC, last: r.TimeUTC, bytes: 0 });
  const g = byUa.get(key);
  g.n += 1;
  g.bytes += Number((/bytes=(\d+)/.exec(r.message) || [, 0])[1]);
  if (r.TimeUTC < g.first) g.first = r.TimeUTC;
  if (r.TimeUTC > g.last) g.last = r.TimeUTC;
}
for (const [key, g] of [...byUa].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`\n  ×${g.n}  ${(g.bytes / 1048576).toFixed(2)} MB  ${g.first} → ${g.last}`);
  console.log(`     ${key}`);
}

console.log("\n=== 全部 route 嘅 User-Agent（睇邊部機最活躍）===");
for (const [p, g] of [...paths].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
  console.log(`\n  ${p}  (${g.n} 次)`);
  for (const [ua, n] of [...g.uas].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    console.log(`     ×${String(n).padStart(3)}  ${ua}`);
  }
}
console.log("\nDONE");
