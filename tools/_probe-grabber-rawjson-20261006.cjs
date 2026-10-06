/**
 * 查 raw_json.__apk（來源標記）與 pos_orders 喺 APK 上送下的狀態。
 * 2026-10-07
 */
const https = require("node:https");
const SITE = "https://macau-pos-system.vercel.app";
const POS_REF = "iyrywzormzisyppkokbi";

function get(url, headers) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) }, timeout: 25000 },
      (s) => { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => res({ status: s.statusCode, body: d, headers: s.headers })); }
    );
    r.on("error", (e) => res({ status: "ERR", body: String(e.message), headers: {} }));
    r.on("timeout", () => { r.destroy(); res({ status: "TIMEOUT", body: "", headers: {} }); });
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
    let ref = ""; try { ref = JSON.parse(Buffer.from(k.split(".")[1], "base64").toString()).ref || ""; } catch {}
    if (ref === POS_REF) posKey = k;
  }
  if (!posKey) { console.log("❌ no key"); return; }
  const H = { apikey: posKey, authorization: `Bearer ${posKey}`, prefer: "count=exact" };
  const base = `https://${POS_REF}.supabase.co/rest/v1`;

  const o = await get(`${base}/pos_orders?select=local_order_no,external_order_id,source,status,total,created_at,raw_json&source=eq.mfood&order=created_at.desc&limit=8`, H);
  console.log(`status=${o.status}`);
  const rows = JSON.parse(o.body);
  for (const r of rows) {
    const raw = r.raw_json || {};
    const apk = raw.__apk;
    const keysTxt = Object.keys(raw).slice(0, 20).join(",");
    console.log(`\n${r.local_order_no} | ${r.external_order_id} | ${r.status} | total=${r.total}`);
    console.log(`  raw_json.__apk = ${JSON.stringify(apk)}`);
    console.log(`  raw_json keys(${Object.keys(raw).length}): ${keysTxt}`);
    if (raw.items) console.log(`  raw.items len = ${Array.isArray(raw.items) ? raw.items.length : typeof raw.items}`);
    if (raw.prdtList) console.log(`  raw.prdtList len = ${Array.isArray(raw.prdtList) ? raw.prdtList.length : typeof raw.prdtList}`);
  }
})();
