/** 完整輸出 raw_json（route 收到嘅 order 物件），鎖定 APK 送咗咩。 */
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
    `${base}/pos_orders?select=raw_json&external_order_id=like.*${ORDER_TAIL}*&limit=1`,
    H
  );
  console.log(`status=${o.status}`);
  try {
    const rows = JSON.parse(o.body);
    const raw = rows[0] && rows[0].raw_json;
    if (!raw) { console.log(String(o.body).slice(0, 400)); return; }
    // 印 order 物件（除 raw 外）
    const { raw: inner, ...rest } = raw;
    console.log("== order 物件 ==");
    console.log(JSON.stringify(rest, null, 1).slice(0, 2500));
    console.log("\n== order.raw（APK 送嘅 raw 欄位）keys ==");
    if (inner && typeof inner === "object") {
      console.log(Object.keys(inner).join(","));
      console.log("orderId=" + inner.orderId, "orderDateTime=" + inner.orderDateTime, "storeSeq=" + inner.storeSeq, "orderStateStr=" + inner.orderStateStr);
      const states = inner.states;
      if (Array.isArray(states)) console.log("states[0]=" + JSON.stringify(states[0]));
      const goods = inner.orderGoods;
      if (Array.isArray(goods)) console.log("orderGoods=" + JSON.stringify(goods).slice(0, 400));
    } else {
      console.log("inner = " + String(inner).slice(0, 300));
    }
  } catch { console.log(String(o.body).slice(0, 600)); }
})();
