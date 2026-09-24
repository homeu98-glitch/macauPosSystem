// 2026-09-24 取證：指定 path 明細 + 每 30s 定時器歸因 + DELETE 風暴歸因
// 用法: node tools/_probe-20260924.cjs <supabase.csv> [pathSubstring]
const fs = require("fs");

const CSV = process.argv[2];
const WANT = process.argv[3] || "";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") {
        row.push(cur);
        cur = "";
      } else if (c === "\n") {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else if (c === "\r") {
        /* skip */
      } else cur += c;
    }
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

const text = fs.readFileSync(CSV, "utf8");
const rows = parseCsv(text).filter((r) => r.length > 1);
const header = rows[0];
const idx = {};
header.forEach((h, i) => (idx[h.trim()] = i));
console.log("欄位:", header.map((h) => h.trim()).join(" | "));

const unq = (v) => (v == null ? "" : v.replace(/^"+|"+$/g, ""));

function pick(r, names) {
  for (const n of names) {
    if (idx[n] != null && r[idx[n]] != null && unq(r[idx[n]]) !== "") return unq(r[idx[n]]);
  }
  return "";
}

const items = rows.slice(1).map((r) => {
  const d = pick(r, ["date", "timestamp"]);
  return {
    t: Date.parse(d),
    path: pick(r, ["path", "request_path"]),
    method: pick(r, ["method", "request_method"]),
    status: pick(r, ["status_code", "status"]),
    evt: pick(r, ["event_message", "message"]),
    id: pick(r, ["id"]),
  };
}).filter((x) => x.t);

const span = (Math.max(...items.map((x) => x.t)) - Math.min(...items.map((x) => x.t))) / 1000;
const mac = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 19);
const t0 = Math.min(...items.map((x) => x.t));
console.log(`\n窗口 ${mac(t0)} → ${mac(Math.max(...items.map((x) => x.t)))} MAC  筆數 ${items.length}  span ${(span / 60).toFixed(1)} 分`);

if (WANT) {
  const sel = items.filter((x) => (x.path + x.evt).includes(WANT));
  console.log(`\n=== 明細: ${WANT}  n=${sel.length} ===`);
  for (const x of sel.slice(0, 60)) {
    console.log(`  ${mac(x.t)} (+${((x.t - t0) / 1000).toFixed(1)}s) ${x.method} ${x.status}  ${x.evt.slice(0, 220)}`);
  }
}

// QUERY 欄位有咩
console.log("\n=== header 全部 ===");
console.log(header.map((h, i) => `${i}:${h.trim()}=${unq(rows[1][i] || "").slice(0, 80)}`).join("\n"));
