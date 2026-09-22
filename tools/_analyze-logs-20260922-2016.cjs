// 分析 2026-09-22 兩個 log（Vercel + Supabase）—— 錯誤類型／頻率／關聯
// 用法：node tools/_analyze-logs-20260922-2016.cjs
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

/** 極簡 CSV 解析（支援雙引號包住、內部 "" escape、欄內換行）。 */
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
      header.forEach((h, i) => (o[h] = r[i] ?? ""));
      return o;
    });
}

const macau = (iso) => {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
};
const counter = () => ({ n: 0, first: null, last: null });
function bump(map, key, ts) {
  const c = map.get(key) || counter();
  c.n += 1;
  if (!c.first || (ts && ts < c.first)) c.first = ts;
  if (!c.last || (ts && ts > c.last)) c.last = ts;
  map.set(key, c);
}
const dump = (label, map, limit = 40) => {
  say(`\n### ${label}（${map.size} 種）`);
  [...map.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, limit)
    .forEach(([k, v]) => say(`  ${String(v.n).padStart(5)}  ${k}   [${macau(v.first)} → ${macau(v.last)}]`));
};

// 正規化：把 id / 數字 / 時間換成佔位，方便聚合
const norm = (s) =>
  String(s || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b(order|kiosk|staff|ledger|print|evt)-[0-9a-zA-Z]+/g, "<id>")
    .replace(/20\d\d-\d\d-\d\dT[\d:.]+/g, "<ts>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .trim();

// ───────────────────────── Vercel ─────────────────────────
say("================ VERCEL LOG ================");
const v = parseCsv(fs.readFileSync(VERCEL, "utf8"));
say(`rows=${v.length}  窗口 ${macau(v[v.length - 1]?.TimeUTC)} → ${macau(v[0]?.TimeUTC)}（澳門）`);

const byLevel = new Map();
const byPath = new Map();
const errMsgs = new Map();
const errByPath = new Map();
const requestIds = new Set();
for (const r of v) {
  requestIds.add(r.requestId);
  bump(byLevel, r.level || "(empty)", r.TimeUTC);
  bump(byPath, `${r.requestMethod} ${String(r.requestPath).replace(/^macau-pos-system\.vercel\.app/, "")}`, r.TimeUTC);
  const lv = String(r.level || "").toLowerCase();
  const isErr = lv === "error" || /錯誤|error|失敗|拒絕|🔴/.test(String(r.message || ""));
  if (isErr) {
    bump(errMsgs, norm(r.message), r.TimeUTC);
    bump(errByPath, `${String(r.requestPath).replace(/^macau-pos-system\.vercel\.app/, "")} | ${lv || "?"}`, r.TimeUTC);
  }
}
say(`\n唯一 requestId = ${requestIds.size}（每請求通常 2–3 行 ⇒ 實際請求少於行數）`);
dump("level 分佈", byLevel, 10);
dump("路徑分佈（前 20）", byPath, 20);
dump("疑似 error/warning 訊息（正規化後）", errMsgs, 30);
dump("錯誤集中嘅路徑", errByPath, 20);

// 抽出幾類重點訊息的原始樣本
const pick = (re, label, limit = 4) => {
  const hits = v.filter((r) => re.test(String(r.message || "")));
  say(`\n### ${label}：共 ${hits.length} 行`);
  hits.slice(0, limit).forEach((r) => say(`  [${macau(r.TimeUTC)}] ${String(r.message).slice(0, 260)}`));
  if (hits.length > limit) {
    const last = hits[hits.length - 1];
    say(`  … 最後一行 [${macau(last.TimeUTC)}] ${String(last.message).slice(0, 200)}`);
  }
  return hits;
};
const rejectHits = pick(/拒絕覆寫/, "🔴 pos/sync 拒絕覆寫訂單");
const staleHits = pick(/疑似舊版 bundle/, "🔴 疑似舊版 bundle 全量拉取", 3);
const egressHits = pick(/\[egress\]/, "[egress] 行", 3);
const errLevel = v.filter((r) => String(r.level).toLowerCase() === "error");
say(`\n### level=error 共 ${errLevel.length} 行`);
errLevel.slice(0, 8).forEach((r) => say(`  [${macau(r.TimeUTC)}] ${String(r.requestPath).slice(-40)} :: ${String(r.message).slice(0, 260)}`));

// 拒絕覆寫：抽出 order id
const rejectOrders = new Map();
for (const r of rejectHits) {
  const m = String(r.message || "").match(/拒絕覆寫訂單\s+([\w-]+)\s*[（(]([^）)]*)/);
  if (m) bump(rejectOrders, `${m[1]}  現有=${m[2]}`.slice(0, 150), r.TimeUTC);
}
dump("拒絕覆寫：涉及邊張單／現有狀態", rejectOrders, 20);

// egress 聚合
const egressModes = new Map();
let egressBytes = 0;
for (const r of egressHits) {
  const s = String(r.message || "");
  const mode = (s.match(/mode=(\w+)/) || [])[1] || "?";
  const bytes = Number((s.match(/bytes=(\d+)/) || [])[1] || 0);
  const orders = (s.match(/orders=(\d+)/) || [])[1] ?? "?";
  const legacy = (s.match(/legacy=(\d+)/) || [])[1] ?? "?";
  egressBytes += bytes;
  bump(egressModes, `mode=${mode} legacy=${legacy} orders=${orders}`, r.TimeUTC);
}
dump("[egress] 模式／行數分佈", egressModes, 20);
say(`[egress] 總 bytes（本窗口、已去重前）= ${(egressBytes / 1024 / 1024).toFixed(2)} MB`);

// ───────────────────────── Supabase ─────────────────────────
say("\n\n================ SUPABASE LOG ================");
const s = parseCsv(fs.readFileSync(SB, "utf8"));
say(`rows=${s.length}  窗口 ${macau(s[s.length - 1]?.date)} → ${macau(s[0]?.date)}（澳門）`);
const sbLevel = new Map();
const sbStatus = new Map();
const sbPath = new Map();
const sbErr = new Map();
const sbType = new Map();
for (const r of s) {
  bump(sbLevel, r.level || "(empty)", r.date);
  bump(sbType, r.log_type || "(empty)", r.date);
  bump(sbStatus, `${r.status} ${r.method} ${r.pathname}`, r.date);
  bump(sbPath, `${r.method} ${r.pathname}`, r.date);
  const bad = !/^2\d\d$/.test(String(r.status));
  if (bad || String(r.level) === "error") {
    bump(sbErr, `${r.status} ${r.method} ${r.pathname} :: ${norm(String(r.event_message).slice(0, 200))}`, r.date);
  }
}
dump("level", sbLevel, 10);
dump("log_type", sbType, 10);
dump("狀態碼 × 路徑（前 25）", sbStatus, 25);
dump("非 2xx／error", sbErr, 30);

// 非 200 的原始樣本
const sbBad = s.filter((r) => !/^2\d\d$/.test(String(r.status)) || String(r.level) === "error");
say(`\n### Supabase 非 2xx / error 共 ${sbBad.length} 行，樣本：`);
sbBad.slice(0, 10).forEach((r) => say(`  [${macau(r.date)}] ${r.status} ${r.method} ${r.pathname} :: ${String(r.event_message).slice(0, 240)}`));

fs.writeFileSync(path.join(__dirname, "_analyze-logs-20260922-2016.out.txt"), OUT.join("\n"), "utf8");
