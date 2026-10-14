/** 查 mfood __apk row 嘅 platform_fees / discount_amount，確認 APK 路線嘅費用行現況。 */
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

  const m = await get(`${base}/pos_orders?select=local_order_no,total,subtotal,discount_amount,platform_fees,raw_json&source=eq.mfood&order=created_at.desc&limit=5`, H);
  console.log(`status=${m.status}`);
  try {
    for (const row of JSON.parse(m.body)) {
      const inner = row.raw_json && row.raw_json.raw;
      const apk = inner && typeof inner === "object" ? inner.__apk : null;
      console.log(`\n- ${row.local_order_no} | total=${row.total} subtotal=${row.subtotal} discount=${row.discount_amount} | __apk=${apk ? "YES" : "(ext)"}`);
      console.log(`  platform_fees=${JSON.stringify(row.platform_fees)}`);
      if (apk) console.log(`  __apk=${JSON.stringify(apk).slice(0, 300)}`);
    }
  } catch { console.log(String(m.body).slice(0, 400)); }
})();
