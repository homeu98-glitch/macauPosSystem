// 逐 30 秒 tick 歸因 + 重複 id 統計
const fs = require("fs");

function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c !== "\r") cur += c;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const rows = parseCsv(fs.readFileSync(process.argv[2], "utf8")).filter((r) => r.length > 1);
const H = rows[0].map((h) => h.trim());
const I = {}; H.forEach((h, i) => (I[h] = i));
const unq = (v) => (v == null ? "" : String(v).replace(/^"+|"+$/g, ""));
const g = (r, n) => unq(r[I[n]]);

const items = rows.slice(1).map((r) => {
  const evt = g(r, "event_message");
  const u = evt.split(" | ")[2] || "";
  return {
    t: Date.parse(g(r, "date")),
    method: g(r, "method"),
    path: u || g(r, "pathname"),
    status: g(r, "status"),
    evt,
  };
}).filter((x) => x.t).sort((a, b) => a.t - b.t);

const t0 = items[0].t;
const mac = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 19);

// 1) 重複 id 統計（pathname 內 ?id=eq.XXX）
const idCount = new Map();
for (const x of items) {
  const m = /[?&]id=eq\.([^&]+)/.exec(x.path);
  if (!m) continue;
  const k = `${x.method} ${x.path.split("?")[0]} ${m[1]}`;
  idCount.set(k, (idCount.get(k) || 0) + 1);
}
console.log("=== 同一 id 被重複操作次數 top 15 ===");
[...idCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}×  ${k.slice(0, 130)}`));

// 2) 逐 30 秒 tick：以 sync 相關查詢做 anchor
console.log("\n=== 每 30s tick 內容（以 pos_store_status?select=is_open 為 anchor）===");
const anchors = items.filter((x) => x.path.includes("pos_store_status?select=is_open"));
for (const a of anchors.slice(-8)) {
  const win = items.filter((x) => x.t >= a.t - 400 && x.t <= a.t + 2500);
  const group = [a, ...win.filter((x) => x !== a && Math.abs(x.t - a.t) < 1500 && x.t > a.t)];
  console.log(`\n  TICK ${mac(a.t)}`);
  const seen = [];
  for (const x of group) {
    const key = `${x.method} ${x.path.split("?")[0]}`;
    const last = seen.find((s) => s.key === key && x.t - s.t < 1200);
    if (last) { last.n++; last.t = x.t; continue; }
    const rec = { key, n: 1, t: x.t, first: x.t, ms: x.t - a.t };
    seen.push(rec);
  }
  for (const s of seen) {
    if (s.key.includes("pos_store_status?select=is_open")) continue;
    console.log(`     ${s.key.slice(0, 78).padEnd(80)} ×${s.n}`);
  }
}

// 3) 全部 DELETE 明細
console.log("\n=== 全部 DELETE ===");
const dels = items.filter((x) => x.method === "DELETE");
console.log(`  n=${dels.length}  第一 ${mac(dels[0].t)} → 最後 ${mac(dels[dels.length - 1].t)}`);
const bySec = {};
for (const d of dels) bySec[mac(d.t)] = (bySec[mac(d.t)] || 0) + 1;
console.log("  逐秒:", JSON.stringify(bySec));
