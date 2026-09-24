/**
 * 唯讀：比對今日 pos_print_jobs 嘅 order_id vs pos_orders 嘅 id ⇒
 * 搵出「有出紙但雲端冇訂單」嘅個案（＝本地建單但從未上雲）。
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
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const SINCE = "2026-09-23T16:00:00Z";

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
    try { return JSON.parse(r.body); } catch { return null; }
  };

  const jobs = await q(`pos_print_jobs?select=order_id,order_no,printer_group,ticket_type,created_at&store_id=eq.${STORE}&created_at=gte.${SINCE}&limit=500`);
  const orders = await q(`pos_orders?select=id,local_order_no,status,total,online_order_id,created_at&store_id=eq.${STORE}&created_at=gte.${SINCE}&limit=500`);
  if (!Array.isArray(jobs) || !Array.isArray(orders)) { console.log("查詢失敗"); return; }

  const oid = new Set(orders.map((o) => o.id));
  console.log(`雲端 pos_orders：${orders.length} 張`);
  console.log(`今日 print_jobs：${jobs.length} 張\n`);

  // 出紙嘅單（按 order_id 去重）
  const jobOrders = new Map();
  for (const j of jobs) {
    if (!j.order_id) continue;
    if (!jobOrders.has(j.order_id)) jobOrders.set(j.order_id, { no: j.order_no, first: j.created_at, kinds: new Set() });
    jobOrders.get(j.order_id).kinds.add(`${j.printer_group}/${j.ticket_type}`);
  }
  console.log(`出過紙嘅單（去重）：${jobOrders.size} 張\n`);

  const missing = [];
  for (const [id, v] of jobOrders) {
    if (!oid.has(id)) missing.push({ id, ...v, kinds: [...v.kinds].join(",") });
  }
  console.log(`🔴 有出紙但雲端 pos_orders 冇嘅單：${missing.length} 張`);
  const mac = (s) => (s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19) : "-");
  for (const m of missing.sort((a, b) => String(a.first).localeCompare(String(b.first)))) {
    console.log(`  ${mac(m.first)}  no=${String(m.no).padEnd(12)} id=${m.id}  票=${m.kinds}`);
  }

  console.log(`\n雲端有單但今日冇出過紙：`);
  for (const o of orders) {
    if (!jobOrders.has(o.id)) console.log(`  no=${String(o.local_order_no).padEnd(12)} id=${o.id} status=${o.status} total=${o.total} online=${o.online_order_id ? "有" : "—"}`);
  }
})();
