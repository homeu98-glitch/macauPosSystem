/**
 * `tools/log-recheck.cjs` —— POS 日誌覆核統一入口（2026-09-23 建立）
 *
 * 用法：
 *   node tools/log-recheck.cjs --vercel "<macau-pos-system-log-export-*.csv>"
 *   node tools/log-recheck.cjs --supabase "<supabase_logs (*).csv>"
 *   node tools/log-recheck.cjs --both "<vercel.csv>" "<supabase.csv>"
 *
 * 為何要呢支腳本（由 2026-09-23 覆核總結出嘅三個陷阱）：
 *
 * 1. 🔴 **Vercel log 一行 log = 一行 CSV**，同一個 HTTP 請求會展開成 N 行
 *    （共用同一個 `requestId`）。實測 160 行 → **只有 60 個唯一請求**，
 *    其中一個 `/api/pos/sync` 佔 81 行（因為佢喺一個請求內拒收了 78 張 stale 單）。
 *    ⇒ **任何計數之前必須按 `requestId` 去重**，否則請求量會嚴重高估。
 *
 * 2. 🔴 **兩份 log 嘅窗口通常唔重疊**（今次 Vercel 只有 27 分鐘、Supabase 6 小時，
 *    只重疊 27 分鐘）⇒ 唔可以逐項互相對質，只能各用自己窗口嘅**速率**比較。
 *
 * 3. 🔴 CSV 有**引號內換行**（`logs` / `event_message` 欄）⇒ 唔可以 `split('\n')`，
 *    要用 RFC4180 parser，否則行數會多出 ~20%（今次 1220 行 → 實際 1000 筆）。
 *
 * 另外：Supabase 匯出上限一般 **1,000 筆**；pos_orders 明細 anon 可讀但 `pos_egress_daily`
 * 已鎖（查帳單 MB 要去 Supabase Dashboard → Egress per day，或 Admin「雲端用量」頁）。
 */
const fs = require("node:fs");

// ── RFC4180 CSV parser（支援引號包裹、`""` escape、欄位內逗號／換行）────────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function toObjects(path) {
  const rows = parseCsv(fs.readFileSync(path, "utf8"));
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => (r[0] || "").trim() || (r[1] || "").trim())
    .map((r) => { const o = {}; head.forEach((h, i) => (o[h] = (r[i] ?? "").trim())); return o; });
}
/** UTC（無 Z 後綴會被 JS 當本地時間）→ 澳門，安全轉法。 */
function macStr(isoNoZ) {
  const base = isoNoZ.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(isoNoZ) ? isoNoZ : isoNoZ + "Z";
  return new Date(new Date(base).getTime() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
}
function top(map, n) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n || 20);
}

// ── Vercel ────────────────────────────────────────────────────────────────────
function vercel(path) {
  const raw = toObjects(path).filter((r) => r.TimeUTC);
  const uniq = new Map();
  raw.forEach((r) => { if (!uniq.has(r.requestId)) uniq.set(r.requestId, r); });
  const reqs = [...uniq.values()];
  const t = raw.map((r) => r.TimeUTC).sort();
  console.log("== Vercel ==");
  console.log("CSV 行數", raw.length, "｜唯一請求（requestId 去重）", reqs.length,
    "｜展開倍數", (raw.length / reqs.length).toFixed(2));
  console.log("窗口 MAC", macStr(t[0]), "→", macStr(t[t.length - 1]));
  const byPath = {};
  reqs.forEach((r) => { const k = r.requestPath || "?"; byPath[k] = (byPath[k] || 0) + 1; });
  console.log("-- 唯一請求 by path --");
  top(byPath, 25).forEach(([k, v]) => console.log(String(v).padStart(4), k));
  console.log("-- UA --");
  const ua = {}; reqs.forEach((r) => { const k = (r.requestUserAgent || "(none)").slice(0, 60); ua[k] = (ua[k] || 0) + 1; });
  top(ua, 10).forEach(([k, v]) => console.log(String(v).padStart(4), k));
  console.log("-- 非 2xx --");
  reqs.filter((r) => Number(r.responseStatusCode) >= 400)
    .forEach((r) => console.log(macStr(r.TimeUTC), r.responseStatusCode, r.requestPath));
  console.log("-- 每個多行請求（一次請求內發生咩事）--");
  const g = {};
  raw.forEach((r) => { const k = r.requestId; (g[k] = g[k] || { t: r.TimeUTC, p: r.requestPath, ms: [] }).ms.push((r.message || "").replace(/\s+/g, " ").trim()); });
  Object.values(g).filter((v) => v.ms.filter(Boolean).length > 1).forEach((v) => {
    const c = {}; v.ms.forEach((m) => { if (!m) return; const k = m.startsWith("[pos/sync] 拒絕覆寫訂單") ? "拒絕覆寫訂單(stale)" : m.slice(0, 90); c[k] = (c[k] || 0) + 1; });
    console.log("---", macStr(v.t), v.p, "共", v.ms.length, "行");
    top(c, 6).forEach(([k, n]) => console.log("     ", String(n).padStart(4), k));
  });
  console.log("-- [egress] 行（逐條原文）--");
  raw.filter((r) => (r.message || "").includes("[egress]"))
    .forEach((r) => console.log(macStr(r.TimeUTC), (r.message || "").replace(/\s+/g, " ")));
}

// ── Supabase ──────────────────────────────────────────────────────────────────
function supabase(path) {
  const d = toObjects(path);
  const ts = d.map((r) => r.timestamp).filter(Boolean).sort();
  console.log("== Supabase ==");
  console.log("筆數", d.length, "（匯出上限一般 1,000）｜窗口 MAC", macStr(ts[0]), "→", macStr(ts[ts.length - 1]));
  const edge = d.filter((r) => r.log_type === "edge");
  const spanMin = (new Date(ts[ts.length - 1] + "Z") - new Date(ts[0] + "Z")) / 60000;
  console.log("edge 請求", edge.length, "｜窗口", spanMin.toFixed(1), "分鐘｜速率", (edge.length / spanMin).toFixed(2), "/分 →", Math.round((edge.length / spanMin) * 1440), "/日");
  const by = {};
  edge.forEach((r) => { const k = (r.method || "?") + " " + (r.pathname || "?"); by[k] = (by[k] || 0) + 1; });
  console.log("-- 路徑組成 --");
  top(by, 25).forEach(([k, v]) => console.log(String(v).padStart(4), ((v / edge.length) * 100).toFixed(1).padStart(5) + "%", k));
  const tri = edge.filter((r) => /pos_print_agents|pos_claim_print_jobs|pos_device_configs/.test(r.pathname || "")).length;
  console.log("-- 三巨頭（print_agents / claim / device_configs）", tri, ((tri / edge.length) * 100).toFixed(1) + "%");
  console.log("-- 每小時（澳門）＋ 各 agent 分佈 --");
  const hr = {};
  edge.forEach((r) => {
    const k = macStr(r.timestamp).slice(0, 13);
    const ag = ((r.event_message || "").match(/agent_id=eq\.(ag-[0-9a-f]{8})/) || [, "(其他)"])[1];
    hr[k] = hr[k] || {}; hr[k][ag] = (hr[k][ag] || 0) + 1;
  });
  Object.entries(hr).sort().forEach(([k, v]) => console.log(k, JSON.stringify(v)));
  console.log("-- 指紋：pos_queue_events limit（300＝舊 / 0＝新）--");
  const lim = {};
  edge.filter((r) => /pos_queue_events/.test(r.pathname || "")).forEach((r) => {
    const m = ((r.event_message || "").match(/limit=(\d+)/) || [, "?"])[1];
    lim[m] = (lim[m] || 0) + 1;
  });
  console.log(lim);
  console.log("-- claim 間隔 --");
  console.log("   ⚠️ 若同時有 N 部中繼機，混算嘅中位數會被腰斬成 1/N。");
  console.log("      判別法：睇直方圖有冇『多峰』，同埋每個 agent_id 自己嘅 PATCH 間隔。");
  const cl = edge.filter((r) => /pos_claim_print_jobs/.test(r.pathname || "")).map((r) => new Date(r.timestamp + "Z").getTime()).sort((a, b) => a - b);
  const cg = []; for (let i = 1; i < cl.length; i++) cg.push((cl[i] - cl[i - 1]) / 1000);
  if (cg.length) {
    const s = [...cg].sort((a, b) => a - b);
    console.log("  n", cl.length, "｜中位", s[Math.floor(s.length / 2)].toFixed(0) + "s", "｜P90", s[Math.floor(s.length * 0.9)].toFixed(0) + "s");
    const hist = {};
    cg.forEach((g) => { const b = g < 25 ? "<25s" : g < 55 ? "25-55" : g < 95 ? "55-95" : g < 150 ? "95-150" : g < 210 ? "150-210(≈180s 上限)" : ">=210"; hist[b] = (hist[b] || 0) + 1; });
    console.log("  直方圖", hist);
  }
  // 逐 agent 嘅 PATCH（=心跳）間隔 —— 呢個係「每部機自己嘅真實節奏」，唔會被多機混算污染。
  const perAgent = {};
  edge.filter((r) => /pos_print_agents/.test(r.pathname || "") && r.method === "PATCH").forEach((r) => {
    const ag = ((r.event_message || "").match(/agent_id=eq\.(ag-[0-9a-f]{8})/) || [, "(unknown)"])[1];
    (perAgent[ag] = perAgent[ag] || []).push(new Date(r.timestamp + "Z").getTime());
  });
  Object.entries(perAgent).forEach(([ag, arr]) => {
    arr.sort((a, b) => a - b);
    const g = []; for (let i = 1; i < arr.length; i++) g.push((arr[i] - arr[i - 1]) / 1000);
    const s = [...g].sort((a, b) => a - b);
    console.log("  agent", ag, "PATCH n=" + arr.length,
      g.length ? "中位 " + s[Math.floor(s.length / 2)].toFixed(0) + "s / P90 " + s[Math.floor(s.length * 0.9)].toFixed(0) + "s" : "",
      "最後出現 MAC", macStr(new Date(arr[arr.length - 1]).toISOString().slice(0, 19)));
  });
  console.log("-- realtime websocket --");
  const rt = edge.filter((r) => /realtime/.test(r.pathname || ""));
  console.log("連線", rt.length, "｜平均每", rt.length ? (spanMin / rt.length).toFixed(1) : "-", "分鐘一次");
  console.log("-- postgres log 內嘅 error / migration 事件 --");
  d.filter((r) => r.log_type === "postgres" && /error|duplicate|rls_auto_enable|ALTER TABLE|CREATE TABLE/i.test(r.event_message || ""))
    .slice(0, 40).forEach((r) => console.log(macStr(r.timestamp), r.status, (r.event_message || "").replace(/\s+/g, " ").slice(0, 170)));
}

const a = process.argv.slice(2);
const mode = a[0];
if (mode === "--vercel") vercel(a[1]);
else if (mode === "--supabase") supabase(a[1]);
else if (mode === "--both") { vercel(a[1]); console.log(""); supabase(a[2]); }
else console.log(fs.readFileSync(__filename, "utf8").split("*/")[0] + "*/");
