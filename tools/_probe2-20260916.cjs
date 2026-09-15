// 唯讀探測 v2：全面睇 pos_print_jobs 近況（camelCase ⇄ snake_case 兼容）
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
        const payload = JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString("utf8"));
        if (payload.ref === "iyrywzormzisyppkokbi") { anonKey = m[0]; break; }
      } catch {}
    }
  }
  if (!anonKey) { console.log("搵唔到 POS anon key"); return; }

  const base = "https://iyrywzormzisyppkokbi.supabase.co/rest/v1";
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };

  // A. 最近 20 行全欄
  const r1 = await get(`${base}/pos_print_jobs?select=*&order=created_at.desc&limit=20`, h);
  let rows = [];
  try { rows = JSON.parse(r1.body); } catch { console.log("A HTTP", r1.status, r1.body.slice(0, 400)); }

  if (Array.isArray(rows) && rows.length) {
    console.log("=== 欄位 ===");
    console.log(Object.keys(rows[0]).join(", "));
    console.log("\n=== 最近 20 行（時間已轉 Macau+8）===");
    for (const r of rows) {
      console.log(
        `${toMC(r.created_at)} | ${String(r.status).padEnd(8)} | att=${String(r.attempts).padEnd(2)} | kind=${r.kind ?? r.job_kind ?? "?"} | printer=${r.printer_name ?? "?"} | ${r.printer_target ?? r.target ?? ""}`
      );
      const cb = r.claimed_by ? String(r.claimed_by).slice(0, 8) : "NULL";
      console.log(`     claimed_by=${cb} claimed_at=${toMC(r.claimed_at)} finished_at=${toMC(r.finished_at)} updated=${toMC(r.updated_at)}`);
      console.log(`     last_error=${r.last_error || "(NULL)"}`);
    }
  }

  // B. 群組統計
  for (const st of ["pending", "printing", "failed", "done"]) {
    const r = await get(`${base}/pos_print_jobs?select=id&status=eq.${st}`, h, );
    let n = -1;
    try { n = JSON.parse(r.body).length; } catch {}
    const rr = await get(`${base}/pos_print_jobs?select=id&status=eq.${st}`, h);
    let cnt = "?";
    try { cnt = JSON.parse(rr.body).length; } catch {}
    console.log(`\n[${st}] 可見列數=${cnt}  (limit 上限 1000，只作參考)`);
  }

  // C. 最新 1 小時有冇被認領（claimed_at）
  const since = new Date(Date.now() - 60 * 60e3).toISOString();
  const r3 = await get(`${base}/pos_print_jobs?select=id,status,attempts,claimed_at,last_error,created_at&claimed_at=not.is.null&created_at=gte.${since}&order=created_at.desc&limit=20`, h);
  console.log("\n=== 近 1 小時內「有被認領」的任務 ===");
  console.log("HTTP", r3.status);
  try {
    const c = JSON.parse(r3.body);
    if (!Array.isArray(c) || !c.length) console.log("（冇）");
    else c.forEach((r) => console.log(`${toMC(r.created_at)} claimed_at=${toMC(r.claimed_at)} ${r.status} att=${r.attempts} err=${r.last_error || "-"}`));
  } catch { console.log(r3.body.slice(0, 400)); }
})();
