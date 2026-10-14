/** 最終驗證：澳覓訂單喺 pos_orders 嘅完整狀態 + push log + inbox + mfood __apk 對照。 */
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

  // 1. 澳覓訂單完整 row
  const o = await get(`${base}/pos_orders?select=*&external_order_id=like.*${ORDER_TAIL}*&limit=1`, H);
  console.log(`== pos_orders aomi row == status=${o.status}`);
  try {
    const rows = JSON.parse(o.body);
    if (!rows.length) { console.log("(搵唔到 row)"); }
    else {
      const row = rows[0];
      const { raw_json, ...rest } = row;
      console.log("-- 頂層欄位 --");
      console.log(JSON.stringify(rest, null, 1).slice(0, 1800));
      console.log("\n-- raw_json.raw 標記 --");
      const inner = raw_json && raw_json.raw;
      if (inner && typeof inner === "object") {
        console.log("keys: " + Object.keys(inner).join(","));
        console.log("__apk 標記: " + JSON.stringify(inner.__apk || null));
      } else {
        console.log("inner keys: " + (inner && typeof inner === "object" ? Object.keys(inner).join(",") : String(inner).slice(0, 200)));
      }
      console.log("\n-- raw_json 頂層 keys --");
      console.log(raw_json && typeof raw_json === "object" ? Object.keys(raw_json).join(",") : String(raw_json).slice(0, 200));
    }
  } catch { console.log(String(o.body).slice(0, 600)); }

  // 2. push log aomi
  console.log("\n== pos_grabber_push_log（aomi 最近 5）==");
  const p = await get(
    `${base}/pos_grabber_push_log?select=source,received_count,created_count,skipped_count,rejected_count,external_order_ids,local_order_nos,captured_at&source=like.*aomi*&order=captured_at.desc&limit=5`,
    H
  );
  console.log(`status=${p.status}`);
  console.log(String(p.body).slice(0, 1500));

  // 3. inbox aomi
  console.log("\n== pos_grabber_inbox（aomi 最近 5）==");
  const i = await get(
    `${base}/pos_grabber_inbox?select=platform,dedup_key,parse_ok,reject_reason,occurred_at,captured_at&platform=eq.aomi&order=captured_at.desc&limit=5`,
    H
  );
  console.log(`status=${i.status}`);
  console.log(String(i.body).slice(0, 1500));

  // 4. mfood __apk 對照（最近 3 張）
  console.log("\n== pos_orders mfood 最近 3（對照投影路徑）==");
  const m = await get(
    `${base}/pos_orders?select=platform,order_number,status,amount_mop,business_amount_mop,external_order_id,raw_json&platform=eq.mfood&order=created_at.desc&limit=3`,
    H
  );
  console.log(`status=${m.status}`);
  try {
    for (const row of JSON.parse(m.body)) {
      const inner = row.raw_json && row.raw_json.raw;
      const apk = inner && typeof inner === "object" ? inner.__apk : null;
      console.log(`- ${row.external_order_id} | ${row.order_number} | ${row.status} | amt=${row.amount_mop} biz=${row.business_amount_mop} | __apk=${apk ? JSON.stringify(apk).slice(0, 120) : "(extension)"}`);
    }
  } catch { console.log(String(m.body).slice(0, 400)); }
})();
