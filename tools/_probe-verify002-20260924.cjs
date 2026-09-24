/**
 * 唯讀：核對 002 / 003 兩張單嘅**現況**（不限 store 同指定 store 都查），
 * 同用戶提供嘅目標值對比：
 *   002: total 59.00, created 2026-09-23 03:25:15.949068+00, updated 2026-09-23 04:57:19+00
 *   003: total 129.00, created 2026-09-23 09:54:47.793278+00, updated 2026-09-23 10:48:42+00
 */
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
const IDS = [
  ["002", "ledger-0f2c52b2-8edd-44cd-a0fd-a2750a983b1e"],
  ["003", "ledger-79f94f1f-b2bb-48bf-8389-b71686c30f8d"],
];

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) {
    try { const r = await get(SITE + p); (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {}
  }
  let K = "";
  for (const s of chunks) {
    try { const r = await get(SITE + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {}
  }
  const H = { apikey: K, authorization: `Bearer ${K}` };
  const q = async (path) => {
    const r = await get(`https://${REF}.supabase.co/rest/v1/${path}`, H);
    return { status: r.status, raw: r.body };
  };

  for (const [no, id] of IDS) {
    console.log(`\n===== 取餐碼 ${no}  (${id}) =====`);
    for (const [label, path] of [
      ["全部 store", `pos_orders?select=*&id=eq.${id}`],
      ["指定 store", `pos_orders?select=*&id=eq.${id}&store_id=eq.8291f843-9def-4956-9d0b-1cfef2598306`],
    ]) {
      const r = await q(path);
      let rows = null;
      try { rows = JSON.parse(r.raw); } catch {}
      console.log(`  [${label}] status=${r.status} 行數=${Array.isArray(rows) ? rows.length : "?"}`);
      if (!Array.isArray(rows)) { console.log("   ", String(r.raw).slice(0, 200)); continue; }
      for (const o of rows) {
        console.log(`    store_id   = ${o.store_id}`);
        console.log(`    total      = ${o.total}   subtotal=${o.subtotal}  prepaid=${o.prepaid_amount}`);
        console.log(`    created_at = ${o.created_at}`);
        console.log(`    updated_at = ${o.updated_at}`);
        console.log(`    client_upd = ${o.client_updated_at}`);
        console.log(`    status     = ${o.status}   table=${o.table_name}  reopen=${o.reopen_count}`);
        console.log(`    items      = ${JSON.stringify((o.items || []).map((i) => `${i.name}x${i.quantity}@${i.price}`))}`);
        console.log(`    ---`);
      }
    }
  }

  // 順便：今日 store 全部單嘅 updated_at > 09-24 13:20Z 嘅（睇補建痕跡）
  console.log("\n===== 補建痕跡掃描（updated_at 喺 09-24T13:20Z–13:30Z，即 21:20–21:30 澳門）=====");
  const r = await q(
    `pos_orders?select=id,local_order_no,status,total,created_at,updated_at&store_id=eq.8291f843-9def-4956-9d0b-1cfef2598306&updated_at=gte.2026-09-24T13:20:00Z&updated_at=lte.2026-09-24T13:30:00Z&order=updated_at.asc`
  );
  let rows = null;
  try { rows = JSON.parse(r.raw); } catch {}
  if (Array.isArray(rows)) {
    console.log(`共 ${rows.length} 行`);
    for (const o of rows) console.log(`  created=${o.created_at}  updated=${o.updated_at}  ${String(o.local_order_no).padEnd(8)} ${o.status} ${o.total}  id=${o.id}`);
  } else console.log(String(r.raw).slice(0, 200));
})();
