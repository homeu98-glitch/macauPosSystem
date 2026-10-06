/**
 * 驗證 APK 抓單上送落地：pos_grabber_inbox + pos_orders（唯讀，anon 視角）。
 * 2026-10-06 端到端驗證
 */
const https = require("node:https");

const SITE = "https://macau-pos-system.vercel.app";
const POS_REF = "iyrywzormzisyppkokbi";
const STORE = "d564b932-0c91-45e9-86fd-0ec8e2711f13"; // 由 grabber SP key 抽到

function get(url, headers) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) }, timeout: 25000 },
      (s) => {
        let d = "";
        s.on("data", (c) => (d += c));
        s.on("end", () => res({ status: s.statusCode, body: d }));
      }
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
  if (!posKey) { console.log("❌ 搵唔到 POS anon key"); return; }

  const H = { apikey: posKey, authorization: `Bearer ${posKey}`, prefer: "count=exact" };
  const base = `https://${POS_REF}.supabase.co/rest/v1`;

  // pos_orders 係 anon 可讀（skill 記錄）
  console.log("── pos_orders（來源 mfood，最新）──");
  const o = await get(
    `${base}/pos_orders?select=local_order_no,source,external_order_id,status,subtotal,discount_amount,total,platform_fees,created_at&source=eq.mfood&order=created_at.desc&limit=10`,
    H
  );
  console.log(`status=${o.status}`);
  try {
    const rows = JSON.parse(o.body);
    if (!Array.isArray(rows)) { console.log(String(o.body).slice(0, 300)); }
    else if (rows.length === 0) console.log("(冇 mfood 來源訂單)");
    else
      for (const r of rows) {
        const t = r.created_at ? new Date(r.created_at).toLocaleString("zh-MO", { timeZone: "Asia/Macau" }) : "?";
        console.log(
          `  ${r.local_order_no} | ${r.external_order_id} | ${r.status} | ` +
            `sub=${r.subtotal} disc=${r.discount_amount} total=${r.total} fees=${JSON.stringify(r.platform_fees)} | ${t}`
        );
      }
  } catch { console.log(String(o.body).slice(0, 300)); }

  // 順手查整體 mfood/aomi/mpay 數量
  const c = await get(`${base}/pos_orders?select=id&source=in.(mfood,aomi,mpay)`, H);
  const cr = (c.headers && c.headers["content-range"]) || "";
  console.log(`\n全部外賣平台單 content-range = ${cr}`);

  // inbox 係 service_role only ⇒ anon 一定 42501（正常）
  const i = await get(`${base}/pos_grabber_inbox?select=*&limit=1`, H);
  console.log(`\npos_grabber_inbox（anon 視角，預期 42501）→ ${i.status}`);
})();
