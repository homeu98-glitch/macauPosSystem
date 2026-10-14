/** 查 pos_grabber_push_log + pos_grabber_inbox 入面 APK 送嘅澳覓單记录。 */
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

  console.log("── pos_grabber_push_log（aomi 最近）──");
  const p = await get(
    `${base}/pos_grabber_push_log?select=source,received_count,created_count,skipped_count,rejected_count,external_order_ids,local_order_nos,captured_at&source=like.*aomi*&order=captured_at.desc&limit=5`,
    H
  );
  console.log(`status=${p.status}`);
  console.log(String(p.body).slice(0, 1200));

  console.log("\n── pos_grabber_inbox（aomi + 該單）──");
  const i = await get(
    `${base}/pos_grabber_inbox?select=platform,dedup_key,parse_ok,reject_reason,occurred_at,captured_at&platform=eq.aomi&order=captured_at.desc&limit=5`,
    H
  );
  console.log(`status=${i.status}`);
  console.log(String(i.body).slice(0, 1200));
})();
