/** 唯讀探測 v3：只要失敗 job 嘅完整欄位 + 試其他表 */
const https = require("node:https");
const fs = require("node:fs");
function req(url, method, headers, body) {
  return new Promise((res, rej) => {
    const r = https.request(url, { method: method || "GET", headers: headers || { "user-agent": "Mozilla/5.0" } }, (s) => {
      let d = ""; s.on("data", (c) => (d += c));
      s.on("end", () => res({ status: s.statusCode, body: d }));
    });
    r.on("error", rej); r.setTimeout(30000, () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const H = "https://iyrywzormzisyppkokbi.supabase.co";
const out = []; const log = (...a) => { const s = a.map(String).join(" "); out.push(s); console.log(s); };
const macau = (iso) => iso ? new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) : "-";
const STORE = "d564b932-0c91-45e9-86fd-0ec8e2711f13";

(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) { try { const r = await req(base + p); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {} }
  let K = "";
  for (const s of chunks) { try { const r = await req(base + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {} }
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const g = async (p) => { const r = await req(`${H}/rest/v1/${p}`, "GET", h); return r; };

  log("===== 失敗 job 完整欄位 =====");
  for (const no of ["取餐01", "自取01"]) {
    const r = await g(`pos_print_jobs?select=*&order_no=eq.${encodeURIComponent(no)}&store_id=eq.${STORE}&order=created_at.desc&limit=6`);
    let rows = [];
    try { rows = JSON.parse(r.body); } catch { log("HTTP " + r.status + " " + String(r.body).slice(0, 300)); }
    for (const j of rows) {
      log(`\n== ${no} @ ${macau(j.created_at)} id=${j.id} status=${j.status}`);
      const keys = Object.keys(j).sort();
      for (const k of keys) {
        let v = j[k];
        if (v && typeof v === "object") v = JSON.stringify(v);
        if (v && String(v).length > 400) v = String(v).slice(0, 400) + "…";
        log(`   ${k} = ${v}`);
      }
    }
  }

  log("\n===== 試其他表（睇 RLS）=====");
  for (const t of ["pos_device_configs", "pos_print_agents", "pos_kiosk_settings", "pos_store_status", "pos_print_templates"]) {
    const r = await g(`${t}?select=*&limit=1`);
    log(`${t}: HTTP ${r.status} ${String(r.body).slice(0, 150)}`);
  }

  fs.writeFileSync("tools/_probe-printfail3-20261015.out.txt", out.join("\n"));
})();
