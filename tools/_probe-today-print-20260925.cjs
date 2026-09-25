/** 唯讀探測：今日 pos_print_jobs + pos_orders（anon，由已部署 bundle 抽 key） */
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
  log("bundle chunks =", chunks.size, " key =", K ? K.slice(0, 30) + "…" : "(冇)");
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const g = async (p) => { const r = await req(`${H}/rest/v1/${p}`, "GET", h); return r; };

  log("\n===== pos_print_jobs（最近 24h，按 created_at desc）=====");
  const pj = await g(`pos_print_jobs?select=id,order_id,order_no,table_name,ticket_type,printer_group,printer_name,status,once_key,created_at,claimed_at,finished_at,attempts,last_error,content&store_id=eq.${STORE}&order=created_at.desc&limit=200`);
  log("status", pj.status);
  let rows = [];
  try { rows = JSON.parse(pj.body); } catch { log(String(pj.body).slice(0, 400)); }
  log("筆數 =", rows.length);
  for (const r of rows) {
    const c = r.content || {};
    const items = Array.isArray(c.items) ? c.items.map((i) => `${i.name ?? i.dishName ?? "?"}x${i.qty ?? i.quantity ?? "?"}`).join(",") : "";
    log(`${macau(r.created_at)} | ${r.id} | oid=${r.order_id} no=${r.order_no} | ${r.ticket_type}/${r.printer_group}/${r.printer_name} | st=${r.status} att=${r.attempts} | once=${r.once_key} | claim=${macau(r.claimed_at)} done=${macau(r.finished_at)} | err=${r.last_error || "-"} | items=${items.slice(0, 80)} | storeName=${c.storeName ?? c.store_name ?? "-"} | orderTime=${c.orderTime ?? c.orderedAt ?? "-"}`);
  }

  log("\n===== pos_orders 今日（按 updated_at desc）=====");
  const start = "2026-09-24T16:00:00Z";   // 澳門 09-25 00:00
  const po = await g(`pos_orders?select=id,local_order_no,status,created_at,updated_at ,settled_at,total,online_order_id,table_name&store_id=eq.${STORE}&updated_at=gte.${start}&order=created_at.asc&limit=200`);
  log("status", po.status);
  let orows = [];
  try { orows = JSON.parse(po.body); } catch { log(String(po.body).slice(0, 400)); }
  log("筆數 =", orows.length);
  for (const r of orows) log(`${macau(r.created_at)} → ${macau(r.updated_at)} | ${r.id} | no=${r.local_order_no} | ${r.status} | ${r.total} | tbl=${r.table_name} | online=${r.online_order_id || "-"} | settled=${macau(r.settled_at)}`);

  fs.writeFileSync("tools/_probe-today-print-20260925.out.txt", out.join("\n"));
})();
