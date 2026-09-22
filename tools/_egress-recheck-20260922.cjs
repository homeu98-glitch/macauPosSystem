/**
 * 2026-09-22 13:40 egress recheck —— 分析用戶提供嘅兩份 log。
 *
 * 用法：node tools/_egress-recheck-20260922.cjs "<supabase.csv>" "<vercel.csv>"
 *
 * ⚠️ 本機 bash 冇 coreutils、`node -e` 易被引號咬 → 一律寫檔再跑（見 memory 教訓）。
 */
const fs = require("node:fs");

const SB = process.argv[2];
const VC = process.argv[3];

/** 最小 CSV parser（支援雙引號包裹、`""` escape、欄位內逗號／換行）。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      /* skip */
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
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

function fmt(ms) {
  // UTC → 澳門 (+8)
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function windowOf(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return { min, max, spanMs: max - min };
}

function topN(map, n = 25, sortBy = "count") {
  return Object.entries(map)
    .map(([k, v]) => (typeof v === "number" ? { k, count: v } : { k, ...v }))
    .sort((a, b) => (b[sortBy] ?? 0) - (a[sortBy] ?? 0))
    .slice(0, n);
}

const out = [];
function log(...a) {
  const line = a.join(" ");
  out.push(line);
  console.log(line);
}

// ─────────────────────────── Supabase ───────────────────────────
if (SB && fs.existsSync(SB)) {
  const rows = toObjects(parseCsv(fs.readFileSync(SB, "utf8")));
  log("==================== SUPABASE LOG ====================");
  log("rows:", rows.length);

  const items = rows.map((r) => {
    const url = r.event_message || "";
    const m = url.match(/https:\/\/[^/]+\/([^?\s|]+)(\?[^\s|]*)?/);
    const path = m ? "/" + m[1] : r.pathname;
    const qs = m && m[2] ? m[2] : "";
    const params = new URLSearchParams(qs.replace(/^\?/, ""));
    return {
      t: Date.parse(r.timestamp || r.date),
      method: r.method,
      path,
      select: params.get("select") || "",
      limit: params.get("limit") || "",
      status: params.get("status") || "",
      store: params.get("store_id") || "",
      rpc: path.startsWith("/rest/v1/rpc/") ? path.split("/").pop() : "",
      level: r.level,
      raw: url,
    };
  }).filter((x) => Number.isFinite(x.t));

  const w = windowOf(items.map((x) => x.t));
  log(`窗口（澳門時間）：${fmt(w.min)}  →  ${fmt(w.max)}   長度 ${(w.spanMs / 60000).toFixed(1)} 分鐘`);
  log(`平均 ${(items.length / (w.spanMs / 60000)).toFixed(1)} 次/分鐘`);

  // 逐分鐘
  const perMin = {};
  for (const it of items) {
    const k = fmt(it.t).slice(0, 16);
    perMin[k] = (perMin[k] || 0) + 1;
  }
  const minuteEntries = Object.entries(perMin).sort(([a], [b]) => a.localeCompare(b));
  log("\n--- 逐分鐘請求數（頭 5 / 尾 5）---");
  log(minuteEntries.slice(0, 5).map(([k, v]) => `${k} ${v}`).join("\n"));
  log("...");
  log(minuteEntries.slice(-5).map(([k, v]) => `${k} ${v}`).join("\n"));

  // 逐表 / 逐端點
  const byPath = {};
  const byTable = {};
  const byStore = {};
  for (const it of items) {
    byPath[it.path] = (byPath[it.path] || 0) + 1;
    const t = it.path.replace("/rest/v1/", "").replace("rpc/", "rpc:");
    byTable[t] = (byTable[t] || 0) + 1;
    byStore[it.store || "(無)"] = (byStore[it.store || "(無)"] || 0) + 1;
  }
  log("\n--- 逐端點（次數）---");
  log(topN(byPath, 20).map((x) => `${String(x.count).padStart(5)}  ${x.k}`).join("\n"));
  log("\n--- 逐表／RPC（次數）---");
  log(topN(byTable, 20).map((x) => `${String(x.count).padStart(5)}  ${x.k}`).join("\n"));
  log("\n--- 逐 store（次數）---");
  log(topN(byStore, 10).map((x) => `${String(x.count).padStart(5)}  ${x.k}`).join("\n"));

  // 大 payload 嫌疑：帶 limit 嘅查詢 / 全量 select
  const heavy = items.filter((x) => x.limit || x.path === "/rest/v1/rpc/pos_get_state");
  const heavyKey = {};
  for (const it of heavy) {
    const k = `${it.path} limit=${it.limit || "-"} select=${(it.select || "").slice(0, 60)}`;
    heavyKey[k] = (heavyKey[k] || 0) + 1;
  }
  log("\n--- 帶 limit 嘅查詢（次數）＝大 payload 嫌疑 ---");
  log(topN(heavyKey, 20).map((x) => `${String(x.count).padStart(5)}  ${x.k}`).join("\n"));

  // burst 分段（gap > 20 秒）
  const sorted = [...items].sort((a, b) => a.t - b.t);
  const segments = [];
  let cur = null;
  for (const it of sorted) {
    if (!cur || it.t - cur.last > 20000) {
      cur = { start: it.t, last: it.t, n: 1 };
      segments.push(cur);
    } else {
      cur.last = it.t;
      cur.n += 1;
    }
  }
  const big = segments.filter((s) => s.n >= 20).sort((a, b) => b.n - a.n).slice(0, 12);
  log("\n--- burst 分段（同一段內每個請求間隔 ≤20 秒；只列 n≥20）---");
  log(
    big
      .map(
        (s) =>
          `${fmt(s.start)}→${fmt(s.last)}  ${s.n} 次 / ${((s.last - s.start) / 1000).toFixed(0)} 秒 = ${(
            s.n /
            Math.max((s.last - s.start) / 60000, 0.05)
          ).toFixed(1)} 次/分鐘`,
      )
      .join("\n"),
  );

  // 每段內嘅端點分布（最大 3 段）
  for (const s of big.slice(0, 3)) {
    const inside = sorted.filter((x) => x.t >= s.start && x.t <= s.last);
    const m = {};
    for (const x of inside) m[x.path] = (m[x.path] || 0) + 1;
    log(`\n[burst ${fmt(s.start)}] 端點分布：`);
    log(topN(m, 10).map((x) => `   ${String(x.count).padStart(4)}  ${x.k}`).join("\n"));
  }

  // level / status
  const lv = {};
  for (const it of items) lv[it.level] = (lv[it.level] || 0) + 1;
  log("\n--- level ---");
  log(JSON.stringify(lv));
}

// ─────────────────────────── Vercel ───────────────────────────
if (VC && fs.existsSync(VC)) {
  const rows = toObjects(parseCsv(fs.readFileSync(VC, "utf8")));
  log("\n\n==================== VERCEL LOG ====================");
  log("rows:", rows.length);

  const byId = new Map();
  for (const r of rows) {
    const id = r.requestId || r.invocationId || Math.random().toString(36);
    if (!byId.has(id)) byId.set(id, r);
  }
  log(`唯一 requestId：${byId.size}（原始 ${rows.length} 行）`);

  const items = [...byId.values()].map((r) => ({
    t: Number(r.timestampInMs || Date.parse(r.TimeUTC)),
    path: String(r.requestPath || "").replace(/^[^/]*/, ""),
    qs: r.requestQueryString || "",
    status: r.responseStatusCode,
    dur: Number(r.durationMs || 0),
    ua: (r.requestUserAgent || "").slice(0, 40),
    level: r.level,
  })).filter((x) => Number.isFinite(x.t));

  const w = windowOf(items.map((x) => x.t));
  log(`窗口（澳門時間）：${fmt(w.min)}  →  ${fmt(w.max)}   長度 ${(w.spanMs / 60000).toFixed(1)} 分鐘`);
  log(`平均 ${(items.length / Math.max(w.spanMs / 60000, 0.01)).toFixed(2)} 次/分鐘`);

  const byPath = {};
  const byUa = {};
  const byStatus = {};
  for (const it of items) {
    byPath[it.path] = (byPath[it.path] || 0) + 1;
    byUa[it.ua] = (byUa[it.ua] || 0) + 1;
    byStatus[it.status] = (byStatus[it.status] || 0) + 1;
  }
  log("\n--- 逐端點（次數）---");
  log(topN(byPath, 25).map((x) => `${String(x.count).padStart(5)}  ${x.k}`).join("\n"));
  log("\n--- 逐 User-Agent（判「係 APK 定瀏覽器」）---");
  log(topN(byUa, 10).map((x) => `${String(x.count).padStart(5)}  ${x.k}`).join("\n"));
  log("\n--- status ---");
  log(JSON.stringify(byStatus));

  // 逐分鐘
  const perMin = {};
  for (const it of items) {
    const k = fmt(it.t).slice(0, 16);
    perMin[k] = (perMin[k] || 0) + 1;
  }
  const me = Object.entries(perMin).sort(([a], [b]) => a.localeCompare(b));
  log("\n--- 逐分鐘（全部）---");
  log(me.map(([k, v]) => `${k} ${v}`).join("\n"));

  // 每端點 query 指紋
  const byQ = {};
  for (const it of items) {
    const k = `${it.path}?${it.qs}`.slice(0, 120);
    byQ[k] = (byQ[k] || 0) + 1;
  }
  log("\n--- 端點＋query 指紋（次數）---");
  log(topN(byQ, 25).map((x) => `${String(x.count).padStart(5)}  ${x.k}`).join("\n"));
}

fs.writeFileSync("tools/_egress-recheck-20260922.out.txt", out.join("\n"), "utf8");
console.log("\n（完整輸出已寫入 tools/_egress-recheck-20260922.out.txt）");
