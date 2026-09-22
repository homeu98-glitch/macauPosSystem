/**
 * 2026-09-22 深度分析：全量拉取循環嘅精確節奏、錯誤內容、以及逐端點位元組估算。
 * 用法：node tools/_egress-deep-20260922.cjs "C:/.../supabase.csv" "C:/.../vercel.csv"
 */
const fs = require("node:fs");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
function toObjects(rows) {
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.length > 1).map((r) => {
    const o = {};
    header.forEach((h, i) => (o[h] = r[i] ?? ""));
    return o;
  });
}

const O = [];
const log = (...a) => { O.push(a.join(" ")); console.log(a.join(" ")); };

const sb = toObjects(parseCsv(fs.readFileSync(process.argv[2], "utf8")));
const items = sb.map((r) => {
  const url = r.event_message || "";
  const m = url.match(/https:\/\/[^/]+\/([^?\s|]+)(\?[^\s|]*)?/);
  return {
    t: Date.parse((r.date || "").replace(/^"|"$/g, "")) || Date.parse(r.timestamp),
    path: m ? "/" + m[1] : "(非 PostgREST)",
    store: (url.match(/store_id=eq\.([0-9a-f-]+)/) || [])[1] || "",
    level: r.level,
    msg: url,
  };
}).filter((x) => Number.isFinite(x.t));

const t0 = Math.min(...items.map((x) => x.t));
const mac = (ms) => new Date(ms + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
log("=== 時間基準核對 ===");
log("CSV date 欄樣本:", sb[0].date, "| parse → UTC ISO:", new Date(t0).toISOString());
log(`窗口（UTC ${new Date(t0).toISOString().slice(11, 19)} → ${new Date(Math.max(...items.map((x) => x.t))).toISOString().slice(11, 19)}）`);
log(`窗口（澳門 +8）：${mac(t0)} → ${mac(Math.max(...items.map((x) => x.t)))}`);

// ── ① 六表對齊 → 全量拉取次數 ──
const FULL_STATE_TABLES = [
  "/rest/v1/rpc/pos_orders_page",
  "/rest/v1/pos_device_configs",
  "/rest/v1/pos_print_templates",
  "/rest/v1/pos_note_presets",
  "/rest/v1/pos_print_jobs",
  "/rest/v1/pos_queue_events",
];
const primary = items
  .filter((x) => x.path === "/rest/v1/pos_device_configs")
  .map((x) => x.t)
  .sort((a, b) => a - b);

log("\n=== ① 全量拉取（6 表對齊）節奏 ===");
log(`以 pos_device_configs 為錨：${primary.length} 次`);
const gaps = [];
for (let i = 1; i < primary.length; i += 1) gaps.push(primary[i] - primary[i - 1]);
const sortedGaps = [...gaps].sort((a, b) => a - b);
log(`間隔中位 ${(sortedGaps[Math.floor(sortedGaps.length / 2)] / 1000).toFixed(2)} 秒｜最小 ${(sortedGaps[0] / 1000).toFixed(2)}｜最大 ${(sortedGaps[sortedGaps.length - 1] / 1000).toFixed(2)}`);
const hist = {};
for (const g of gaps) { const b = `${Math.round(g / 1000)}s`; hist[b] = (hist[b] || 0) + 1; }
log("間隔分布:", JSON.stringify(Object.entries(hist).sort((a, b) => parseInt(a[0]) - parseInt(b[0])).slice(0, 15)));
const spanMin = (Math.max(...items.map((x) => x.t)) - t0) / 60000;
log(`⇒ 全量拉取 ${primary.length} 次 / ${spanMin.toFixed(1)} 分鐘 = ${(primary.length / spanMin).toFixed(2)} 次/分鐘`);

// ── ② 每個端點嘅「每次拉取」次數（睇對齊度）──
log("\n=== ② 各表次數（同窗口）===");
const cnt = {};
for (const it of items) cnt[it.path] = (cnt[it.path] || 0) + 1;
for (const t of FULL_STATE_TABLES) log(`  ${String(cnt[t] || 0).padStart(4)}  ${t}`);
log(`  ---- 其餘 ----`);
for (const [k, v] of Object.entries(cnt).sort((a, b) => b[1] - a[1])) {
  if (!FULL_STATE_TABLES.includes(k)) log(`  ${String(v).padStart(4)}  ${k}`);
}

// ── ③ 全量拉取以外嘅「獨立節奏源」──
log("\n=== ③ 各端點自身間隔中位（搵其他輪詢源）===");
const byPath = {};
for (const it of items) (byPath[it.path] ||= []).push(it.t);
for (const [p, arr] of Object.entries(byPath)) {
  if (arr.length < 5) continue;
  const s = arr.sort((a, b) => a - b);
  const g = [];
  for (let i = 1; i < s.length; i += 1) g.push(s[i] - s[i - 1]);
  const med = [...g].sort((a, b) => a - b)[Math.floor(g.length / 2)];
  log(`  ${String(arr.length).padStart(4)} 次｜中位間隔 ${(med / 1000).toFixed(1)} 秒｜${p}`);
}

// ── ④ error / warning 內容 ──
log("\n=== ④ error / warning 樣本 ===");
for (const lv of ["error", "warning"]) {
  const rows = items.filter((x) => x.level === lv);
  const kinds = {};
  for (const r of rows) {
    let k = r.msg.split("|").pop().trim().slice(0, 110);
    k = k.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>");
    kinds[k] = (kinds[k] || 0) + 1;
  }
  log(`[${lv}] ${rows.length} 條：`);
  for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 8)) log(`   ${v}× ${k}`);
}

// ── ⑤ 非 PostgREST 行（path 解析失敗）──
log("\n=== ⑤ 無法解析 URL 嘅 log 樣本（頭 5 條）===");
for (const it of items.filter((x) => x.path === "(非 PostgREST)").slice(0, 5)) log("  " + it.msg.replace(/\s+/g, " ").slice(0, 200));

// ── ⑥ store 分布 ──
log("\n=== ⑥ store 分布 ===");
const st = {};
for (const it of items) st[it.store || "(無 store_id)"] = (st[it.store || "(無 store_id)"] || 0) + 1;
for (const [k, v] of Object.entries(st).sort((a, b) => b[1] - a[1])) log(`  ${String(v).padStart(4)}  ${k}`);

// ── ⑦ 位元組估算（以業界實測值 × 次數）──
log("\n=== ⑦ 位元組估算（每分鐘 / 每日）===");
const est = {
  "/rest/v1/rpc/pos_orders_page": 60 * 1024, // 每頁訂單（limit 2000 時更大）
  "/rest/v1/pos_device_configs": 3 * 1024,
  "/rest/v1/pos_print_templates": 12 * 1024,
  "/rest/v1/pos_note_presets": 1 * 1024,
  "/rest/v1/pos_print_jobs": 90 * 1024, // limit=200 select=*（含 items/template/content jsonb）
  "/rest/v1/pos_queue_events": 120 * 1024, // limit=300 select=*
  "/rest/v1/pos_orders": 40 * 1024,
  "/rest/v1/pos_sessions": 1 * 1024,
  "/rest/v1/pos_store_status": 1 * 1024,
  "/rest/v1/pos_shifts": 1 * 1024,
};
let perMinBytes = 0;
const rowsEst = [];
for (const [p, arr] of Object.entries(byPath)) {
  const perMin = arr.length / spanMin;
  const bytes = (est[p] || 0.3 * 1024) * perMin;
  perMinBytes += bytes;
  rowsEst.push({ p, perMin, bytes });
}
for (const r of rowsEst.sort((a, b) => b.bytes - a.bytes)) {
  log(`  ${(r.bytes / 1024).toFixed(0).padStart(6)} KB/分  (${r.perMin.toFixed(1)} 次/分)  ${r.p}`);
}
log(`  ─────────────────────────`);
log(`  合計 ≈ ${(perMinBytes / 1024).toFixed(0)} KB/分 = ${(perMinBytes / 1024 / 1024 * 1440).toFixed(2)} GB/日（按此窗口外推）`);
log(`  其中「全量拉取 6 表」≈ ${(
  (est["/rest/v1/rpc/pos_orders_page"] + est["/rest/v1/pos_device_configs"] + est["/rest/v1/pos_print_templates"] +
    est["/rest/v1/pos_note_presets"] + est["/rest/v1/pos_print_jobs"] + est["/rest/v1/pos_queue_events"]) *
  (primary.length / spanMin) / 1024
).toFixed(0)} KB/分 ＝ 佔 ${(
  ((est["/rest/v1/rpc/pos_orders_page"] + est["/rest/v1/pos_device_configs"] + est["/rest/v1/pos_print_templates"] +
    est["/rest/v1/pos_note_presets"] + est["/rest/v1/pos_print_jobs"] + est["/rest/v1/pos_queue_events"]) *
    (primary.length / spanMin)) / perMinBytes * 100
).toFixed(1)}%`);

// ── ⑧ Vercel message 內容（睇有冇 [egress] / 大小）──
if (process.argv[3] && fs.existsSync(process.argv[3])) {
  const vc = toObjects(parseCsv(fs.readFileSync(process.argv[3], "utf8")));
  log("\n=== ⑧ Vercel message 樣本（睇有冇大小／[egress] 標記）===");
  const seen = new Set();
  for (const r of vc) {
    const m = (r.message || "").replace(/\s+/g, " ").trim();
    if (!m) continue;
    const key = m.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    log(`  [${r.level || "-"}] ${r.requestPath} :: ${m.slice(0, 160)}`);
    if (seen.size >= 12) break;
  }
}

fs.writeFileSync("tools/_egress-deep-20260922.out.txt", O.join("\n"), "utf8");
console.log("\n（已寫入 tools/_egress-deep-20260922.out.txt）");
