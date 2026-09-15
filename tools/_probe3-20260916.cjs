// probe v3：睇 pos_print_jobs.printer（jsonb 快照）+ 完整 claimed_by + 最新一張有冇被認領
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
const toMC = (s) => (s ? new Date(new Date(s).getTime() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19) : "NULL");

(async () => {
  const home = await get(SITE + "/prints");
  const js = [...new Set((home.body || "").match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let anonKey = null;
  for (const p of js) {
    const r = await get(SITE + p);
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
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };

  const r = await get(
    `${base}/pos_print_jobs?select=id,created_at,updated_at,status,attempts,claimed_by,claimed_at,last_error,printer_name,printer_id,kind,printer&order=updated_at.desc&limit=6`,
    h
  );
  const rows = JSON.parse(r.body);
  if (!Array.isArray(rows)) { console.log("HTTP", r.status, r.body.slice(0, 300)); return; }
  console.log("=== 依 updated_at 排最近 6 行（Macau+8）===");
  for (const x of rows) {
    console.log(`\n${toMC(x.created_at)} 建 / ${toMC(x.updated_at)} 改 | ${x.status} att=${x.attempts} | ${x.printer_name} | kind=${x.kind}`);
    console.log(`  printer_id = ${x.printer_id}`);
    console.log(`  claimed_by = ${x.claimed_by || "NULL"}`);
    console.log(`  last_error = ${x.last_error || "(NULL)"}`);
    console.log(`  printer jsonb = ${x.printer ? JSON.stringify(x.printer) : "(NULL)"}`);
  }

  // 最新一張 pending 係咪已經被認領
  const rp = await get(`${base}/pos_print_jobs?select=id,created_at,status,attempts,claimed_by,claimed_at,last_error&status=eq.pending&order=created_at.desc&limit=5`, h);
  console.log("\n=== 現存 pending ===");
  JSON.parse(rp.body).forEach((x) =>
    console.log(`${toMC(x.created_at)} | ${x.status} att=${x.attempts} claimed_by=${x.claimed_by || "NULL"} claimed_at=${toMC(x.claimed_at)} err=${x.last_error || "-"}`)
  );
})();
