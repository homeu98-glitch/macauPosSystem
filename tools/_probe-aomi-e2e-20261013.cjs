/**
 * 驗證澳覓單 TK001806261013183958080 上送落地：pos_orders + pos_print_jobs（唯讀，anon 視角）。
 * 2026-10-13 澳覓端到端驗證（orderGoods 品項管線）
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
      (s) => {
        let d = "";
        s.on("data", (c) => (d += c));
        s.on("end", () => res({ status: s.statusCode, body: d, headers: s.headers }));
      }
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
  const keys = new Set();
  for (const s of chunks) {
    const r = await get(SITE + s);
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

  console.log("── pos_orders：澳覓單 TK001806261013183958080 ──");
  const o = await get(
    `${base}/pos_orders?select=local_order_no,source,external_order_id,status,subtotal,discount_amount,total,platform_fees,items,created_at&external_order_id=like.*${ORDER_TAIL}*&order=created_at.desc&limit=5`,
    H
  );
  console.log(`status=${o.status}`);
  try {
    const rows = JSON.parse(o.body);
    if (!Array.isArray(rows)) console.log(String(o.body).slice(0, 400));
    else if (rows.length === 0) console.log("(搵唔到呢張單)");
    else for (const r of rows) {
      const t = r.created_at ? new Date(r.created_at).toLocaleString("zh-MO", { timeZone: "Asia/Macau" }) : "?";
      console.log(`  local_order_no=${r.local_order_no} | source=${r.source} | status=${r.status}`);
      console.log(`  external_order_id=${r.external_order_id} | sub=${r.subtotal} disc=${r.discount_amount} total=${r.total}`);
      console.log(`  platform_fees=${JSON.stringify(r.platform_fees)}`);
      console.log(`  created_at(澳門)=${t}`);
      const items = r.items;
      console.log(`  items=${Array.isArray(items) ? items.length + " 件" : JSON.stringify(items)}`);
      if (Array.isArray(items)) {
        for (const it of items) {
          console.log(`    - name=${it.name || it.displayName} qty=${it.quantity} unit=${it.unitPrice} specs=${JSON.stringify(it.specs)}`);
        }
      }
    }
  } catch { console.log(String(o.body).slice(0, 400)); }

  console.log("\n── pos_print_jobs：同一張單 ──");
  const j = await get(
    `${base}/pos_print_jobs?select=order_no,source,status,printer_group,created_at&order_no=like.*${ORDER_TAIL}*&order=created_at.desc&limit=10`,
    H
  );
  console.log(`status=${j.status}`);
  try {
    const rows = JSON.parse(j.body);
    if (!Array.isArray(rows)) console.log(String(j.body).slice(0, 300));
    else if (rows.length === 0) console.log("(冇 print job —— 未出紙)");
    else for (const r of rows) {
      const t = r.created_at ? new Date(r.created_at).toLocaleString("zh-MO", { timeZone: "Asia/Macau" }) : "?";
      console.log(`  ${r.order_no} | ${r.source} | ${r.status} | ${r.printer_group} | ${t}`);
    }
  } catch { console.log(String(j.body).slice(0, 300)); }

  console.log("\n── pos_orders：全部澳覓單（最新 5 筆）──");
  const a = await get(
    `${base}/pos_orders?select=local_order_no,external_order_id,status,total,created_at&source=eq.aomi&order=created_at.desc&limit=5`,
    H
  );
  try {
    const rows = JSON.parse(a.body);
    if (Array.isArray(rows)) for (const r of rows) {
      const t = r.created_at ? new Date(r.created_at).toLocaleString("zh-MO", { timeZone: "Asia/Macau" }) : "?";
      console.log(`  ${r.local_order_no} | ${r.external_order_id} | ${r.status} | total=${r.total} | ${t}`);
    } else console.log(String(a.body).slice(0, 300));
  } catch { console.log(String(a.body).slice(0, 300)); }
})();
