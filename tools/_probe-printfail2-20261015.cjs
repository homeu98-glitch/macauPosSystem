/** 唯讀探測 v2：pos_device_configs（三個 store 嘅打印機設定） */
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

const STORES = [
  "d564b932-0c91-45e9-86fd-0ec8e2711f13",
  "8291f843-9def-4956-9d0b-1cfef2598306",
  "cb9352eb-1f68-4a82-8b4f-9dafce3f0d97",
];

(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) { try { const r = await req(base + p); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {} }
  let K = "";
  for (const s of chunks) { try { const r = await req(base + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {} }
  log("key =", K ? K.slice(0, 20) + "…" : "(冇)");
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const g = async (p) => { const r = await req(`${H}/rest/v1/${p}`, "GET", h); return r; };

  for (const s of STORES) {
    log(`\n========== store ${s.slice(0, 8)} ==========`);
    const dc = await g(`pos_device_configs?select=*&store_id=eq.${s}&order=updated_at.desc&limit=10`);
    log("device-configs status", dc.status);
    let dcs = [];
    try { dcs = JSON.parse(dc.body); } catch { log(String(dc.body).slice(0, 400)); }
    log("筆數 =", dcs.length);
    for (const d of dcs) {
      log(`--- config id=${d.id} updated=${macau(d.updated_at)} keys=${Object.keys(d).join(",")}`);
      const cfg = d.config ?? d.device_config ?? d;
      const printers = cfg.printers ?? d.printers;
      if (Array.isArray(printers)) {
        for (const p of printers) {
          log(`  printer: id=${p.id} name=${p.name} role=${p.role} conn=${p.connectionType} ip=${p.ipAddress} port=${p.lanPort ?? p.port} zone=${p.zoneId} paper=${p.paperSize} enabled=${p.enabled} copies=${p.copies}`);
        }
      } else {
        log("  (printers 唔係陣列) " + JSON.stringify(printers)?.slice(0, 200));
      }
      const zones = cfg.printZones ?? d.printZones;
      if (Array.isArray(zones)) log("  zones: " + zones.map((z) => `${z.id}:${z.name}`).join(" | "));
    }
  }

  // 重失敗嗰兩張 job 嘅完整 rows（一次睇勻所有欄位）
  log("\n========== 失敗 job 完整欄位 ==========");
  for (const no of ["取餐01", "自取01"]) {
    const r = await g(`pos_print_jobs?select=*&order_no=eq.${encodeURIComponent(no)}&store_id=eq.${STORES[0]}&order=created_at.desc&limit=5`);
    let rows = [];
    try { rows = JSON.parse(r.body); } catch {}
    for (const j of rows) {
      log(`\n== ${no} @ ${macau(j.created_at)} id=${j.id}`);
      log("   " + JSON.stringify(j, null, 1).split("\n").slice(0, 60).join("\n   "));
    }
  }

  fs.writeFileSync("tools/_probe-printfail2-20261015.out.txt", out.join("\n"));
})();
