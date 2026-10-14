/**
 * 跟進：查 pos_orders 該張澳覈單嘅 occurred_at / raw_json / placed 相關欄位，
 * 判斷 created_at 時間偏移來源（2026-10-13）。
 */
const https = require("node:https");
const SITE = "https://macau-pos-system.vercel.app";
const POS_REF = "iyrywzormzisyppkokbi";
const ORDER_TAIL = "183958080";

function get(url, headers) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) }, timeout: 25000 },
      (s) => { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => res({ status: s.statusCode, body: d, headers: s.headers })); }
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
  if (!posKey) { console.log("❌ 搵唔到 key"); return; }
  const H = { apikey: posKey, authorization: `Bearer ${posKey}` };
  const base = `https://${POS_REF}.supabase.co/rest/v1`;

  const o = await get(
    `${base}/pos_orders?select=local_order_no,external_order_id,status,occurred_at,created_at,updated_at,raw_json&external_order_id=like.*${ORDER_TAIL}*&limit=3`,
    H
  );
  console.log(`status=${o.status}`);
  try {
    const rows = JSON.parse(o.body);
    for (const r of rows) {
      console.log(`local_order_no=${r.local_order_no}`);
      console.log(`  occurred_at = ${r.occurred_at}`);
      console.log(`  created_at  = ${r.created_at}`);
      console.log(`  updated_at  = ${r.updated_at}`);
      if (r.occurred_at) console.log(`  occurred_at(澳門) = ${new Date(r.occurred_at).toLocaleString("zh-MO", { timeZone: "Asia/Macau" })}`);
      const raw = r.raw_json;
      if (raw && typeof raw === "object") {
        const apk = raw.__apk || {};
        console.log(`  raw_json keys: ${Object.keys(raw).slice(0, 20).join(",")}`);
        console.log(`  raw_json.__apk = ${JSON.stringify(apk).slice(0, 300)}`);
        // raw 係 list row（APK 送嘅 raw = o.toString()）
        console.log(`  raw.orderDateTime = ${raw.orderDateTime} | raw.orderId = ${raw.orderId} | raw.storeSeqNo = ${raw.storeSeqNo}`);
      }
    }
  } catch (e) { console.log(String(o.body).slice(0, 500)); }
})();
