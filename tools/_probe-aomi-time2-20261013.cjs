/** 查 raw_json->occurredAt 同 raw_json->raw->orderDateTime，鎖定時間偏移來源。 */
const https = require("node:https");
const SITE = "https://macau-pos-system.vercel.app";
const POS_REF = "iyrywzormzisyppkokbi";
const ORDER_TAIL = "183958080";

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
const JW = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/orders", "/"]) {
    const r = await get(SITE + p);
    (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
  }
  let posKey = null;
  for (const s of chunks) {
    const r = await get(SITE + s);
    for (const k of (r.body.match(JW) || [])) {
      try { if (JSON.parse(Buffer.from(k.split(".")[1], "base64").toString()).ref === POS_REF) posKey = k; } catch {}
    }
  }
  if (!posKey) { console.log("搵唔到 key"); return; }
  const H = { apikey: posKey, authorization: `Bearer ${posKey}` };
  const base = `https://${POS_REF}.supabase.co/rest/v1`;

  const o = await get(
    `${base}/pos_orders?select=local_order_no,external_order_id,created_at,raw_json->occurredAt,raw_json->raw->orderDateTime,raw_json->raw->storeSeqNo,raw_json->raw->turnoverAmount&external_order_id=like.*${ORDER_TAIL}*&limit=3`,
    H
  );
  console.log(`status=${o.status}`);
  try {
    const rows = JSON.parse(o.body);
    for (const r of rows) {
      console.log(JSON.stringify(r, null, 1));
      if (r.created_at) {
        console.log(`created_at(澳門) = ${new Date(r.created_at).toLocaleString("zh-MO", { timeZone: "Asia/Macau" })}`);
      }
    }
  } catch { console.log(String(o.body).slice(0, 600)); }
})();
