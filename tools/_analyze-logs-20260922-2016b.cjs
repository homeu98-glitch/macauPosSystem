// 深入分析（第二輪）：時間校正、重試風暴、每分鐘節奏、device 指紋
const fs = require("fs");
const path = require("path");
const HOME = process.env.USERPROFILE || process.env.HOME;
const VERCEL = path.join(HOME, "Downloads", "macau-pos-system-log-export-2026-09-22T12-14-12.csv");
const SB = path.join(HOME, "Downloads", "supabase_logs (14).csv");
const OUT = [];
const say = (...a) => {
  OUT.push(a.join(" "));
  console.log(...a);
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inq = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inq) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inq = false;
      } else cell += c;
    } else if (c === '"') inq = true;
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
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const header = rows.shift();
  return rows
    .filter((r) => r.length > 1)
    .map((r) => {
      const o = {};
      header.forEach((h, i) => (o[h] = (r[i] ?? "").replace(/^"|"$/g, "")));
      return o;
    });
}
/** Vercel TimeUTC 係 UTC 無 Z；Supabase date 係 ISO（已去引號）→ 一律 +8 轉澳門。 */
const macau = (s) => {
  if (!s) return "";
  const iso = /Z$|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return s;
  return new Date(t + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
};
const minute = (s) => macau(s).slice(0, 16);
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

// ───────── Vercel ─────────
say("=========== VERCEL（時間已校正為澳門） ===========");
const v = parseCsv(fs.readFileSync(VERCEL, "utf8"));
const vt = v.map((r) => r.TimeUTC).filter(Boolean).sort();
say(`rows=${v.length}  窗口 ${macau(vt[0])} → ${macau(vt[vt.length - 1])}（澳門）`);
const reqs = new Set(v.map((r) => r.requestId));
say(`唯一 requestId = ${reqs.size}（16 分鐘內）`);

// 每分鐘 × 路徑（去重按 requestId）
const perMin = new Map();
const seen = new Set();
for (const r of v) {
  const key = r.requestId + "|" + r.message;
  if (seen.has(key)) continue;
  seen.add(key);
  const p = String(r.requestPath).replace(/^macau-pos-system\.vercel\.app/, "");
  bump(perMin, `${minute(r.TimeUTC)} ${p}`);
}
say("\n### 每分鐘請求數（去重後；只列 pos/sync 同 pos/state）");
const mins = [...perMin.entries()].filter(([k]) => /pos\/sync|pos\/state/.test(k)).sort();
let cur = "";
for (const [k, n] of mins) {
  const [m, p] = k.split(" ");
  if (m !== cur) {
    say(`  --- ${m} ---`);
    cur = m;
  }
  say(`      ${String(n).padStart(3)}  ${p}`);
}

// 拒絕覆寫：按訂單聚合 + 重試次數
const rej = v.filter((r) => /拒絕覆寫/.test(r.message || ""));
const byOrder = new Map();
const byReason = new Map();
for (const r of rej) {
  const m = r.message.match(/拒絕覆寫訂單\s+([\w-]+)（現有=([^，]+)，incoming=([^，]+)，\s*(.+?)）/);
  if (!m) continue;
  byOrder.set(m[1], (byOrder.get(m[1]) || 0) + 1);
  bump(byReason, m[4].trim());
}
say(`\n### 拒絕覆寫：共 ${rej.length} 行，涉及 ${byOrder.size} 張單`);
say("  —— 每張單被拒次數（前 25）——");
[...byOrder.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25)
  .forEach(([id, n]) => say(`   ${String(n).padStart(4)}  ${id}`));
say("  —— 理由分佈 ——");
[...byReason.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => say(`   ${String(n).padStart(4)}  ${k}`));

// 同一張單的重試節奏（睇係咪每 X 秒 retry 一次）
const focus = [...byOrder.entries()].sort((a, b) => b[1] - a[1])[0];
if (focus) {
  const hits = rej.filter((r) => r.message.includes(focus[0])).map((r) => Date.parse(r.TimeUTC + "Z"));
  say(`\n### 最多被拒嘅單 ${focus[0]}：${hits.length} 次；首尾 = ${macau(new Date(hits[0]).toISOString().slice(0,19))} → ${macau(new Date(hits[hits.length-1]).toISOString().slice(0,19))}`);
  const gaps = [];
  for (let i = 1; i < hits.length; i += 1) gaps.push(hits[i] - hits[i - 1]);
  if (gaps.length) {
    gaps.sort((a, b) => a - b);
    say(`  間隔（ms）中位=${gaps[Math.floor(gaps.length / 2)]} 最小=${gaps[0]} 最大=${gaps[gaps.length - 1]}`);
  }
}

// 全部 egress 行的原始訊息（去重），按時間排
say("\n### 所有 pos/state [egress] 行（去重，按時間 asc）");
const eg = [...new Set(v.filter((r) => /\[egress\]/.test(r.message || "")).map((r) => r.TimeUTC + "|" + r.message))]
  .sort()
  .map((s) => s.split("|"));
for (const [t, m] of eg) say(`  ${macau(t)}  ${m}`);

// device 指紋
const ua = new Map();
for (const r of v) bump(ua, (r.requestUserAgent || "(empty)").slice(0, 90));
say("\n### User-Agent 分佈");
[...ua.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => say(`  ${String(n).padStart(5)}  ${k}`));

// ───────── Supabase ─────────
say("\n\n=========== SUPABASE（時間已校正為澳門） ===========");
const s = parseCsv(fs.readFileSync(SB, "utf8"));
const st = s.map((r) => r.date).filter(Boolean).sort();
say(`rows=${s.length}  窗口 ${macau(st[0])} → ${macau(st[st.length - 1])}（澳門）`);

say("\n### 非 2xx（已修正引號，只列真正異常）");
const bad = s.filter((r) => !/^(2\d\d|101|204|201)$/.test(String(r.status)));
const badAgg = new Map();
for (const r of bad) bump(badAgg, `${r.status} ${r.method} ${r.pathname} | ${String(r.event_message).slice(0, 90)}`);
[...badAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, n]) => say(`  ${String(n).padStart(4)}  ${k}`));

say("\n### level=error / warning 原文");
s.filter((r) => r.level === "error" || r.level === "warning")
  .forEach((r) => say(`  [${macau(r.date)}] ${r.level} ${r.status} ${r.pathname} :: ${String(r.event_message).slice(0, 300)}`));

say("\n### 每分鐘 Supabase 寫入（POST/PATCH）節奏");
const wpm = new Map();
for (const r of s) {
  if (!/^(POST|PATCH|PUT|DELETE)$/.test(r.method)) continue;
  bump(wpm, `${minute(r.date)} ${r.method} ${r.pathname}`);
}
[...wpm.entries()].sort().forEach(([k, n]) => say(`  ${String(n).padStart(3)}  ${k}`));

say("\n### pos_orders 讀取：每分鐘 GET 次數（睇有冇循環）");
const rpm = new Map();
for (const r of s) {
  if (r.pathname !== "/rest/v1/pos_orders") continue;
  bump(rpm, minute(r.date));
}
[...rpm.entries()].sort().forEach(([k, n]) => say(`  ${String(n).padStart(3)}  ${k}`));

fs.writeFileSync(path.join(__dirname, "_analyze-logs-20260922-2016b.out.txt"), OUT.join("\n"), "utf8");
