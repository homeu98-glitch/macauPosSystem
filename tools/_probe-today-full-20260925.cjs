/** 唯讀：dump 今日兩條 print job 嘅所有欄位（template 有冇、items 喺邊） */
const https = require("node:https");
function req(url, headers) {
  return new Promise((res, rej) => {
    const r = https.request(url, { method: "GET", headers }, (s) => {
      let d = ""; s.on("data", (c) => (d += c));
      s.on("end", () => res({ status: s.statusCode, body: d }));
    });
    r.on("error", rej); r.setTimeout(30000, () => r.destroy(new Error("timeout")));
    r.end();
  });
}
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const H = "https://iyrywzormzisyppkokbi.supabase.co";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const macau = (iso) => iso ? new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) : "-";

(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) { const r = await req(base + p, { "user-agent": "Mozilla/5.0" }); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); }
  let K = "";
  for (const s of chunks) { const r = await req(base + s, { "user-agent": "Mozilla/5.0" }); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } }
  console.log("key =", K ? K.slice(0, 26) + "…" : "(冇)");
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };

  const r = await req(`${H}/rest/v1/pos_print_jobs?select=*&store_id=eq.${STORE}&created_at=gte.2026-09-24T16:00:00Z&order=created_at.asc`, h);
  console.log("status", r.status);
  let rows = [];
  try { rows = JSON.parse(r.body); } catch { console.log(String(r.body).slice(0, 500)); return; }
  console.log("今日筆數 =", rows.length);
  if (rows[0]) console.log("欄位 =", Object.keys(rows[0]).join(", "));
  for (const j of rows) {
    console.log("\n──────────────────────────────────────────");
    console.log(`${macau(j.created_at)} | id=${j.id} | oid=${j.order_id} | no=${j.order_no} | ${j.ticket_type}/${j.printer_group}/${j.printer_name} | st=${j.status}`);
    console.log(`  printer_id=${j.printer_id} once_key=${j.once_key}`);
    console.log(`  template: ${j.template === null || j.template === undefined ? "**NULL/冇**" : "有（" + JSON.stringify(j.template).length + " chars）"}`);
    console.log(`  items: ${j.items === null || j.items === undefined ? "冇" : JSON.stringify(j.items)}`);
    console.log(`  content keys: ${j.content ? Object.keys(j.content).join(",") : "冇"}`);
    console.log(`  content.storeName=${j.content?.storeName} content.store_name=${j.content?.store_name} content.time=${j.content?.time} content.order_note=${j.content?.order_note}`);
    console.log(`  content = ${JSON.stringify(j.content)}`);
  }
})();
