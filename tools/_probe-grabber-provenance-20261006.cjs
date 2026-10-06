/**
 * 判定：pos_orders 10-06 嗰兩張單，到底係 APK 路線送嘅，定係舊 Chrome 插件送嘅。
 * 決定性證據 = raw_json 有冇 ingest route 專屬寫入嘅 `__apk` 標記。
 * 2026-10-06
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

  // ① 10-06 全部 mfood 單 + raw_json（睇有冇 __apk）
  console.log("═══ ① 10-06 mfood 單 + __apk 標記 ═══");
  const r1 = await get(
    `${base}/pos_orders?select=id,store_id,local_order_no,external_order_id,created_at,updated_at,raw_json&source=eq.mfood&created_at=gte.2026-10-06T00:00:00Z&order=created_at.desc&limit=20`,
    H
  );
  console.log(`status=${r1.status}`);
  try {
    const rows = JSON.parse(r1.body);
    if (!Array.isArray(rows)) console.log(String(r1.body).slice(0, 300));
    else if (!rows.length) console.log("(冇 10-06 之後嘅 mfood 單)");
    else
      for (const r of rows) {
        const raw = r.raw_json;
        const hasApk = raw && typeof raw === "object" && raw.__apk ? "✅ APK" : "❌ 插件";
        const upd = r.updated_at ? new Date(r.updated_at).toISOString() : "?";
        const cre = r.created_at ? new Date(r.created_at).toISOString() : "?";
        console.log(`  ${r.local_order_no} ${r.external_order_id}`);
        console.log(`     store=${r.store_id}`);
        console.log(`     created_at=${cre}`);
        console.log(`     updated_at=${upd}   ${hasApk}`);
        if (raw && typeof raw === "object" && raw.__apk) {
          console.log(`     __apk = ${JSON.stringify(raw.__apk).slice(0, 220)}`);
        } else if (raw && typeof raw === "object") {
          console.log(`     raw keys = ${Object.keys(raw).slice(0, 12).join(",")}`);
        } else {
          console.log(`     raw = ${String(raw).slice(0, 120)}`);
        }
      }
  } catch (e) { console.log("parse fail:", String(r1.body).slice(0, 300)); }

  // ② 對照：舊插件入嘅單（10-05）有冇 __apk
  console.log("\n═══ ② 對照組：10-05 舊單（應該冇 __apk）═══");
  const r2 = await get(
    `${base}/pos_orders?select=local_order_no,external_order_id,raw_json&source=eq.mfood&created_at=lt.2026-10-06T00:00:00Z&order=created_at.desc&limit=3`,
    H
  );
  try {
    for (const r of JSON.parse(r2.body)) {
      const raw = r.raw_json;
      const hasApk = raw && typeof raw === "object" && raw.__apk ? "✅ 有 __apk" : "❌ 冇 __apk";
      console.log(`  ${r.local_order_no} ${r.external_order_id} → ${hasApk}`);
      if (raw && typeof raw === "object") console.log(`     raw keys = ${Object.keys(raw).slice(0, 12).join(",")}`);
    }
  } catch { console.log(String(r2.body).slice(0, 200)); }

  // ③ 全店 mfood 單嘅 store_id 分佈（確認邊間店）
  console.log("\n═══ ③ mfood 單 store_id 分佈 ═══");
  const r3 = await get(`${base}/pos_orders?select=store_id&source=eq.mfood&limit=200`, H);
  const counts = {};
  try { for (const r of JSON.parse(r3.body)) counts[r.store_id] = (counts[r.store_id] || 0) + 1; } catch {}
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k} → ${v} 張`);
})();
