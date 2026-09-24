/** 唯讀：查指定訂單現況（睇 30 秒重推係咪 no-op）。 */
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
  const ids = process.argv.slice(2);
  const mac = (s) => s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19) : "-";
  for (const id of ids) {
    const r = await get(`${H}/rest/v1/pos_orders?select=*&id=eq.${encodeURIComponent(id)}&limit=1&apikey=${K}`);
    try {
      const j = JSON.parse(r.body);
      if (!Array.isArray(j) || !j.length) { console.log(id, "→ 查唔到", r.status, String(r.body).slice(0, 150)); continue; }
      const o = j[0];
      console.log(`\n${id}`);
      console.log(`  store=${o.store_id} status=${o.status} reopen=${o.reopen_count ?? "-"} total=${o.total}`);
      console.log(`  created=${mac(o.created_at)}  updated=${mac(o.updated_at)}  client_updated=${mac(o.client_updated_at)}`);
      console.log(`  settled=${mac(o.settled_at)}  sent_kitchen=${mac(o.sent_to_kitchen_at)}  items=${Array.isArray(o.items) ? o.items.length : "-"}`);
      console.log(`  欄位: ${Object.keys(o).join(",")}`);
    } catch { console.log(id, "parse fail", String(r.body).slice(0, 200)); }
  }
})();
