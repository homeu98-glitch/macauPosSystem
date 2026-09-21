/**
 * 一次性復核：把 Supabase log 同 Vercel log 入面所有 error / warning 逐條列出，
 * 並按「成因簽名」歸類（2026-09-21）。
 * 唯讀，唔會改任何東西。
 *
 * 用法：
 *   node tools/_errwarn-recheck-20260921.cjs "<supabase csv>" "<vercel csv>"
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

const [sbPath, vcPath] = process.argv.slice(2);

/* ---------------- Supabase ---------------- */
if (sbPath) {
  const sb = toObjects(parseCsv(fs.readFileSync(sbPath, "utf8")));
  console.log("=== SUPABASE LOG ===");
  console.log("rows =", sb.length);
  const keys = Object.keys(sb[0] || {});
  console.log("columns =", keys.join(" | "));

  const levelKey = keys.includes("level") ? "level" : null;
  const statusKey = keys.includes("status_code") ? "status_code" : "status";

  const count = (k) => {
    const m = {};
    for (const r of sb) {
      const v = (r[k] || "").trim() || "(empty)";
      m[v] = (m[v] || 0) + 1;
    }
    return m;
  };
  console.log("level =", JSON.stringify(count(levelKey)), );
  console.log("status =", JSON.stringify(count(statusKey)));
  console.log("method =", JSON.stringify(count("method")));

  // 只列 error / warn
  const bad = sb.filter((r) => {
    const lv = (r[levelKey] || "").toLowerCase();
    return lv === "error" || lv === "warn" || lv === "warning" || lv === "fatal";
  });
  console.log("\n--- error/warning 逐條（" + bad.length + " 條）---");
  // 去重：同 (level, status, path, msg 首 200 字)
  const seen = new Map();
  for (const r of bad) {
    const msg = (r.event_message || r.msg || r.message || r.error || "").slice(0, 260);
    const sig = [
      (r[levelKey] || ""),
      (r[statusKey] || ""),
      (r.method || ""),
      (r.path || r.request_path || ""),
      msg.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<TS>"),
    ].join(" ‖ ");
    if (!seen.has(sig)) seen.set(sig, { n: 0, sample: r, msg });
    seen.get(sig).n += 1;
  }
  let i = 0;
  for (const [sig, v] of seen) {
    i += 1;
    console.log("\n[" + i + "] ×" + v.n);
    console.log("  sig : " + sig);
    console.log("  row : " + JSON.stringify(v.sample).slice(0, 600));
  }
}

/* ---------------- Vercel ---------------- */
if (vcPath) {
  const vc = toObjects(parseCsv(fs.readFileSync(vcPath, "utf8")));
  console.log("\n\n=== VERCEL LOG ===");
  console.log("rows =", vc.length);
  console.log("columns =", Object.keys(vc[0] || {}).join(" | "));
  for (const r of vc.slice(0, 2)) console.log("  sample: " + JSON.stringify(r).slice(0, 400));
}

console.log("\nDONE");
