/** 唯讀：查 pos_print_jobs 現況（anon 24h 窗口），睇 print-11e37b9e 係咪卡住。 */
const https = require("node:https");
function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0" } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    }).on("error", rej);
  });
}
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const H = "https://iyrywzormzisyppkokbi.supabase.co";
(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/", "/pos"]) {
    try { const r = await get(base + p); (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {}
  }
  let K = "";
  for (const s of chunks) { try { const r = await get(base + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {} }
  if (!K) { console.log("no key"); return; }
  const r = await get(`${H}/rest/v1/pos_print_jobs?select=*&order=created_at.desc&limit=40&apikey=${K}`);
  console.log("status", r.status);
  try {
    const j = JSON.parse(r.body);
    if (!Array.isArray(j)) { console.log(String(r.body).slice(0, 300)); return; }
    console.log("筆數", j.length);
    const mac = (s) => s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19) : "-";
    for (const x of j) {
      console.log(
        `  ${String(x.id).padEnd(22)} st=${String(x.status).padEnd(10)} kind=${String(x.kind ?? "-").padEnd(8)} ` +
        `try=${x.attempts ?? "-"} once=${String(x.once_key ?? "-").padEnd(28)} created=${mac(x.created_at)} updated=${mac(x.updated_at)} claimed=${mac(x.claimed_at)} by=${String(x.claimed_by ?? "-")}`,
      );
    }
    const byStatus = {};
    for (const x of j) byStatus[x.status] = (byStatus[x.status] || 0) + 1;
    console.log("狀態分佈:", JSON.stringify(byStatus));
  } catch (e) { console.log(String(r.body).slice(0, 300)); }
})();
