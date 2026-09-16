// probe v16：用「表嫂美食」定位 store + 驗證該店配對鏈
//   1) 列 pos_store_status（唯一 anon 讀得到嘅 store 表）→ 揾店名
//   2) 逐個 store 打 pair-status
//   3) 對每個 agentId 打 GET /pair（睇邊個 pending）
//   4) 查 pos_print_jobs group by store_id（最新活動）
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
const ago = (s) => s ? Math.round((Date.now() - new Date(s).getTime()) / 60000) + " 分前" : "NULL";

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

  console.log("═══ ① pos_store_status（睇邊個 store 叫「表嫂美食」）═══");
  const rs = await req("GET", `${base}/pos_store_status?select=*&limit=20`, h);
  try {
    const arr = JSON.parse(rs.body);
    if (!Array.isArray(arr)) throw new Error(rs.body.slice(0, 300));
    if (!arr.length) console.log("  （空）");
    arr.forEach((s) =>
      console.log(`  ${s.store_id ?? s.id} | name=${s.store_name ?? s.name ?? "?"} | is_open=${s.is_open} | updated=${toMC(s.updated_at)}`)
    );
    console.log("  欄位:", JSON.stringify(Object.keys(arr[0] || {})));
  } catch (e) { console.log("  HTTP", rs.status, String(e.message).slice(0, 300)); }

  console.log("\n═══ ② 逐個 store 打 pair-status ═══");
  const STORES = ["d564b932-0c91-45e9-86fd-0ec8e2711f13", "f6ec837a-03d9-48f0-ae05-f1fbc3483221", "8291f843-9def-4956-9d0b-1cfef2598306"];
  for (const s of STORES) {
    const r = await req("GET", `${SITE}/api/pos/print-agent/pair-status?storeId=${s}`, { "user-agent": "curl/8" });
    let j = null; try { j = JSON.parse(r.body); } catch {}
    console.log(`  ${s}`);
    console.log(`    paired=${j?.paired} androidReady=${j?.androidReady} lastSeen=${toMC(j?.lastSeenAt)} (${ago(j?.lastSeenAt)}) agent=${j?.agentId ?? "-"}`);
  }

  console.log("\n═══ ③ 對每個 agentId 打 GET /pair（邊個 pending？）═══");
  const AGENTS = [
    "ag-0590816d9f60e8d2f55a16cf721042dd",
    "ag-4d013eda51299e8268545fcd1c6d1892",
    "ag-302b8281b76742d95467537f38b84bbf",
    "ag-f38b08c1d2fec7111c4d5f03054d7d69",
    "ag-a466746d",
  ];
  for (const a of AGENTS) {
    const r = await req("GET", `${SITE}/api/pos/print-agent/pair?agentId=${a}`, { "user-agent": "curl/8" });
    let j = null; try { j = JSON.parse(r.body); } catch {}
    console.log(`  ${a.slice(0, 24).padEnd(26)} status=${(j?.status ?? "?").padEnd(8)} url=${j?.supabaseUrl ? "有" : "空"} key=${j?.anonKey ? "有" : "空"} store=${j?.storeId ?? "-"}`);
  }

  console.log("\n═══ ④ pos_print_jobs group by store_id（睇最近活動）═══");
  const rj = await req("GET", `${base}/pos_print_jobs?select=store_id,created_at,printer_name&order=created_at.desc&limit=60`, h);
  try {
    const arr = JSON.parse(rj.body);
    const g = {};
    arr.forEach((x) => {
      const k = x.store_id;
      if (!g[k]) g[k] = { n: 0, latest: x.created_at, printers: new Set() };
      g[k].n++;
      if (x.created_at > g[k].latest) g[k].latest = x.created_at;
      g[k].printers.add(x.printer_name || "-");
    });
    Object.entries(g).sort((a, b) => (b[1].latest > a[1].latest ? 1 : -1)).forEach(([s, v]) =>
      console.log(`  ${s} | ${v.n} 張 | 最新 ${toMC(v.latest)} (${ago(v.latest)}) | ${[...v.printers].join(", ")}`)
    );
  } catch (e) { console.log("  HTTP", rj.status, String(e.message).slice(0, 200)); }
})();
