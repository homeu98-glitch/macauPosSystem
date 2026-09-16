// probe v6：核實 Ledger 的說法（全部唯讀、唔需要 secret）
//   目的 1：舊 App 同 1.1.10 是否共用同一個 agentId？
//           → 睇 pos_print_jobs 的 claimed_by 有幾個唔同值、各自時間範圍
//   目的 2：各 agentId 的第一次／最後一次 claim 時間 → 判「換機」時點
//   目的 3：GET /pair?agentId=<真> 兩欄是否為空（Ledger 要求貼的那個）
//   目的 4：今日 pending 是否有任何 claim（驗「新 App 從未 claim」）
const https = require("https");
const SITE = "https://macau-pos-system.vercel.app";

function req(method, url, headers = {}, body = null) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const r = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on("error", (e) => resolve({ status: 0, error: e.message }));
    if (body) r.write(body);
    r.end();
  });
}
const toMC = (s) =>
  s ? new Date(new Date(s).getTime() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19) : "NULL";

(async () => {
  const home = await req("GET", SITE + "/prints", { "user-agent": "Mozilla/5.0" });
  const js = [...new Set((home.body || "").match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let anonKey = null;
  for (const p of js) {
    const r = await req("GET", SITE + p, { "user-agent": "Mozilla/5.0" });
    const m = (r.body || "").match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    if (m) {
      try {
        const pl = JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString("utf8"));
        if (pl.ref === "iyrywzormzisyppkokbi") { anonKey = m[0]; break; }
      } catch {}
    }
  }
  if (!anonKey) { console.log("搵唔到 anon key"); return; }
  console.log("✅ 取得 POS 專案 anon key（ref=iyrywzormzisyppkokbi）\n");

  const base = "https://iyrywzormzisyppkokbi.supabase.co/rest/v1";
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "content-type": "application/json" };

  // ── 目的 1 & 2：所有曾有 claimed_by 的行，按 agent 分組
  const rc = await req(
    "GET",
    `${base}/pos_print_jobs?select=id,created_at,status,attempts,claimed_by,claimed_at,updated_at,last_error&claimed_by=not.is.null&order=claimed_at.asc&limit=200`,
    h
  );
  console.log("① 所有 claimed_by 非 NULL 的行（按 claimed_at 升序）:");
  let rows = [];
  try { rows = JSON.parse(rc.body); } catch { console.log("  HTTP", rc.status, rc.body.slice(0, 200)); }
  if (Array.isArray(rows)) {
    const byAgent = new Map();
    rows.forEach((r) => {
      const a = r.claimed_by;
      if (!byAgent.has(a)) byAgent.set(a, []);
      byAgent.get(a).push(r);
    });
    console.log(`  共 ${rows.length} 行，涉及 ${byAgent.size} 個唔同 agentId\n`);
    [...byAgent.entries()].forEach(([a, list]) => {
      console.log(`  ── ${a}`);
      console.log(`     首 claim: ${toMC(list[0].claimed_at)}  末 claim: ${toMC(list[list.length - 1].claimed_at)}  次數: ${list.length}`);
      const st = {};
      list.forEach((x) => (st[x.status] = (st[x.status] || 0) + 1));
      console.log(`     狀態分佈: ${JSON.stringify(st)}`);
      const errs = [...new Set(list.map((x) => (x.last_error || "").split("｜")[0].slice(0, 60)).filter(Boolean))];
      console.log(`     錯誤樣本: ${errs.length ? errs.join(" / ") : "(無)"}`);
      console.log(`     行 id 首尾: ${list[0].id.slice(0, 8)} … ${list[list.length - 1].id.slice(0, 8)}`);
      console.log("");
    });
  }

  // ── 目的 4：今日 pending 是否有任何 claim
  const rt = await req(
    "GET",
    `${base}/pos_print_jobs?select=id,created_at,status,attempts,claimed_by,claimed_at&created_at=gte.2026-09-16T00:00:00Z&status=eq.pending&order=created_at.asc&limit=100`,
    h
  );
  console.log("② 今日（澳門 09-16 起）仍 pending 的行:");
  try {
    const p = JSON.parse(rt.body);
    console.log(`  共 ${p.length} 張`);
    p.forEach((r) => console.log(`  ${toMC(r.created_at)} 建 | att=${r.attempts} claimed_by=${r.claimed_by || "NULL"}`));
  } catch { console.log("  HTTP", rt.status, rt.body.slice(0, 200)); }

  // ── 目的 3：GET /pair 兩欄
  console.log("\n③ GET /pair（Ledger 要求貼嘅那個）:");
  for (const aid of ["ag-__probe_nonexistent__"]) {
    const r = await req("GET", `${SITE}/api/pos/print-agent/pair?agentId=${aid}`, { "user-agent": "curl/8" });
    console.log(`  agentId=${aid} → HTTP ${r.status}  ${r.body.slice(0, 300)}`);
  }
  // 用真實 agentId 抽
  if (Array.isArray(rows) && rows.length) {
    const realIds = [...new Set(rows.map((r) => r.claimed_by))];
    for (const aid of realIds) {
      const r = await req("GET", `${SITE}/api/pos/print-agent/pair?agentId=${aid}`, { "user-agent": "curl/8" });
      console.log(`  ${aid} → HTTP ${r.status}`);
      console.log(`     ${r.body.slice(0, 400)}`);
    }
  }
})();
