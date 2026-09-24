/**
 * 唯讀：補建後嘅對賬 —— 查表嫂今日 pos_orders，搵重複（同一 online_order_id 兩張、
 * 同一單出現兩次），並復算報表應有張數／金額。
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
  const q = async (path) => {
    const r = await get(`https://${REF}.supabase.co/rest/v1/${path}`, H);
    try { return { status: r.status, json: JSON.parse(r.body), raw: r.body }; } catch { return { status: r.status, json: null, raw: r.body }; }
  };

  // 唔帶 created_at 過濾：補建單可能用 Ledger 事件時間（較舊）
  const r = await q(
    `pos_orders?select=id,local_order_no,status,total,online_order_id,source,created_at,updated_at,table_name&store_id=eq.${STORE}&updated_at=gte.2026-09-23T16:00:00Z&order=updated_at.desc&limit=500`
  );
  if (!Array.isArray(r.json)) { console.log("查詢失敗", r.status, String(r.raw).slice(0, 300)); return; }
  const rows = r.json;

  const mac = (s) => (s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19) : "-");
  const countable = (o) => o.status === "settled" || o.status === "paid";
  const inToday = (o) => mac(o.updated_at).slice(0, 5) === "09-24";

  console.log(`表嫂 pos_orders（updated_at >= 09-23T16:00Z）共 ${rows.length} 張\n`);
  const byStatus = {};
  for (const o of rows) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  console.log("狀態分佈:", JSON.stringify(byStatus));

  const counted = rows.filter((o) => countable(o) && inToday(o));
  const sum = counted.reduce((s, o) => s + Number(o.total ?? 0), 0);
  console.log(`\n可計 ＋ updated_at ∈ 澳門 09-24 ⇒ ${counted.length} 張 / MOP ${Math.round(sum * 100) / 100}`);
  console.log("（報表截圖：37 張 / MOP 2423）\n");

  console.log("=== 明細（updated_at desc）===");
  for (const o of counted) {
    console.log(
      `${mac(o.updated_at)}  ${String(o.local_order_no).padEnd(12)} ${String(o.status).padEnd(9)} ${String(o.total).padStart(6)}  ${o.online_order_id ? "線上" : "— "}  ${String(o.table_name ?? "").padEnd(10)} id=${o.id}`
    );
  }

  // 重複檢測
  console.log("\n=== 🔴 重複檢測 ===");
  const byOnline = {};
  for (const o of rows) {
    if (!o.online_order_id) continue;
    byOnline[o.online_order_id] = byOnline[o.online_order_id] || [];
    byOnline[o.online_order_id].push(o);
  }
  let dupOnline = 0;
  for (const [oid, list] of Object.entries(byOnline)) {
    if (list.length > 1) {
      dupOnline += 1;
      console.log(`online_order_id=${oid} 有 ${list.length} 張：`);
      for (const o of list) console.log(`   id=${o.id} no=${o.local_order_no} status=${o.status} total=${o.total} updated=${mac(o.updated_at)}`);
    }
  }
  if (dupOnline === 0) console.log("（冇同一 online_order_id 兩張單）");

  const byNo = {};
  for (const o of rows) {
    const k = `${o.local_order_no}|${mac(o.created_at).slice(0, 5)}`;
    byNo[k] = byNo[k] || [];
    byNo[k].push(o);
  }
  console.log("\n單號重複（同單號同建立日 ≥2 張）：");
  let found = false;
  for (const [k, list] of Object.entries(byNo)) {
    if (list.length > 1) {
      found = true;
      console.log(`  ${k} ⇒ ${list.length} 張: ${list.map((o) => `${o.id}(${o.status}/${o.total})`).join(", ")}`);
    }
  }
  if (!found) console.log("  （冇）");

  // 補建單（source 或 id 特徵）
  console.log("\n=== id 以 ledger- 開頭嘅單（＝線上投影／補建）===");
  for (const o of rows.filter((x) => String(x.id).startsWith("ledger-"))) {
    console.log(`  ${mac(o.updated_at)} ${String(o.local_order_no).padEnd(10)} ${o.status} ${o.total} online=${o.online_order_id} id=${o.id}`);
  }
})();
