/**
 * Supabase log 時間軸：逐秒 / 逐 10 秒桶，逐張表睇節奏（2026-09-21 營業中樣本）。
 * 唯讀。用法: node tools/_sb-timeline-20260921.cjs "<supabase csv>"
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

const rows = toObjects(parseCsv(fs.readFileSync(process.argv[2], "utf8")))
  .map((r) => ({ ...r, t: Date.parse(String(r.date).replace(/"/g, "")) }))
  .filter((r) => Number.isFinite(r.t))
  .sort((a, b) => a.t - b.t);

const t0 = rows[0].t;
const span = (rows[rows.length - 1].t - t0) / 1000;
console.log(`rows=${rows.length}  window=${new Date(t0).toISOString()} → ${new Date(rows[rows.length - 1].t).toISOString()}  span=${span.toFixed(0)}s`);

function key(r) {
  const m = (r.method || "").trim() || "(none)";
  const p = (r.pathname || "").trim() || "(none)";
  const sel = (String(r.event_message || "").match(/[?&]select=([^&]+)/) || [, ""])[1] || "";
  const n = sel ? decodeURIComponent(sel).split(",").length : 0;
  return m + " " + p + (n ? ` [${n}c]` : "");
}

const groups = {};
for (const r of rows) (groups[key(r)] = groups[key(r)] || []).push(r.t);
const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);

for (const [k, ts] of sorted) {
  if (ts.length < 4) continue;
  const gaps = [];
  for (let i = 1; i < ts.length; i += 1) gaps.push((ts[i] - ts[i - 1]) / 1000);
  const med = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  const sameSec = gaps.filter((g) => g < 0.5).length;
  console.log(
    `\n${k}  n=${ts.length}` +
      `  gap med=${med.toFixed(2)}s min=${min.toFixed(2)} max=${max.toFixed(2)} <0.5s×${sameSec}` +
      `  ≈${(60 / med).toFixed(1)}/min`,
  );
  // 前 12 個時間點
  console.log("   first 12 offsets(s): " + ts.slice(0, 12).map((t) => ((t - t0) / 1000).toFixed(1)).join(", "));
  // 10 秒桶
  const buckets = {};
  for (const t of ts) {
    const b = Math.floor((t - t0) / 10000);
    buckets[b] = (buckets[b] || 0) + 1;
  }
  const bb = Object.entries(buckets).sort((a, b) => Number(a[0]) - Number(b[0]));
  console.log("   10s buckets: " + bb.map(([b, n]) => `${b}s:${n}`).join(" "));
}

console.log("\n--- 42903/400/error 事件時間 ---");
for (const r of rows) {
  const st = String(r.status || "");
  if (st === "400" || st === "42703" || /error|warning/i.test(String(r.level))) {
    console.log(`  +${((r.t - t0) / 1000).toFixed(1)}s  ${st}  ${(r.event_message || "").slice(0, 90)}`);
  }
}
console.log("\nDONE");
