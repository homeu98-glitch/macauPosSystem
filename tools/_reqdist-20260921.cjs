/**
 * Vercel + Supabase 請求分佈分析（2026-09-21 營業中樣本）。
 * 唯讀。
 * 用法: node tools/_reqdist-20260921.cjs "<vercel csv>" "<supabase csv>"
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
  if (!rows.length) return [];
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

const [vcPath, sbPath] = process.argv.slice(2);

if (vcPath) {
  const raw = toObjects(parseCsv(fs.readFileSync(vcPath, "utf8")));
  // 去重：同 requestId 只留一行（有 message 嗰行）
  const byId = new Map();
  for (const r of raw) {
    const id = r.requestId || JSON.stringify(r).slice(0, 80);
    const prev = byId.get(id);
    if (!prev || ((r.message || "").length > (prev.message || "").length)) byId.set(id, r);
  }
  const rows = [...byId.values()];
  const times = rows.map((r) => Number(r.timestampInMs)).filter(Boolean).sort((a, b) => a - b);
  const spanMin = times.length ? (times[times.length - 1] - times[0]) / 60000 : 0;

  console.log("=== VERCEL ===");
  console.log(`raw rows=${raw.length}  unique requests=${rows.length}  span=${spanMin.toFixed(1)} min`);
  console.log(`rate = ${(rows.length / spanMin).toFixed(1)} req/min`);

  const byStatus = {};
  for (const r of rows) byStatus[r.responseStatusCode] = (byStatus[r.responseStatusCode] || 0) + 1;
  console.log("status =", JSON.stringify(byStatus));

  const byLevel = {};
  for (const r of rows) {
    const lv = (r.level || "").trim() || "(info)";
    byLevel[lv] = (byLevel[lv] || 0) + 1;
  }
  console.log("level =", JSON.stringify(byLevel));

  const nonOk = rows.filter((r) => r.responseStatusCode !== "200" && r.responseStatusCode !== "304");
  console.log("\n--- 非 200 ---（" + nonOk.length + "）");
  for (const r of nonOk) console.log("  " + r.responseStatusCode + " " + r.requestPath);

  const errs = rows.filter((r) => {
    const lv = (r.level || "").toLowerCase();
    return lv === "error" || lv === "warning";
  });
  console.log("\n--- level=error/warning ---（" + errs.length + "）");
  const eseen = new Map();
  for (const r of errs) {
    const sig = [r.level, r.requestPath, (r.message || "").replace(/\d+/g, "<n>").slice(0, 200)].join(" ‖ ");
    if (!eseen.has(sig)) eseen.set(sig, { n: 0, s: r });
    eseen.get(sig).n += 1;
  }
  let i = 0;
  for (const [sig, v] of eseen) {
    i += 1;
    console.log(`\n[${i}] ×${v.n}  ${sig}`);
    console.log("    msg: " + (v.s.message || "").slice(0, 500));
  }

  const byPath = {};
  for (const r of rows) {
    const p = String(r.requestPath || "").replace("macau-pos-system.vercel.app", "");
    byPath[p] = byPath[p] || { n: 0, methods: {}, ms: 0 };
    byPath[p].n += 1;
    byPath[p].methods[r.requestMethod] = (byPath[p].methods[r.requestMethod] || 0) + 1;
    byPath[p].ms += Number(r.durationMs || 0);
  }
  const sorted = Object.entries(byPath).sort((a, b) => b[1].n - a[1].n);
  console.log("\n--- 每個 route 嘅呼叫次數（按次數排） ---");
  for (const [p, v] of sorted) {
    const perMin = (v.n / spanMin).toFixed(2);
    console.log(
      `  ${String(v.n).padStart(4)}  ${perMin.padStart(6)}/min  avg ${(v.ms / v.n).toFixed(0).padStart(5)}ms  ${JSON.stringify(v.methods)}  ${p}`,
    );
  }
}

if (sbPath) {
  const rows = toObjects(parseCsv(fs.readFileSync(sbPath, "utf8")));
  const ts = rows
    .map((r) => Date.parse(String(r.date).replace(/"/g, "")))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const spanMin = ts.length ? (ts[ts.length - 1] - ts[0]) / 60000 : 0;
  console.log("\n\n=== SUPABASE ===");
  console.log(`rows=${rows.length} span=${spanMin.toFixed(1)} min  rate=${(rows.length / spanMin).toFixed(1)}/min`);

  const byKey = {};
  for (const r of rows) {
    const method = (r.method || "").trim() || "(no-method)";
    const pathname = (r.pathname || "").trim() || "(no-path)";
    const select =
      (String(r.event_message || "").match(/[?&]select=([^&]+)/) || [, ""])[1] || "";
    const sel = select ? "?select=" + decodeURIComponent(select).split(",").length + "cols" : "";
    const k = method + " " + pathname + sel;
    byKey[k] = byKey[k] || { n: 0, status: {} };
    byKey[k].n += 1;
    byKey[k].status[r.status] = (byKey[k].status[r.status] || 0) + 1;
  }
  const s = Object.entries(byKey).sort((a, b) => b[1].n - a[1].n);
  console.log("--- PostgREST/Auth/Realtime 呼叫分佈 ---");
  for (const [k, v] of s) {
    console.log(
      `  ${String(v.n).padStart(4)}  ${(v.n / spanMin).toFixed(2).padStart(6)}/min  ${JSON.stringify(v.status)}  ${k}`,
    );
  }
}

console.log("\nDONE");
