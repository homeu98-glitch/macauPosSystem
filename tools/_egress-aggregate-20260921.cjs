/**
 * `[egress]` log 加總器（2026-09-21）。唯讀。
 * 用法: node tools/_egress-aggregate-20260921.cjs "<vercel csv>"
 *
 * 為何要專門一支：
 *  · Vercel 匯出**每個請求 3 行**（只有 1 行有 message）⇒ 一定要按 `requestId` 去重，
 *    否則 bytes 會報大 3 倍。
 *  · `[egress]` 行嘅格式係 `[egress] <tag> bytes=<N> k=v k=v …`（見 `src/lib/egress-log.ts`）
 *    ⇒ 解析成 key-value 之後就可以按 mode / ip / src 分組加總。
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
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQ = false;
      } else cell += c;
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

/** 按 requestId 去重，保留 message 最長嗰行。 */
const byId = new Map();
for (const r of raw) {
  const id = r.requestId || JSON.stringify(r).slice(0, 80);
  const prev = byId.get(id);
  if (!prev || (r.message || "").length > (prev.message || "").length) byId.set(id, r);
}
const rows = [...byId.values()];
const times = rows.map((r) => Number(r.timestampInMs)).filter(Boolean).sort((a, b) => a - b);
const spanMin = times.length ? (times[times.length - 1] - times[0]) / 60000 : 0;
console.log(`去重後請求=${rows.length}  span=${spanMin.toFixed(1)} 分鐘`);

const egress = [];
for (const r of rows) {
  const m = /^\[egress\]\s+(\S+)\s+bytes=(\d+)\s*(.*)$/.exec((r.message || "").trim());
  if (!m) continue;
  const kv = {};
  for (const part of m[3].split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1);
  }
  egress.push({ tag: m[1], bytes: Number(m[2]), kv, t: Number(r.timestampInMs) || 0 });
}

if (!egress.length) {
  console.log("\n（冇 [egress] 行 —— 可能係更早嘅部署，或者 POS_EGRESS_LOG 被靜音）");
  process.exit(0);
}

const total = egress.reduce((a, e) => a + e.bytes, 0);
console.log(`\n[egress] 行數=${egress.length}`);
console.log(`總 egress = ${(total / 1048576).toFixed(2)} MB / ${spanMin.toFixed(1)} min`);
console.log(`         = ${((total / 1048576) / (spanMin / 60)).toFixed(1)} MB/小時`);
console.log(`         = 開 10 小時 ≈ ${((((total / 1048576) / (spanMin / 60)) * 10) / 1024).toFixed(2)} GB`);

/** 按 (tag, mode, ip, src) 分組。 */
const groups = new Map();
for (const e of egress) {
  const key = [
    e.tag,
    e.kv.mode ?? "-",
    `ip=${e.kv.ip ?? "-"}`,
    e.kv.src ? `src=${e.kv.src}` : null,
  ]
    .filter(Boolean)
    .join("  ");
  if (!groups.has(key)) groups.set(key, { n: 0, bytes: 0, orderCounts: new Set(), sample: e });
  const g = groups.get(key);
  g.n += 1;
  g.bytes += e.bytes;
  if (e.kv.orders !== undefined) g.orderCounts.add(e.kv.orders);
}

console.log("\n--- 按 (tag / mode / ip / src) 分組 ---");
const sorted = [...groups].sort((a, b) => b[1].bytes - a[1].bytes);
for (const [key, g] of sorted) {
  const avg = Math.round(g.bytes / g.n);
  const pct = ((g.bytes / total) * 100).toFixed(1);
  console.log(
    `  ${String(g.n).padStart(4)} 次  ${(g.bytes / 1048576).toFixed(2).padStart(7)} MB  (${pct.padStart(5)}%)` +
      `  平均 ${String(avg).padStart(7)} B  ⇒ ${((g.n / spanMin) * 60).toFixed(2)} 次/分鐘`,
  );
  console.log(`        ${key}`);
  const oc = [...g.orderCounts].sort((a, b) => Number(a) - Number(b));
  if (oc.length) console.log(`        orders 數目 = ${oc.join(",")}`);
  console.log(`        樣本: ${JSON.stringify(g.sample.kv)}`);
}

/** 逐 5 分鐘桶，睇流量分佈。 */
if (egress.length > 1) {
  const t0 = Math.min(...egress.map((e) => e.t));
  const buckets = new Map();
  for (const e of egress) {
    const b = Math.floor((e.t - t0) / 300000);
    buckets.set(b, (buckets.get(b) || 0) + e.bytes);
  }
  console.log("\n--- 逐 5 分鐘桶 ---");
  for (const [b, bytes] of [...buckets].sort((a, c) => a[0] - c[0])) {
    console.log(`  +${b * 5}~${b * 5 + 5}min  ${(bytes / 1048576).toFixed(2)} MB`);
  }
}
console.log("\nDONE");
