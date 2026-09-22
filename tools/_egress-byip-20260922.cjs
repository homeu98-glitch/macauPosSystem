/**
 * 逐 IP／逐次拉取嘅大小與節奏 —— 由 Vercel log 嘅 `[egress]` 行抽出。
 * 用法：node tools/_egress-byip-20260922.cjs "C:/.../vercel.csv"
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
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false; }
      else field += c;
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
const mac = (ms) => new Date(ms + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19);

const vc = toObjects(parseCsv(fs.readFileSync(process.argv[2], "utf8")));
const egress = vc
  .filter((r) => /\[egress\]/.test(r.message || ""))
  .map((r) => {
    const m = (r.message || "").match(/\[egress\]\s+(\S+)\s+bytes=(\d+)\s+mode=(\S+)(.*)/);
    if (!m) return null;
    const rest = m[4] || "";
    const num = (k) => { const x = rest.match(new RegExp(`${k}=(\\S+)`)); return x ? x[1] : ""; };
    return {
      t: Number(r.timestampInMs),
      route: m[1],
      bytes: Number(m[2]),
      mode: m[3],
      orders: num("orders"),
      queue: num("queue"),
      printJobs: num("printJobs"),
      skipQueue: num("skipQueue"),
      legacy: num("legacy"),
      ip: num("ip"),
      src: num("src"),
      limit: num("limit"),
      cols: num("columns"),
      rid: r.requestId,
    };
  })
  .filter(Boolean);

log("=== [egress] 行數 ===", egress.length);
const win = { min: Math.min(...egress.map((e) => e.t)), max: Math.max(...egress.map((e) => e.t)) };
log(`窗口（澳門）${mac(win.min)} → ${mac(win.max)}  ＝ ${((win.max - win.min) / 60000).toFixed(1)} 分鐘`);
const mins = (win.max - win.min) / 60000;

// 逐 IP
const byIp = {};
for (const e of egress) {
  const k = e.ip || "(無 ip)";
  (byIp[k] ||= []).push(e);
}
log("\n=== 逐 IP（每次拉取幾大、幾密）===");
const ipRows = Object.entries(byIp).map(([ip, arr]) => {
  const s = arr.sort((a, b) => a.t - b.t);
  const gaps = [];
  for (let i = 1; i < s.length; i += 1) gaps.push(s[i] - s[i - 1]);
  const medGap = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] / 1000 : 0;
  const by = s.reduce((a, b) => a + b.bytes, 0);
  return {
    ip,
    n: s.length,
    perMin: s.length / mins,
    medGap,
    avgKB: by / s.length / 1024,
    totalMB: by / 1024 / 1024,
    mode: [...new Set(s.map((x) => x.mode))].join("/"),
    legacy: [...new Set(s.map((x) => x.legacy))].join("/"),
    skipQueue: [...new Set(s.map((x) => x.skipQueue))].join("/"),
    src: [...new Set(s.map((x) => x.src))].join("/"),
  };
}).sort((a, b) => b.totalMB - a.totalMB);
for (const r of ipRows) {
  log(`  ip=${r.ip}  拉取 ${r.n} 次（${r.perMin.toFixed(1)}/分）｜中位間隔 ${r.medGap.toFixed(1)}s｜平均 ${r.avgKB.toFixed(0)} KB｜本窗口共 ${r.totalMB.toFixed(1)} MB`);
  log(`        mode=${r.mode} legacy=${r.legacy} skipQueue=${r.skipQueue} src=${r.src}`);
}

const totalBytes = egress.reduce((a, b) => a + b.bytes, 0);
log(`\n窗口內 egress 合計 ${(totalBytes / 1024 / 1024).toFixed(1)} MB / ${mins.toFixed(1)} 分鐘`);
log(`⇒ 外推：${(totalBytes / 1024 / 1024 / mins * 60).toFixed(0)} MB/小時 ｜ ${(totalBytes / 1024 / 1024 / mins * 60 * 24).toFixed(2)} GB/日（24h 全開）`);
log(`⇒ 若每日營業 12 小時：${(totalBytes / 1024 / 1024 / mins * 60 * 12).toFixed(2)} GB/日`);

// 逐模式
log("\n=== 逐 mode（full / ordersOnly）===");
const byMode = {};
for (const e of egress) {
  const k = `${e.mode} legacy=${e.legacy} skipQueue=${e.skipQueue}`;
  const o = (byMode[k] ||= { n: 0, bytes: 0 });
  o.n += 1;
  o.bytes += e.bytes;
}
for (const [k, v] of Object.entries(byMode).sort((a, b) => b[1].bytes - a[1].bytes)) {
  log(`  ${String(v.n).padStart(4)} 次｜共 ${(v.bytes / 1024 / 1024).toFixed(1)} MB｜平均 ${(v.bytes / v.n / 1024).toFixed(0)} KB｜${k}`);
}

// 逐時序（頭 40 條，睇節奏）
log("\n=== 時序（頭 40 條）===");
for (const e of [...egress].sort((a, b) => a.t - b.t).slice(0, 40)) {
  log(`  ${mac(e.t)}  ${String(Math.round(e.bytes / 1024)).padStart(4)} KB  ${e.mode.padEnd(10)} orders=${e.orders} queue=${e.queue} printJobs=${e.printJobs} legacy=${e.legacy} ip=${e.ip} src=${e.src}`);
}

fs.writeFileSync("tools/_egress-byip-20260922.out.txt", O.join("\n"), "utf8");
console.log("\n（已寫入 tools/_egress-byip-20260922.out.txt）");
