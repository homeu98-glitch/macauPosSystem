/** 檢查 pos_orders 入面 mfood/aomi 單嘅 raw_json 形狀：有 __apk = APK 送；否則 = 擴展功能送。 */
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

  for (const src of ["mfood", "aomi"]) {
    console.log(`── pos_orders：${src} 最新 8 筆（raw_json 形狀）──`);
    const o = await get(
      `${base}/pos_orders?select=local_order_no,external_order_id,status,total,created_at,raw_json&source=eq.${src}&order=created_at.desc&limit=8`,
      H
    );
    try {
      const rows = JSON.parse(o.body);
      if (!Array.isArray(rows)) { console.log(String(o.body).slice(0, 300)); continue; }
      for (const r of rows) {
        const raw = r.raw_json || {};
        const hasApk = raw.raw && typeof raw.raw === "object" && "__apk" in raw.raw;
        const shape = hasApk ? "APK" : (raw.timeline || raw.stateEnum || raw.amount && raw.amount.boxAmt !== undefined ? "擴展" : "其他");
        const t = r.created_at ? new Date(r.created_at).toLocaleString("zh-MO", { timeZone: "Asia/Macau" }) : "?";
        const itemN = Array.isArray(raw.items) ? raw.items.length : "?";
        console.log(`  ${r.local_order_no} | ${r.external_order_id} | ${r.status} | total=${r.total} | items=${itemN} | 來源=${shape} | ${t}`);
      }
    } catch { console.log(String(o.body).slice(0, 300)); }
    console.log("");
  }
})();
