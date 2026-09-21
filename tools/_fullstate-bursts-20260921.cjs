/**
 * 全量 state 拉取「爆發段」分析（2026-09-21 覆核）。
 * 唯讀。用法: node tools/_fullstate-bursts-20260921.cjs "<supabase csv>"
 *
 * 為何要分段：中位間隔 4.46 秒會誤導 —— 真實形態係「靜幾分鐘 → 連續爆發幾分鐘」。
 * 要分開計「活躍時段嘅實際頻率」同「全窗口平均頻率」，先知真實成本。
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

/** 全量 state 嘅招牌查詢：用 orders RPC 做代表（每個全量請求一定有佢）。 */
const stamps = rows.filter((r) => /pos_orders_page/.test(String(r.event_message || ""))).map((r) => r.t);
if (!stamps.length) {
  console.log("搵唔到 rpc/pos_orders_page");
  process.exit(0);
}

const t0 = stamps[0];
const span = (stamps[stamps.length - 1] - t0) / 1000;
console.log(`全量 state 次數=${stamps.length}  窗口=${new Date(t0).toISOString()} → ${new Date(stamps[stamps.length - 1]).toISOString()}  span=${span.toFixed(0)}s`);
console.log(`全窗口平均 = ${(stamps.length / span * 60).toFixed(2)} 次/分鐘`);

/** 分段：gap > BURST_GAP 就切一段。 */
const BURST_GAP = 20;
const segs = [];
let cur = [stamps[0]];
for (let i = 1; i < stamps.length; i += 1) {
  if ((stamps[i] - stamps[i - 1]) / 1000 > BURST_GAP) {
    segs.push(cur);
    cur = [];
  }
  cur.push(stamps[i]);
}
segs.push(cur);

console.log(`\n--- 爆發段（gap > ${BURST_GAP}s 就切）---`);
let activeSec = 0;
for (const s of segs) {
  const dur = (s[s.length - 1] - s[0]) / 1000;
  const rate = dur > 0 ? ((s.length - 1) / dur) * 60 : 0;
  const gaps = [];
  for (let i = 1; i < s.length; i += 1) gaps.push((s[i] - s[i - 1]) / 1000);
  const med = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
  activeSec += dur;
  const tag = s.length >= 5 && rate > 6 ? "🔴 循環" : s.length >= 3 ? "⚠️ 小段" : "· 零星";
  console.log(
    `  ${tag} 起 +${((s[0] - t0) / 1000).toFixed(0)}s  長 ${dur.toFixed(0)}s  次數 ${s.length}  ≈${rate.toFixed(1)}/min  間隔中位 ${med.toFixed(2)}s`,
  );
}

console.log(`\n活躍總時長 ≈ ${activeSec.toFixed(0)}s（佔窗口 ${((activeSec / span) * 100).toFixed(0)}%）`);
console.log(`活躍段內頻率 ≈ ${((stamps.length - segs.length) / Math.max(activeSec, 1) * 60).toFixed(1)} 次/分鐘`);

/** 成本估算（單次 bytes 由 Vercel 嘅 [egress] log 實測）。 */
const SIZES = { "skipQueue=1（已優化）": 424181, "無 skipQueue（舊 bundle）": 857000 };
console.log("\n--- egress 估算 ---");
for (const [label, bytes] of Object.entries(SIZES)) {
  const total = stamps.length * bytes;
  console.log(
    `  ${label.padEnd(24)} 全窗口 ${(total / 1048576).toFixed(1)} MB` +
      `  ⇒ ${((total / 1048576) / (span / 3600)).toFixed(0)} MB/小時` +
      `  ⇒ 開足 10 小時 ≈ ${(((total / 1048576) / (span / 3600)) * 10 / 1024).toFixed(2)} GB`,
  );
}
console.log("\nDONE");
