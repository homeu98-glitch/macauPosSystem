/**
 * 查 APK 上送訂單的 items 是否有菜品內容（唯讀，anon 視角）。
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
      (s) => {
        let d = "";
        s.on("data", (c) => (d += c));
        s.on("end", () => res({ status: s.statusCode, body: d, headers: s.headers }));
      }
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
    let ref = "";
    try { ref = JSON.parse(Buffer.from(k.split(".")[1], "base64").toString()).ref || ""; } catch {}
    if (ref === POS_REF) posKey = k;
  }
  if (!posKey) { console.log("❌ 搵唔到 POS anon key"); return; }

  const H = { apikey: posKey, authorization: `Bearer ${posKey}`, prefer: "count=exact" };
  const base = `https://${POS_REF}.supabase.co/rest/v1`;

  // 先看 pos_orders 有咩欄位（用一條拎全部）
  console.log("── pos_orders（mfood，最新 4 筆，全欄位）──");
  const o = await get(
    `${base}/pos_orders?select=*&source=eq.mfood&order=created_at.desc&limit=4`,
    H
  );
  console.log(`status=${o.status}`);
  try {
    const rows = JSON.parse(o.body);
    if (!Array.isArray(rows)) { console.log(String(o.body).slice(0, 500)); }
    else {
      console.log(`欄位: ${rows.length ? Object.keys(rows[0]).join(", ") : "(空)"}`);
      for (const r of rows) {
        console.log(`\n=== ${r.local_order_no} | ext=${r.external_order_id} | ${r.status} ===`);
        console.log(`  items type=${typeof r.items} : ${JSON.stringify(r.items)?.slice(0, 1200)}`);
      }
    }
  } catch (e) { console.log(String(o.body).slice(0, 500)); }

  // 睇有冇 order_items 分表
  console.log("\n── pos_order_items（若存在）──");
  const it = await get(`${base}/pos_order_items?select=*&limit=3`, H);
  console.log(`status=${it.status} ${String(it.body).slice(0, 600)}`);
})();
