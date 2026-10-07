/**
 * 針對 ext=202610070936590064792，列出完整欄位以釐清為何有兩筆。
 */
const https = require("node:https");
const SITE = "https://macau-pos-system.vercel.app";
const POS_REF = "iyrywzormzisyppkokbi";

function get(url, headers) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) }, timeout: 25000 },
      (s) => { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => res({ status: s.statusCode, body: d })); }
    );
    r.on("error", (e) => res({ status: "ERR", body: String(e.message) }));
    r.on("timeout", () => { r.destroy(); res({ status: "TIMEOUT", body: "" }); });
  });
}
const PK = /sb_publishable_[A-Za-z0-9_-]{10,}/g;
const JW = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/orders", "/"]) {
    const r = await get(SITE + p);
    (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
  }
  const keys = new Set();
  for (const s of chunks) {
    const r = await get(SITE + s);
    (r.body.match(PK) || []).forEach((t) => keys.add(t));
    (r.body.match(JW) || []).forEach((t) => keys.add(t));
  }
  let posKey = null;
  for (const k of keys) {
    if (!k.startsWith("eyJ")) continue;
    let ref = "";
    try { ref = JSON.parse(Buffer.from(k.split(".")[1], "base64").toString()).ref || ""; } catch {}
    if (ref === POS_REF) posKey = k;
  }
  const H = { apikey: posKey, authorization: `Bearer ${posKey}` };
  const base = `https://${POS_REF}.supabase.co/rest/v1`;

  console.log("── ext=202610070936590064792 全部欄位 ──");
  const o = await get(
    `${base}/pos_orders?select=id,local_order_no,status,source,external_order_id,store_id,online_order_id,payment_method,total,subtotal,created_at,updated_at,raw_json&external_order_id=eq.202610070936590064792`,
    H
  );
  console.log("status", o.status);
  try {
    const rows = JSON.parse(o.body);
    console.log("筆數:", rows.length);
    for (const r of rows) {
      console.log("\n---");
      console.log("id            :", r.id);
      console.log("source        :", r.source);
      console.log("store_id      :", r.store_id);
      console.log("local_order_no:", r.local_order_no);
      console.log("status        :", r.status);
      console.log("external_order_id:", r.external_order_id);
      console.log("online_order_id  :", r.online_order_id);
      console.log("payment_method:", r.payment_method);
      console.log("total/subtotal:", r.total, "/", r.subtotal);
      console.log("created_at    :", r.created_at);
      console.log("updated_at    :", r.updated_at);
    }
  } catch (e) { console.log("parse err", e.message, o.body.slice(0, 500)); }
})();
