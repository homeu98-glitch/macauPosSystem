/**
 * 唯讀：復算「報表明細應該有幾張」——分兩種日界口徑：
 *   ① 依 updated_at ∈ 澳門 09-24（＝`orderEventInstant()` 雲端實際口徑）
 *   ② 依 created_at ∈ 澳門 09-24
 * 目標：睇報表截圖嘅「28 張」邊一個口徑對得上 ⇒ 反推有無計 Ledger 純線上單。
 */
const https = require("node:https");
function get(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    }).on("error", rej);
  });
}
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const SITE = "https://macau-pos-system.vercel.app";
const REF = "iyrywzormzisyppkokbi";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) {
    try { const r = await get(SITE + p); (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {}
  }
  let K = "";
  for (const s of chunks) {
    try { const r = await get(SITE + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {}
  }
  const H = { apikey: K, authorization: `Bearer ${K}` };
  const r = await get(
    `https://${REF}.supabase.co/rest/v1/pos_orders?select=id,local_order_no,status,total,updated_at,created_at,online_order_id&store_id=eq.${STORE}&created_at=gte.2026-09-23T16:00:00Z&limit=500`,
    H
  );
  const rows = JSON.parse(r.body);
  const mac = (s) => (s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19) : "-");
  const countable = (o) => o.status === "settled" || o.status === "paid";
  const inMacDay = (iso, day) => mac(iso).slice(0, 5) === day;

  console.log("雲端 09-24 建單共", rows.length, "張（表嫂）");
  const byStatus = {};
  for (const o of rows) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  console.log("狀態分佈:", JSON.stringify(byStatus), "\n");

  const byUpdated = rows.filter((o) => countable(o) && inMacDay(o.updated_at, "09-24"));
  const byCreated = rows.filter((o) => countable(o) && inMacDay(o.created_at, "09-24"));
  console.log(`① 可計 + updated_at 在澳門 09-24 ⇒ ${byUpdated.length} 張`);
  console.log(`② 可計 + created_at 在澳門 09-24 ⇒ ${byCreated.length} 張\n`);

  console.log("=== ① 嘅清單（結帳時間倒序）===");
  for (const o of byUpdated.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))) {
    console.log(`  ${mac(o.updated_at)}  ${String(o.local_order_no).padEnd(12)} ${String(o.status).padEnd(10)} ${String(o.total).padStart(6)}  ${o.online_order_id ? "線上" : "—"}`);
  }

  const diff = rows.filter((o) => countable(o) && !inMacDay(o.updated_at, "09-24"));
  console.log(`\n=== 可計但 updated_at 唔喺 09-24（被報表剔走）${diff.length} 張 ===`);
  for (const o of diff) console.log(`  updated=${mac(o.updated_at)}  ${o.local_order_no}  ${o.status}  ${o.total}`);
})();
