// 唯讀探測：用 bundle 公開 anon key 讀 pos_print_jobs 最新行，睇 last_error 真身
const https = require("https");
const SITE = "https://macau-pos-system.vercel.app";

function get(url, headers = {}) {
  return new Promise((resolve) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...headers } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    }).on("error", (e) => resolve({ status: 0, error: e.message }));
  });
}

(async () => {
  // 1. 攞 anon key
  const home = await get(SITE + "/prints");
  const js = [...new Set((home.body || "").match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let anonKey = null;
  for (const p of js) {
    const r = await get(SITE + p);
    const m = (r.body || "").match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    if (m) {
      const payload = JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString("utf8"));
      if (payload.ref === "iyrywzormzisyppkokbi") { anonKey = m[0]; break; }
    }
  }
  if (!anonKey) { console.log("搵唔到 POS anon key"); return; }
  console.log("anon key ref OK（iyrywzormzisyppkokbi）\n");

  const base = "https://iyrywzormzisyppkokbi.supabase.co/rest/v1";
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };

  // 2. 讀最新 8 行 print jobs
  const q = `${base}/pos_print_jobs?select=id,status,attempts,last_error,claimed_by,claimed_at,created_at,updated_at,printer_name,kind&order=created_at.desc&limit=8`;
  const r1 = await get(q, h);
  console.log("=== pos_print_jobs 最新 8 行 ===");
  console.log("HTTP", r1.status);
  try {
    const rows = JSON.parse(r1.body);
    for (const row of rows) {
      console.log(`\n[${(row.created_at || "").replace("T", " ").slice(0, 19)}] ${row.kind || "?"} / ${row.printer_name || "?"}`);
      console.log(`  status=${row.status} attempts=${row.attempts} claimed_at=${row.claimed_at || "NULL"}`);
      console.log(`  last_error: ${row.last_error || "(NULL)"}`);
      console.log(`  updated_at: ${row.updated_at}`);
    }
  } catch { console.log(r1.body.slice(0, 500)); }

  // 3. 試 pos_print_agents（預期 42501，試下唔蝕底）
  const q2 = `${base}/pos_print_agents?select=agent_id,store_id,name,last_seen_at,revoked_at&order=last_seen_at.desc&limit=10`;
  const r2 = await get(q2, h);
  console.log("\n=== pos_print_agents ===");
  console.log("HTTP", r2.status, "|", r2.body.slice(0, 300));
})();
