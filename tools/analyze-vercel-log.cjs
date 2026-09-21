/**
 * 分析 Vercel log 匯出（2026-09-21 egress 驗收）。
 *
 * 為何呢份 log 好重要（同 Supabase log 比）：
 *   · 有 `requestQueryString` ⇒ 睇得到我哋自己嘅參數（`skipQueue=1` / `ordersOnly=1` / `fields=`）
 *     —— Supabase log 只記 PostgREST URL，永遠睇唔到呢啲。
 *   · 有 `requestUserAgent` ⇒ 分得出**邊部裝置**（Mac Safari / Android APK / etc.）。
 *   · 有 `[egress] … bytes=N`（我加嘅）⇒ **實際 response bytes**，可以直接加總。
 *
 * 用法：node tools/analyze-vercel-log.cjs <vercel-log.csv>
 */
const fs = require("fs");

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const path = process.argv[2];
if (!path) {
  console.error("用法：node tools/analyze-vercel-log.cjs <vercel-log.csv>");
  process.exit(1);
}
const rows = parseCsv(fs.readFileSync(path, "utf8"));
const header = rows[0];
const ix = Object.fromEntries(header.map((h, i) => [h, i]));
const raw = rows.slice(1).filter((r) => r.length > 5 && r[ix.TimeUTC]);

/**
 * 🔴 一定要按 `requestId` 去重：Vercel 匯出每個請求會出 **多行**
 * （實測：1 個請求 = 3 行，其中只有 1 行帶 `message`（我哋嘅 `[egress]` log），
 *  其餘 2 行 `message` 空白）。唔去重會報大 3 倍，而且會出現「無 query string」嘅假分組。
 */
const dedup = new Map();
for (const r of raw) {
  const id = r[ix.requestId];
  const prev = dedup.get(id);
  // 保留有 message 嘅那行（有 egress bytes）；冇就保留第一行
  if (!prev || (!(prev[ix.message] || "").includes("[egress]") && (r[ix.message] || "").includes("[egress]"))) {
    dedup.set(id, r);
  }
}
const data = [...dedup.values()];

console.log(`原始行數：${raw.length} ⇒ 去重後請求數：${data.length}（每請求 ${(raw.length / data.length).toFixed(1)} 行）`);
const times = data.map((r) => r[ix.TimeUTC]).sort();
console.log(`時間範圍（UTC）：${times[0]} → ${times[times.length - 1]}`);
const t0 = Date.parse(times[0].replace(" ", "T") + "Z");
const t1 = Date.parse(times[times.length - 1].replace(" ", "T") + "Z");
const minutes = Math.max((t1 - t0) / 60000, 0.1);
console.log(`跨度：${minutes.toFixed(1)} 分鐘 ⇒ ${(data.length / minutes).toFixed(1)} 請求／分鐘`);

/** 由 message 抽 [egress] 數字。 */
function egressOf(msg) {
  const m = msg.match(/\[egress\]\s+(\S+)\s+bytes=(\d+)(.*)$/);
  if (!m) return null;
  const extra = {};
  for (const kv of m[3].trim().split(/\s+/)) {
    const [k, v] = kv.split("=");
    if (k) extra[k] = v;
  }
  return { tag: m[1], bytes: Number(m[2]), extra };
}

// ── 按路徑 + 參數特徵分組 ──
const byKey = new Map();
for (const r of data) {
  const p = (r[ix.requestPath] || "").replace("macau-pos-system.vercel.app", "");
  const q = r[ix.requestQueryString] || "";
  const ua = (r[ix.requestUserAgent] || "").slice(0, 60);
  const status = r[ix.responseStatusCode];
  const eg = egressOf(r[ix.message] || "");

  const flags = [];
  if (q.includes("ordersOnly=1")) flags.push("ordersOnly");
  if (q.includes("skipQueue=1")) flags.push("skipQueue");
  if (q.includes("fields=")) flags.push("fields");
  if (eg) flags.push(`mode=${eg.extra.mode}`);
  const key = `${p} [${flags.join(",") || "無參數"}]`;

  const cur = byKey.get(key) || { n: 0, bytes: 0, uas: new Map(), statuses: new Map(), egN: 0 };
  cur.n += 1;
  if (eg) {
    cur.bytes += eg.bytes;
    cur.egN += 1;
  }
  cur.uas.set(ua, (cur.uas.get(ua) || 0) + 1);
  cur.statuses.set(status, (cur.statuses.get(status) || 0) + 1);
  byKey.set(key, cur);
}

console.log("\n================ 按路徑／參數分組 ================");
console.log("次數".padStart(6) + "  總bytes".padStart(10) + "  平均".padStart(8) + "  路徑");
for (const [k, v] of [...byKey.entries()].sort((a, b) => b[1].bytes - a[1].bytes || b[1].n - a[1].n)) {
  const avg = v.egN ? Math.round(v.bytes / v.egN) : 0;
  console.log(
    String(v.n).padStart(6) +
      String(v.bytes).padStart(10) +
      String(avg).padStart(8) +
      "  " +
      k,
  );
}

// ── 總 egress（只有有插 log 嘅 route 量得到）──
let totalBytes = 0;
let egCount = 0;
for (const r of data) {
  const eg = egressOf(r[ix.message] || "");
  if (eg) {
    totalBytes += eg.bytes;
    egCount += 1;
  }
}
console.log(`\n================ 實測 egress ================`);
console.log(`有 [egress] 記錄嘅請求：${egCount} / ${data.length}`);
console.log(`合計：${(totalBytes / 1024 / 1024).toFixed(2)} MB（${minutes.toFixed(1)} 分鐘）`);
console.log(`推算每小時：${((totalBytes / minutes) * 60 / 1024 / 1024).toFixed(1)} MB／小時`);
console.log(`推算每日（當同強度跑 x 小時）：見下`);
for (const h of [4, 8, 12]) {
  console.log(`   × ${h} 小時 = ${(((totalBytes / minutes) * 60 * h) / 1024 / 1024).toFixed(0)} MB／日`);
}
console.log("⚠️ 只計有插 [egress] log 嘅 route（現時＝pos/state）；其他 route 未量度。");

// ── User-Agent（邊部裝置）──
console.log("\n================ User-Agent（裝置）排名 ================");
const uaTotal = new Map();
for (const r of data) {
  const ua = (r[ix.requestUserAgent] || "(empty)").slice(0, 70);
  const eg = egressOf(r[ix.message] || "");
  const cur = uaTotal.get(ua) || { n: 0, bytes: 0 };
  cur.n += 1;
  if (eg) cur.bytes += eg.bytes;
  uaTotal.set(ua, cur);
}
for (const [ua, v] of [...uaTotal.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`${String(v.n).padStart(6)} 次  ${(v.bytes / 1024).toFixed(0).padStart(8)} KB  ${ua}`);
}

// ── skipQueue 有冇出現 ──
const withSkip = data.filter((r) => (r[ix.requestQueryString] || "").includes("skipQueue=1"));
const withoutSkip = data.filter(
  (r) =>
    (r[ix.requestPath] || "").includes("/api/pos/state") &&
    !(r[ix.requestQueryString] || "").includes("skipQueue=1"),
);
console.log("\n================ skipQueue 檢查 ================");
console.log(`有 skipQueue=1 嘅 pos/state 請求：${withSkip.length}`);
console.log(`冇 skipQueue=1 嘅 pos/state 請求：${withoutSkip.length}`);
if (withoutSkip.length > 0) {
  const ua = new Map();
  for (const r of withoutSkip) {
    const k = (r[ix.requestUserAgent] || "(empty)").slice(0, 60);
    ua.set(k, (ua.get(k) || 0) + 1);
  }
  console.log("  冇帶 skipQueue 嘅請求，按裝置：");
  for (const [k, n] of [...ua.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${n} 次  ${k}`);
  console.log("  例：", (withoutSkip[0][ix.requestQueryString] || "").slice(0, 200));
}

// ── 非 2xx ──
const bad = data.filter((r) => !/^2/.test(String(r[ix.responseStatusCode])));
if (bad.length) {
  console.log("\n================ 非 2xx 回應 ================");
  const g = new Map();
  for (const r of bad) {
    const k = `${r[ix.responseStatusCode]} ${(r[ix.requestPath] || "").replace("macau-pos-system.vercel.app", "")}`;
    g.set(k, (g.get(k) || 0) + 1);
  }
  for (const [k, n] of [...g.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${k}`);
}

// ── 時間軸（係 burst 定持續？）──
console.log("\n================ 時間軸（每分鐘）================");
const HEAVY = (r) => {
  const eg = egressOf(r[ix.message] || "");
  return eg && eg.extra.mode === "full" && !(r[ix.requestQueryString] || "").includes("skipQueue=1");
};
const perMin = new Map();
for (const r of data) {
  const m = (r[ix.TimeUTC] || "").slice(0, 16);
  const cur = perMin.get(m) || { all: 0, heavy: 0, heavyBytes: 0 };
  cur.all += 1;
  if (HEAVY(r)) {
    cur.heavy += 1;
    const eg = egressOf(r[ix.message] || "");
    if (eg) cur.heavyBytes += eg.bytes;
  }
  perMin.set(m, cur);
}
console.log("分鐘     全部  全量無skip  該分鐘bytes");
for (const [m, v] of [...perMin.entries()].sort()) {
  console.log(
    `${m.slice(11)}    ${String(v.all).padStart(4)}  ${String(v.heavy).padStart(8)}  ${(v.heavyBytes / 1024).toFixed(0).padStart(9)} KB` +
      (v.heavy > 0 ? "   ← 全量拉取" : ""),
  );
}

// ── 每個裝置嘅 skipQueue 行為 ──
console.log("\n================ 每個裝置 × skipQueue ================");
const uaSkip = new Map();
for (const r of data) {
  if (!(r[ix.requestPath] || "").includes("/api/pos/state")) continue;
  const ua = (r[ix.requestUserAgent] || "(empty)").slice(0, 45);
  const has = (r[ix.requestQueryString] || "").includes("skipQueue=1");
  const eg = egressOf(r[ix.message] || "");
  const cur = uaSkip.get(ua) || { withSkip: 0, withoutSkip: 0, bytesWith: 0, bytesWithout: 0 };
  if (has) {
    cur.withSkip += 1;
    if (eg) cur.bytesWith += eg.bytes;
  } else {
    cur.withoutSkip += 1;
    if (eg) cur.bytesWithout += eg.bytes;
  }
  uaSkip.set(ua, cur);
}
for (const [ua, v] of uaSkip.entries()) {
  console.log(`${ua}`);
  console.log(`   有 skipQueue: ${v.withSkip} 次（${(v.bytesWith / 1024).toFixed(0)} KB）`);
  console.log(`   冇 skipQueue: ${v.withoutSkip} 次（${(v.bytesWithout / 1024).toFixed(0)} KB）`);
}
