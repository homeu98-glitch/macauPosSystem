/** 唯讀：用 001 嘅 order_id（ledger-f74b4a98-…）反查雲端 pos_orders 有無呢張單。 */
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
const LID = "f74b4a98-c28c-4afb-9727-b8c86d84338c";

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

  const trials = [
    ["依 id（ledger- 前綴）", `pos_orders?select=id,store_id,status,total,local_order_no,online_order_id,created_at,updated_at,sent_to_kitchen_at&id=eq.ledger-${LID}`],
    ["依 online_order_id", `pos_orders?select=id,store_id,status,total,local_order_no,online_order_id,created_at,updated_at,sent_to_kitchen_at&online_order_id=eq.${LID}`],
    ["依 local_order_no=001", `pos_orders?select=id,store_id,status,total,local_order_no,online_order_id,created_at,updated_at&local_order_no=eq.001`],
  ];
  for (const [label, path] of trials) {
    const r = await q(path);
    console.log(`\n[${label}] status=${r.status}`);
    let j = null;
    try { j = JSON.parse(r.raw); } catch {}
    if (Array.isArray(j)) console.log(j.length ? JSON.stringify(j, null, 2) : "（冇呢張單）");
    else console.log(String(r.raw).slice(0, 400));
  }

  // 全部含 001 字樣嘅單（防 local_order_no 有空白）
  const r2 = await q(`pos_orders?select=id,store_id,status,total,local_order_no,online_order_id,created_at&local_order_no=like.*001*&order=created_at.desc&limit=20`);
  console.log(`\n[local_order_no like *001*] status=${r2.status}`);
  try { console.log(JSON.stringify(JSON.parse(r2.raw), null, 1).slice(0, 1500)); } catch { console.log(String(r2.raw).slice(0, 400)); }
})();
