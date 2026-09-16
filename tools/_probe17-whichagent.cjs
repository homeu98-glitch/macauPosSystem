// probe v17：相中 SUNMI V2s（表嫂美食）用邊個 agentId？
//   線索：
//     - 相機 IP = 192.168.31.140（店內網段）
//     - 狀態 = 配對失敗：POS 雲端未設定
//     - 09:25 影相，機活住
//     - 最新 job = 09:23:17（store 8291f843）
//   關鍵：邊個 agentId 係「pending」（= 配對失敗嘅特徵）？
//   已驗：ag-0590816d/ag-4d013eda/ag-302b8281 三隻都 paired（唔會顯示配對失敗）
//        ag-f38b08c/ag-a466746d 兩隻 pending（← 候選）
//   咁 ag-f38b08c 屬邊個 store？睇佢 claim 過邊批 job。
const https = require("https");
const SITE = "https://macau-pos-system.vercel.app";

function req(method, url, headers = {}, body = null) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", (e) => resolve({ status: 0, error: e.message }));
    if (body) r.write(body);
    r.end();
  });
}
const toMC = (s) => s ? new Date(new Date(s).getTime() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19) : "NULL";

(async () => {
  const home = await req("GET", SITE + "/prints", { "user-agent": "Mozilla/5.0" });
  const js = [...new Set((home.body || "").match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let anonKey = null;
  for (const p of js) {
    const r = await req("GET", SITE + p, { "user-agent": "Mozilla/5.0" });
    const m = (r.body || "").match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    if (m) { try { const pl = JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString("utf8")); if (pl.ref === "iyrywzormzisyppkokbi") { anonKey = m[0]; break; } } catch {} }
  }
  if (!anonKey) { console.log("搵唔到 anon key"); return; }
  const base = "https://iyrywzormzisyppkokbi.supabase.co/rest/v1";
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "content-type": "application/json" };

  console.log("═══ ① 每個 claimed_by 各自 claim 過咩 store／printer ═══");
  const r1 = await req("GET", `${base}/pos_print_jobs?select=claimed_by,store_id,printer_name,claimed_at,created_at&claimed_by=not.is.null&order=claimed_at.desc&limit=100`, h);
  try {
    const arr = JSON.parse(r1.body);
    const g = {};
    arr.forEach((x) => {
      const k = x.claimed_by;
      if (!g[k]) g[k] = { stores: new Set(), printers: new Set(), n: 0, first: x.claimed_at, last: x.claimed_at };
      g[k].n++;
      g[k].stores.add(x.store_id);
      g[k].printers.add(x.printer_name || "-");
      if (x.claimed_at < g[k].first) g[k].first = x.claimed_at;
      if (x.claimed_at > g[k].last) g[k].last = x.claimed_at;
    });
    Object.entries(g).forEach(([a, v]) =>
      console.log(`  ${a}\n    claim ${v.n} 次 | store=${[...v.stores].join(" / ")} | printer=${[...v.printers].join(" / ")}\n    首次 ${toMC(v.first)} → 最後 ${toMC(v.last)}`)
    );
  } catch (e) { console.log("  HTTP", r1.status, String(e.message).slice(0, 200)); }

  console.log("\n═══ ② 09:20-09:25 期間嘅 job（相機 09:25 影，睇邊張 live）═══");
  const r2 = await req("GET", `${base}/pos_print_jobs?select=store_id,created_at,status,attempts,printer_name,order_id&created_at=gte.2026-09-16T01:15:00Z&order=created_at.asc&limit=20`, h);
  try {
    JSON.parse(r2.body).forEach((x) =>
      console.log(`  ${toMC(x.created_at)} | ${x.status.padEnd(8)} att=${x.attempts} | ${(x.printer_name||"-").padEnd(28)} | store=${x.store_id.slice(0,8)} | ${x.order_id}`)
    );
  } catch (e) { console.log("  HTTP", r2.status, String(e.message).slice(0, 200)); }

  console.log("\n═══ ③ 兩個 pending agent 再打多次 /pair（確認穩定）═══");
  for (const a of ["ag-f38b08c1d2fec7111c4d5f03054d7d69", "ag-a466746d"]) {
    const r = await req("GET", `${SITE}/api/pos/print-agent/pair?agentId=${a}`, { "user-agent": "curl/8" });
    console.log(`  ${a} → HTTP ${r.status} ${r.body.slice(0, 200)}`);
  }
})();
