/**
 * 唯讀：補建事故損害評估 ——
 * 002(0f2c52b2) / 003(79f94f1f) 原本係 **09-23** 嘅單，被補建覆蓋成 09-24。
 * 由 `pos_print_jobs`（有 items 快照）還原原本內容，並列出 09-23 全部單。
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
const AFFECTED = [
  { id: "ledger-0f2c52b2-8edd-44cd-a0fd-a2750a983b1e", ledgerId: "0f2c52b2-8edd-44cd-a0fd-a2750a983b1e", no: "002" },
  { id: "ledger-79f94f1f-b2bb-48bf-8389-b71686c30f8d", ledgerId: "79f94f1f-b2bb-48bf-8389-b71686c30f8d", no: "003" },
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
    try { return JSON.parse(r.body); } catch { return null; }
  };
  const mac = (s) => (s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19) : "-");

  console.log("=== 受影響兩張單嘅現況（雲端）===");
  for (const a of AFFECTED) {
    const rows = await q(`pos_orders?select=*&id=eq.${a.id}&limit=1`);
    const o = rows && rows[0];
    if (!o) { console.log(`${a.id} 查唔到`); continue; }
    console.log(`\n${a.no}  (${a.ledgerId})`);
    console.log(`  status=${o.status} total=${o.total} subtotal=${o.subtotal} prepaid=${o.prepaid_amount}`);
    console.log(`  created_at=${mac(o.created_at)}  updated_at=${mac(o.updated_at)}  client_updated=${mac(o.client_updated_at)}`);
    console.log(`  table=${o.table_name} source=${o.source} reopen=${o.reopen_count}`);
    console.log(`  items: ${JSON.stringify((o.items || []).map((i) => `${i.name}×${i.quantity}@${i.price}`))}`);
    console.log(`  voided: ${JSON.stringify(o.voided_items)}  refund: ${JSON.stringify(o.refund_records)}`);
  }

  console.log("\n\n=== pos_print_jobs 內呢兩張單嘅快照（可還原 items）===");
  for (const a of AFFECTED) {
    const jobs = await q(
      `pos_print_jobs?select=order_id,order_no,ticket_type,printer_group,items,total,payment_method,content,status,created_at&order_id=eq.${a.id}&order=created_at.asc&limit=50`
    );
    console.log(`\n${a.no}  (${a.id}) ⇒ ${Array.isArray(jobs) ? jobs.length : "?"} 張 job`);
    if (!Array.isArray(jobs)) continue;
    for (const j of jobs) {
      console.log(`  ${mac(j.created_at)} ${j.printer_group}/${j.ticket_type} status=${j.status} total=${j.total ?? "—"} pay=${j.payment_method ?? "—"}`);
      console.log(`     items: ${JSON.stringify((j.items || []).map((i) => `${i.name}×${i.quantity}`))}`);
      if (j.content) {
        const c = j.content;
        console.log(`     content: total=${c.total ?? c.grand_total ?? "—"} subtotal=${c.subtotal ?? "—"} no=${c.order_no ?? "—"} table=${c.table_name ?? "—"}`);
      }
    }
  }

  console.log("\n\n=== 09-23（澳門）全部 pos_orders（睇下有冇其他都受影響）===");
  const d23 = await q(
    `pos_orders?select=id,local_order_no,status,total,online_order_id,created_at,updated_at,table_name&store_id=eq.${STORE}&created_at=gte.2026-09-22T16:00:00Z&created_at=lte.2026-09-23T15:59:59Z&order=created_at.asc&limit=200`
  );
  if (Array.isArray(d23)) {
    console.log(`共 ${d23.length} 張（按 created_at）`);
    for (const o of d23) console.log(`  ${mac(o.created_at)} ${String(o.local_order_no).padEnd(10)} ${String(o.status).padEnd(9)} ${String(o.total).padStart(5)}  upd=${mac(o.updated_at)}  ${o.online_order_id ? "線上" : "—"} id=${o.id}`);
  }
})();
