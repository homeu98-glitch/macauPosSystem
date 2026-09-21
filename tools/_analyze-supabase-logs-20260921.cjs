/**
 * 分析 Supabase logs CSV（唯讀，唔連任何 DB）。
 *
 * CSV 欄位：id,date,method,pathname,status,timestamp,level,event_message,log_type,log_count,logs,auth_user
 *   - `event_message` 內含**完整 URL**（包括 query params）⇒ 可以還原「邊條 route／邊個 client」。
 *   - ⚠️ CSV **冇 response size 欄**，所以 bytes 要用另一邊（Vercel log / route 內 bytes log）對帳。
 *
 * 用法：node tools/_analyze-supabase-logs-20260921.cjs <csv路徑>
 */
const fs = require("fs");

const csvPath = process.argv[2] || "C:/Users/surface/Downloads/supabase_logs.csv";

/** 解析 CSV（支援 `"..."` 引號、`""` escape）。 */
function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const raw = fs.readFileSync(csvPath, "utf8");
const rows = parseCsv(raw);
const header = rows[0];
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
const data = rows.slice(1).filter((r) => r.length > 3 && r[idx.timestamp]);

console.log(`總記錄數：${data.length}`);
console.log(`欄位：${header.join(", ")}`);

// ── 時間範圍 ──
const times = data.map((r) => r[idx.timestamp]).filter(Boolean).sort();
console.log(`時間範圍：${times[0]}  →  ${times[times.length - 1]}`);
const hours = new Set(times.map((t) => t.slice(0, 13)));
console.log(`覆蓋 ${hours.size} 個「小時格」：${[...hours].sort().join(" ")}`);
const spanMin = (Date.parse(times[times.length - 1].replace(" ", "T") + "Z") -
  Date.parse(times[0].replace(" ", "T") + "Z")) / 60000;
console.log(`時間跨度：約 ${spanMin.toFixed(0)} 分鐘 ⇒ 平均 ${(data.length / Math.max(spanMin, 1)).toFixed(1)} 請求／分鐘`);

// ── 按 pathname 分組 ──
const byPath = new Map();
for (const r of data) {
  const p = r[idx.pathname] || "(empty)";
  const cur = byPath.get(p) || { n: 0, get: 0, post: 0, patch: 0, methods: new Set() };
  cur.n += 1;
  const m = r[idx.method];
  cur.methods.add(m);
  if (m === "GET") cur.get += 1;
  else if (m === "POST") cur.post += 1;
  else if (m === "PATCH") cur.patch += 1;
  byPath.set(p, cur);
}
const pathSorted = [...byPath.entries()].sort((a, b) => b[1].n - a[1].n);
console.log(`\n===== 按 pathname 排名（前 25） =====`);
console.log("次數".padStart(7) + "  佔比".padStart(7) + "  每分鐘".padStart(8) + "  pathname");
for (const [p, v] of pathSorted.slice(0, 25)) {
  console.log(
    String(v.n).padStart(7) +
      `  ${((v.n / data.length) * 100).toFixed(1).padStart(5)}%` +
      `  ${(v.n / Math.max(spanMin, 1)).toFixed(2).padStart(7)}` +
      `  ${p}  [${[...v.methods].join("/")}]`,
  );
}

// ── pos_orders 查詢形狀 ──
function shapeOf(url) {
  const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const params = new URLSearchParams(qs);
  const parts = [];
  const select = params.get("select");
  if (select) parts.push(select === "*" ? "select=*" : `select:${select.split(",").length}欄`);
  for (const key of ["limit", "offset"]) {
    if (params.get(key)) parts.push(`${key}=${params.get(key)}`);
  }
  const order = params.get("order");
  if (order) parts.push(`order=${order.split(".")[0]}`);
  if (params.get("store_id")) parts.push("store_id=eq");
  if (params.get("status")) parts.push("status=in");
  for (const col of ["created_at", "updated_at", "reopened_at", "sent_to_kitchen_at"]) {
    if (params.get(col)) parts.push(`${col}=${params.get(col).startsWith("gte") ? "gte" : "其他"}`);
  }
  if (params.get("id")) parts.push("id=eq/in");
  return parts.join(" ") || "(無參數)";
}

for (const table of ["pos_orders", "pos_queue_events", "pos_print_jobs", "pos_print_agents", "pos_shifts"]) {
  const target = `/rest/v1/${table}`;
  const subset = data.filter((r) => (r[idx.pathname] || "") === target);
  if (subset.length === 0) continue;
  const byShape = new Map();
  for (const r of subset) {
    const msg = r[idx.event_message] || "";
    const url = (msg.match(/https?:\/\/\S+/) || [""])[0];
    const key = `${r[idx.method]} ${shapeOf(url)}`;
    const cur = byShape.get(key) || { n: 0, sample: url };
    cur.n += 1;
    byShape.set(key, cur);
  }
  console.log(`\n===== ${table} 查詢形狀（共 ${subset.length} 次） =====`);
  for (const [key, v] of [...byShape.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${String(v.n).padStart(6)} 次 (${((v.n / subset.length) * 100).toFixed(1)}%)  ${key}`);
    if (v.n >= 3) console.log(`         例：${v.sample.slice(0, 260)}`);
  }
}

// ── 每個 pathname 嘅每分鐘頻率（用嚟捉「常駐輪詢」）──
console.log(`\n===== 常駐輪詢偵測（每分鐘 ≥ 0.5 次）=====`);
for (const [p, v] of pathSorted) {
  const perMin = v.n / Math.max(spanMin, 1);
  if (perMin >= 0.5) {
    console.log(`${perMin.toFixed(2).padStart(7)} 次/分鐘  ${p}  [${[...v.methods].join("/")}]`);
  }
}

// ── 有冇 limit=5000（對賬守護指紋）──
const bigLimit = data.filter((r) => /limit=5000/.test(r[idx.event_message] || ""));
console.log(`\n🔍 limit=5000 嘅請求：${bigLimit.length} 次`);
if (bigLimit.length) {
  const byPathBig = new Map();
  for (const r of bigLimit) byPathBig.set(r[idx.pathname], (byPathBig.get(r[idx.pathname]) || 0) + 1);
  console.log([...byPathBig.entries()].map(([k, n]) => `  ${k}: ${n}`).join("\n"));
  console.log(`  例：${(bigLimit[0][idx.event_message] || "").slice(0, 300)}`);
}
