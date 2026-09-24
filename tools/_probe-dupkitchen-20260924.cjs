/**
 * 唯讀取證（2026-09-24）：廚房單重複 + 收據卡「已發送」+ 空單號 job。
 *
 * 零憑證：由線上 bundle 抽公開 anon key，直讀 POS 專案 PostgREST。
 * 輸出：pos_print_jobs 全欄位（近 24h）＋ 重複分組 ＋ 空單號統計 ＋ print agents。
 */
const https = require("node:https");
const fs = require("node:fs");

function get(url, headers) {
  return new Promise((res, rej) => {
    const req = https.get(url, { headers: headers || { "user-agent": "Mozilla/5.0" } }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    });
    req.on("error", rej);
    req.setTimeout(20000, () => req.destroy(new Error("timeout")));
  });
}

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const H = "https://iyrywzormzisyppkokbi.supabase.co";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const out = [];
const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };

const mac = (s) => (s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19) : "-");

(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/prints", "/pos", "/"]) {
    try {
      const r = await get(base + p);
      (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch {}
  }
  let K = "";
  for (const s of chunks) {
    try {
      const r = await get(base + s);
      const m = r.body.match(JWT);
      if (m && m.length) { K = m[0]; break; }
    } catch {}
  }
  if (!K) { log("no key"); fs.writeFileSync("tools/_probe-dupkitchen-20260924.out.txt", out.join("\n")); return; }
  // 確認係 POS 專案
  try {
    const p = JSON.parse(Buffer.from(K.split(".")[1], "base64").toString());
    log("anon key ref =", p.ref, "| chunks =", chunks.size);
  } catch {}
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const q = (path) => get(`${H}/rest/v1/${path}`, h);

  // ── 1) pos_print_jobs 近 24h 全欄位 ──
  const pj = await q(`pos_print_jobs?select=*&order=created_at.desc&limit=1000`);
  log("\n=== pos_print_jobs status = " + pj.status + " ===");
  let jobs = [];
  try { jobs = JSON.parse(pj.body); } catch { log(String(pj.body).slice(0, 400)); }
  if (!Array.isArray(jobs)) { log("回非陣列：", String(pj.body).slice(0, 300)); jobs = []; }
  log("筆數 =", jobs.length);
  log("表頭 =", jobs[0] ? Object.keys(jobs[0]).join(",") : "-");

  const byStatus = {};
  const byKindStatus = {};
  let blankOrderNo = 0;
  for (const x of jobs) {
    byStatus[x.status] = (byStatus[x.status] || 0) + 1;
    const k = `${x.ticket_type || "-"}/${x.printer_group || "-"}/${x.status}`;
    byKindStatus[k] = (byKindStatus[k] || 0) + 1;
    if (!x.order_no || String(x.order_no).trim() === "" || /undefined|null/.test(String(x.order_no))) blankOrderNo += 1;
  }
  log("狀態分佈 =", JSON.stringify(byStatus));
  log("空/異常 order_no 筆數 =", blankOrderNo, "/", jobs.length);
  log("ticket_type|printer_group|status =", JSON.stringify(byKindStatus, null, 1));

  log("\n=== 逐行（澳門時間）===");
  log(
    "id".padEnd(20) + " st".padEnd(10) + " kind".padEnd(9) + " tt".padEnd(8) + " grp".padEnd(10) +
    " orderNo".padEnd(14) + " table".padEnd(12) + " try by".padEnd(24) + " once_key".padEnd(42) +
    " created".padEnd(16) + " finished".padEnd(16) + " err",
  );
  for (const x of jobs) {
    log(
      String(x.id).padEnd(20) +
      String(x.status).padEnd(10) +
      String(x.kind ?? "-").padEnd(9) +
      String(x.ticket_type ?? "-").padEnd(8) +
      String(x.printer_group ?? "-").padEnd(10) +
      String(x.order_no ?? "-").padEnd(14) +
      String(x.table_name ?? "-").padEnd(12) +
      `${x.attempts ?? "-"}/${String(x.claimed_by ?? "-").slice(0, 14)}`.padEnd(24) +
      String(x.once_key ?? "-").padEnd(42) +
      mac(x.created_at).padEnd(16) +
      mac(x.finished_at).padEnd(16) +
      String(x.last_error ?? "").slice(0, 60),
    );
  }

  // ── 2) 重複分組（同 order_id + printer_id + ticket_type 多過一行）──
  log("\n=== 重複分組（order_id + printer_id + ticket_type）===");
  const groups = new Map();
  for (const x of jobs) {
    if (!x.order_id) continue;
    const key = `${x.order_id}|${x.printer_id ?? "-"}|${x.ticket_type ?? "-"}|${x.printer_group ?? "-"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  let dupGroups = 0, dupRows = 0;
  for (const [key, rows] of groups) {
    if (rows.length > 1) { dupGroups += 1; dupRows += rows.length; }
  }
  log(`重複組數 = ${dupGroups}（涉及 ${dupRows} 行）／ 總組數 ${groups.size}`);
  for (const [key, rows] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 25)) {
    if (rows.length < 2) continue;
    log(`  ×${rows.length} ${key}`);
    for (const r of rows) {
      log(`      ${r.id} st=${r.status} once=${r.once_key ?? "-"} created=${mac(r.created_at)} fin=${mac(r.finished_at)} err=${String(r.last_error ?? "").slice(0, 40)}`);
    }
  }

  // ── 3) 按 order_id 統計（任何類型，睇同張單出咗幾多張紙）──
  log("\n=== 同張單出紙總數 top 15 ===");
  const byOrder = new Map();
  for (const x of jobs) {
    if (!x.order_id) continue;
    byOrder.set(x.order_id, (byOrder.get(x.order_id) || 0) + 1);
  }
  for (const [oid, n] of [...byOrder.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    log(`  ${oid} → ${n} 行`);
  }

  // ── 4) once_key 為 NULL 嘅行（＝人手補打 / 加菜 / 退菜，或者舊版）──
  const nullOnce = jobs.filter((x) => !x.once_key);
  log(`\n=== once_key IS NULL 筆數 = ${nullOnce.length} ===`);
  const nullOnceByGrp = {};
  for (const x of nullOnce) {
    const k = `${x.ticket_type || "-"}/${x.printer_group || "-"}`;
    nullOnceByGrp[k] = (nullOnceByGrp[k] || 0) + 1;
  }
  log(" 分組 =", JSON.stringify(nullOnceByGrp));

  // ── 5) 中繼 agent 狀態 ──
  const ag = await q(`pos_print_agents?select=agent_id,store_id,name,revoked_at,last_seen_at&order=last_seen_at.desc&limit=20`);
  log("\n=== pos_print_agents ===");
  try {
    for (const a of JSON.parse(ag.body)) {
      log(`  ${a.agent_id} name=${a.name} store=${a.store_id} revoked=${a.revoked_at ?? "-"} last_seen=${mac(a.last_seen_at)}`);
    }
  } catch { log(String(ag.body).slice(0, 200)); }

  // ── 6) 訂單對照（近 24h，睇 order_no / status）──
  const od = await q(`pos_orders?select=id,local_order_no,table_name,status,source,created_at&order=created_at.desc&limit=40`);
  log("\n=== pos_orders 近 40 張 ===");
  try {
    for (const o of JSON.parse(od.body)) {
      log(`  ${o.id} no=${o.local_order_no ?? "-"} table=${o.table_name ?? "-"} st=${o.status} src=${o.source ?? "-"} created=${mac(o.created_at)}`);
    }
  } catch { log(String(od.body).slice(0, 200)); }

  fs.writeFileSync("tools/_probe-dupkitchen-20260924.out.txt", out.join("\n"));
  log("\n[已寫入 tools/_probe-dupkitchen-20260924.out.txt]");
})();
