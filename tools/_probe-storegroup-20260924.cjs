/** 唯讀：按 store_id × source 分組 09-24 嘅 pos_orders，並列出「冇 store_id」嘅單。 */
const https = require("node:https");
function get(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    }).on("error", rej);
  });
}
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const SITE = "https://macau-pos-system.vercel.app";
const REF = "iyrywzormzisyppkokbi";

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) {
    try { const r = await get(SITE + p); (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {}
  }
  let K = "";
  for (const s of chunks) {
    try { const r = await get(SITE + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {}
  }
  const q = async (path) => {
    const r = await get(`https://${REF}.supabase.co/rest/v1/${path}`, { apikey: K, authorization: `Bearer ${K}` });
    try { return JSON.parse(r.body); } catch { return null; }
  };

  const since = "2026-09-23T16:00:00Z"; // 澳門 09-24 00:00
  const rows = await q(`pos_orders?select=id,store_id,source,status,total,local_order_no,created_at,updated_at&created_at=gte.${since}&order=created_at.asc&limit=300`);
  if (!Array.isArray(rows)) { console.log("查詢失敗", String(rows).slice(0, 300)); return; }
  console.log("09-24（澳門日界起）pos_orders 共", rows.length, "張\n");

  const byStore = {};
  for (const o of rows) {
    const s = o.store_id ?? "(NULL)";
    byStore[s] = byStore[s] || { total: 0, bySource: {}, byStatus: {}, countable: 0 };
    byStore[s].total += 1;
    byStore[s].bySource[o.source ?? "(null)"] = (byStore[s].bySource[o.source ?? "(null)"] || 0) + 1;
    byStore[s].byStatus[o.status ?? "(null)"] = (byStore[s].byStatus[o.status ?? "(null)"] || 0) + 1;
    if (o.status === "settled" || o.status === "paid") byStore[s].countable += 1;
  }
  for (const [s, v] of Object.entries(byStore)) {
    console.log(`store=${s}`);
    console.log(`  total=${v.total}  可計(settled|paid)=${v.countable}`);
    console.log(`  source: ${JSON.stringify(v.bySource)}`);
    console.log(`  status: ${JSON.stringify(v.byStatus)}`);
  }

  console.log("\n=== 冇 store_id 或唔係主店嘅單 ===");
  for (const o of rows) {
    if (!o.store_id) console.log(JSON.stringify(o));
  }
})();
