/**
 * 關店時段分段分析（2026-09-22 17:45）。
 * 用法：node tools/_egress-closed-window-20260922.cjs "C:/Users/surface/Downloads/supabase_logs (13).csv"
 */
const fs = require("node:fs");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { f += '"'; i += 1; } else q = false;
      } else f += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const rows = parseCsv(fs.readFileSync(process.argv[2], "utf8"));
const header = rows[0].map((x) => x.trim());
const objs = rows.slice(1).filter((r) => r.length > 1).map((r) => {
  const o = {};
  header.forEach((k, i) => (o[k] = r[i] ?? ""));
  return o;
});

const items = objs.map((o) => {
  const url = o.event_message || "";
  const m = url.match(/https:\/\/[^/]+\/([^?\s|]+)/);
  const qs = url.match(/\?([^\s|]*)/);
  const p = new URLSearchParams((qs && qs[1]) || "");
  // ⚠️ Supabase CSV 嘅 `date` 欄可能仍帶引號（雙重 escape）⇒ 一定要剝。
  const rawDate = String(o.date || o.timestamp || "").replace(/^"+|"+$/g, "").trim();
  return {
    t: Date.parse(rawDate),
    path: m ? m[1] : "(非 PostgREST)",
    limit: p.get("limit") || "-",
    level: o.level,
  };
}).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);

const macLabel = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
const macMs = (hhmm) => Date.parse(`2026-09-22T${hhmm}:00.000+08:00`);

const segs = [
  ["14:17", "15:00"], ["15:00", "15:15"], ["15:15", "15:30"], ["15:30", "16:00"],
  ["16:00", "16:30"], ["16:30", "17:00"], ["17:00", "17:29"],
];
console.log("窗口：", macLabel(items[0].t), "→", macLabel(items[items.length - 1].t), "（澳門）\n");
for (const [a, b] of segs) {
  const s = items.filter((x) => x.t >= macMs(a) && x.t < macMs(b));
  const min = (macMs(b) - macMs(a)) / 60000;
  const cnt = {};
  for (const x of s) {
    const k = x.path.replace("/rest/v1/", "") + (x.limit !== "-" ? `[${x.limit}]` : "");
    cnt[k] = (cnt[k] || 0) + 1;
  }
  const top = Object.entries(cnt).sort((x, y) => y[1] - x[1]).slice(0, 7).map(([k, v]) => `${k}:${v}`).join("  ");
  console.log(`${a}-${b} 澳門 | ${String(s.length).padStart(4)} 次 | ${(s.length / min).toFixed(1)} 次/分`);
  if (top) console.log("      " + top);
}

// 15:00 之後仲有咩不停打（逐端點時間線）
const after = items.filter((x) => x.t >= macMs("15:00"));
console.log(`\n=== 15:00 之後合計 ${after.length} 次 ===`);
const gap = {};
const byPath = {};
for (const x of after) (byPath[x.path] ||= []).push(x.t);
for (const [p, arr] of Object.entries(byPath)) {
  if (arr.length < 3) continue;
  const g = [];
  for (let i = 1; i < arr.length; i += 1) g.push(arr[i] - arr[i - 1]);
  g.sort((a, b) => a - b);
  gap[p] = { n: arr.length, med: g[Math.floor(g.length / 2)] / 1000 };
}
for (const [p, v] of Object.entries(gap).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(v.n).padStart(4)} 次 | 中位間隔 ${v.med.toFixed(1)} 秒 | ${p}`);
}

// 最密集嘅 10 分鐘
let best = { start: 0, n: 0 };
for (const x of after) {
  const n = after.filter((y) => y.t >= x.t && y.t < x.t + 600000).length;
  if (n > best.n) best = { start: x.t, n };
}
console.log(`\n最密集 10 分鐘：${macLabel(best.start)} 起 ${best.n} 次（${(best.n / 10).toFixed(1)} 次/分）`);
const inBest = after.filter((y) => y.t >= best.start && y.t < best.start + 600000);
const c2 = {};
for (const x of inBest) c2[x.path] = (c2[x.path] || 0) + 1;
console.log("      " + Object.entries(c2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join("  "));
