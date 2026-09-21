/**
 * 睇窗口內每一條請求（用嚟判斷「係咪有新頁面載入」）。唯讀。
 * 用法: node tools/_sb-window-20260921.cjs "<supabase csv>" <offsetStartSec> <offsetEndSec>
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
const rows = parseCsv(fs.readFileSync(process.argv[2], "utf8"));
const head = rows[0].map((h) => h.trim());
const objs = [];
for (let i = 1; i < rows.length; i += 1) {
  if (!rows[i].length) continue;
  const o = {};
  head.forEach((h, j) => (o[h] = rows[i][j]));
  o.t = Date.parse(String(o.date).replace(/"/g, ""));
  if (Number.isFinite(o.t)) objs.push(o);
}
objs.sort((a, b) => a.t - b.t);
const t0 = objs[0].t;
const from = Number(process.argv[3] || 0);
const to = Number(process.argv[4] || 1e9);

/** 只列「非全量 state 招牌查詢」嘅行（雜訊已經太多）。 */
const NOISE = /pos_orders_page|pos_device_configs|pos_print_jobs\?select=\*|pos_print_templates|pos_note_presets|pos_queue_events\?select=\*|pos_print_agents|pos_orders_page/;
console.log(`窗口基準 = ${new Date(t0).toISOString()}（Macau +8）`);
let n = 0;
for (const o of objs) {
  const off = (o.t - t0) / 1000;
  if (off < from || off > to) continue;
  const msg = String(o.event_message || "");
  if (NOISE.test(msg)) continue;
  const short = msg.replace(/https:\/\/[^/]+\/rest\/v1\//, "").replace(/[?&](apikey|select|order|limit)=[^&]*/g, "").slice(0, 110);
  const macau = new Date(o.t + 8 * 3600 * 1000).toISOString().slice(11, 19);
  console.log(`  +${off.toFixed(1).padStart(7)}s  ${macau}  ${(o.status || "").padEnd(6)} ${(o.method || "").padEnd(6)} ${short}`);
  n += 1;
}
console.log(`（共 ${n} 行）`);
