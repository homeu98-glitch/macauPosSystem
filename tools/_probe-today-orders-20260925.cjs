/** 唯讀：今日 pos_orders 全列（唔指定欄位，避免 42703）+ 兩張線上單有冇投影 */
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
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const out = []; const log = (...a) => { const s = a.map(String).join(" "); out.push(s); console.log(s); };
const macau = (iso) => iso ? new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) : "-";
(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) { try { const r = await req(base + p); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {} }
  let K = "";
  for (const s of chunks) { try { const r = await req(base + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {} }
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const g = (p) => req(`${H}/rest/v1/${p}`, "GET", h);

  log("=== 今日 pos_orders（澳門 09-25，按 created_at asc）===");
  const po = await g(`pos_orders?select=*&store_id=eq.${STORE}&created_at=gte.2026-09-24T16:00:00Z&order=created_at.asc&limit=50`);
  log("status", po.status);
  try {
    const rows = JSON.parse(po.body);
    log("筆數 =", rows.length);
    for (const r of rows) {
      log(`${macau(r.created_at)} → ${macau(r.updated_at)} | id=${r.id} no=${r.local_order_no ?? r.order_no} | ${r.status} | total=${r.total} | tbl=${r.table_name} | online=${r.online_order_id ?? "-"} | settled=${macau(r.settled_at)} | mgId=${r.merchant_order_id ?? "-"}`);
    }
    if (rows[0]) log("\n欄位: " + Object.keys(rows[0]).join(","));
  } catch { log(String(po.body).slice(0, 600)); }

  log("\n=== pos_orders 今日 02:00Z 之後所有 online_order_id 非空 ===");
  const po2 = await g(`pos_orders?select=id,local_order_no,status,created_at,updated_at,online_order_id,pickup_code&store_id=eq.${STORE}&online_order_id=not.is.null&updated_at=gte.2026-09-24T16:00:00Z&order=updated_at.desc&limit=50`);
  try {
    const rows = JSON.parse(po2.body);
    log("筆數 =", rows.length);
    for (const r of rows) log(`${macau(r.created_at)} → ${macau(r.updated_at)} | ${r.id} | ${r.status} | online=${r.online_order_id} | pickup=${r.pickup_code ?? "-"}`);
  } catch { log(String(po2.body).slice(0, 300)); }

  fs.writeFileSync("tools/_probe-today-orders-20260925.out.txt", out.join("\n"));
})();
