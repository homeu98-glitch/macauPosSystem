// probe v9：用戶 09:23 截圖後即時檢查
//   重點 1：心跳 1138 分鐘前 = 約 19 小時 ⇒ 反推最後心跳時間
//   重點 2：訂單 005（09:20 建）是否 pending / attempts=0
//   重點 3：最新幾張 job 有冇任何 claim
//   重點 4：對每個 agentId 打 /pair 現況
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
const ago = (s) => (s ? Math.round((Date.now() - new Date(s).getTime()) / 60000) + " 分鐘前" : "NULL");

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
  const base = "https://iyrywzormzisyppkokbi.supabase.co/rest/v1";
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "content-type": "application/json" };

  console.log("═══ ① 最近 6 張 job（睇 09:20 訂單 005）═══");
  const r1 = await req("GET", `${base}/pos_print_jobs?select=id,created_at,status,attempts,claimed_by,claimed_at,printer_name,last_error&order=created_at.desc&limit=6`, h);
  try {
    JSON.parse(r1.body).forEach((r) =>
      console.log(
        `  ${toMC(r.created_at)} 建 | ${r.status} att=${r.attempts} | claimed_by=${r.claimed_by || "NULL"} claimed_at=${toMC(r.claimed_at)} | ${r.printer_name || "-"}` +
        (r.last_error ? `\n      err: ${r.last_error.slice(0, 80)}` : "")
      )
    );
  } catch { console.log("  HTTP", r1.status, r1.body.slice(0, 200)); }

  console.log("\n═══ ② 今日全部 claim 記錄（睇有冇新 claim）═══");
  const r2 = await req("GET", `${base}/pos_print_jobs?select=claimed_by,claimed_at,status,created_at&claimed_by=not.is.null&order=claimed_at.desc&limit=10`, h);
  try {
    const a = JSON.parse(r2.body);
    if (!a.length) console.log("  ⚠️ 完全冇任何 claim 記錄");
    a.forEach((r) => console.log(`  ${r.claimed_by.slice(0, 20)}… | claim@${toMC(r.claimed_at)} (${ago(r.claimed_at)}) | ${r.status} | 單建於 ${toMC(r.created_at)}`));
  } catch { console.log("  HTTP", r2.status, r2.body.slice(0, 200)); }

  console.log("\n═══ ③ 各 agentId 嘅 GET /pair 現況 ═══");
  for (const aid of ["ag-0590816d9f60e8d2f55a16cf721042dd", "ag-f38b08c1d2fec7111c4d5f03054d7d69"]) {
    const r = await req("GET", `${SITE}/api/pos/print-agent/pair?agentId=${aid}`, { "user-agent": "curl/8" });
    let j = null; try { j = JSON.parse(r.body); } catch {}
    console.log(`  ${aid}`);
    console.log(`    status=${j?.status} supabaseUrl=${j?.supabaseUrl ? "有值" : "空"} anonKey=${j?.anonKey ? "有值" : "空"}`);
  }

  console.log("\n═══ ④ pair-status（睇 lastSeenAt，= UI 嗰句「心跳 N 分鐘前」）═══");
  const r4 = await req("GET", `${SITE}/api/pos/print-agent/pair-status?storeId=d564b932-0c91-45e9-86fd-0ec8e2711f13`, { "user-agent": "curl/8" });
  console.log(`  HTTP ${r4.status}`);
  try {
    const j = JSON.parse(r4.body);
    console.log(`  paired=${j.paired} androidReady=${j.androidReady} lastSeenAt=${j.lastSeenAt} (${ago(j.lastSeenAt)})`);
    console.log(`  agentId=${j.agentId || "-"} storeName=${j.storeName || "-"}`);
  } catch { console.log("  " + r4.body.slice(0, 300)); }
})();
