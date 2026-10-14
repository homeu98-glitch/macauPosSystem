/** 修正版：mfood __apk 對照 + 全部 aomi rows。 */
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

  // 全部 aomi rows
  console.log("== pos_orders 全部 aomi rows ==");
  const a = await get(`${base}/pos_orders?select=id,local_order_no,status,total,created_at,source&source=eq.aomi&order=created_at.desc&limit=10`, H);
  console.log(`status=${a.status}`);
  console.log(String(a.body).slice(0, 1200));

  // mfood 最近 5 張（__apk 對照）
  console.log("\n== pos_orders mfood 最近 5（__apk 對照）==");
  const m = await get(`${base}/pos_orders?select=local_order_no,status,total,created_at,raw_json&source=eq.mfood&order=created_at.desc&limit=5`, H);
  console.log(`status=${m.status}`);
  try {
    for (const row of JSON.parse(m.body)) {
      const inner = row.raw_json && row.raw_json.raw;
      const apk = inner && typeof inner === "object" ? inner.__apk : null;
      const rk = row.raw_json && typeof row.raw_json === "object" ? Object.keys(row.raw_json).slice(0, 6).join(",") : "?";
      console.log(`- ${row.local_order_no} | ${row.status} | total=${row.total} | ${row.created_at} | __apk=${apk ? "YES" : "(ext)"} | rawKeys=${rk}`);
    }
  } catch { console.log(String(m.body).slice(0, 400)); }
})();
