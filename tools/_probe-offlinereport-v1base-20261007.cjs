/**
 * 唯讀取證（2026-10-07 22:35）· 第三輪：釐清 v1 口徑 kpi 嘅真實基數。
 *
 * 背景：0058 嘅 kpi 定義係
 *   status in ('settled','paid')  AND  online_order_id is null
 * 而平台單（source in aomi/mfood）**冇** online_order_id ⇒ 會被包埋。
 * 但平台單唔係全部 settled/paid ⇒ v1 實際基數要逐 status 數。
 *
 * 呢輪只做一件事：逐 (channel, status) 數張數 + 金額，確認：
 *   ① v1 kpi 實際輸出幾多張 / 幾多錢
 *   ② orders[]（全部狀態）現時幾多張 → 新版幾多張
 *   ③ 有冇 cancelled（會影響 orders[] 計數）
 */
const https = require("node:https");

function get(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    }).on("error", rej);
  });
}

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const SITE = "https://macau-pos-system.vercel.app";
const REF = "iyrywzormzisyppkokbi";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const SINCE = "2026-07-09T16:00:00Z";

function channel(o) {
  const s = String(o.source || "");
  if (s === "aomi" || s === "mfood") return "online_platform";
  if (o.online_order_id) return "online_projection";
  return "offline";
}

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) {
    try {
      const r = await get(SITE + p);
      (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch {}
  }
  let K = "";
  for (const s of chunks) {
    try {
      const r = await get(SITE + s);
      const m = r.body.match(JWT);
      if (m && m.length) { K = m[0]; break; }
    } catch {}
  }
  if (!K) { console.log("X 抽唔到 key"); return; }
  const H = { apikey: K, authorization: `Bearer ${K}` };

  const sel = "id,status,total,source,online_order_id";
  const rows = [];
  for (let off = 0; off < 5000; off += 1000) {
    const url =
      `https://${REF}.supabase.co/rest/v1/pos_orders?select=${sel}` +
      `&store_id=eq.${STORE}` +
      `&or=(settled_at.gte.${SINCE},reopened_at.gte.${SINCE},updated_at.gte.${SINCE},created_at.gte.${SINCE})` +
      `&order=created_at.desc&limit=1000&offset=${off}`;
    const r = await get(url, H);
    let j = [];
    try { j = JSON.parse(r.body); } catch {}
    if (!Array.isArray(j) || !j.length) break;
    rows.push(...j);
    if (j.length < 1000) break;
  }

  console.log("拉到行數:", rows.length);

  const byChSt = new Map();
  for (const o of rows) {
    const k = channel(o) + " | " + String(o.status || "(null)");
    const cur = byChSt.get(k) || { n: 0, avos: 0 };
    cur.n += 1;
    cur.avos += Math.round((Number(o.total) || 0) * 100);
    byChSt.set(k, cur);
  }
  console.log("\n=== 逐 (channel | status) ===");
  const keys = [...byChSt.keys()].sort();
  for (const k of keys) {
    const c = byChSt.get(k);
    console.log(k.padEnd(42), String(c.n).padStart(4), "張", (c.avos / 100).toFixed(2).padStart(10), "MOP");
  }

  const COUNTABLE = new Set(["settled", "paid"]);
  const v1rows = rows.filter((o) => !o.online_order_id);
  const v1kpi = v1rows.filter((o) => COUNTABLE.has(String(o.status)));
  const v1kpiAvos = v1kpi.reduce((s, o) => s + Math.round((Number(o.total) || 0) * 100), 0);

  const ordersNew = rows.filter((o) => String(o.status) !== "cancelled");
  const cnt = (f) => {
    const s = rows.filter(f);
    return `${String(s.length).padStart(4)} 張 ${(s.reduce((a, o) => a + Math.round((Number(o.total) || 0) * 100), 0) / 100).toFixed(2).padStart(10)} MOP`;
  };

  console.log("\n=== v1 口徑（online_order_id is null + settled/paid）===");
  console.log("  kpi.orderCount =", v1kpi.length, " revenueAvos =", v1kpiAvos, "=", (v1kpiAvos / 100).toFixed(2), "MOP");

  console.log("\n=== 拆解 ===");
  console.log("  offline 可計銷售        ", cnt((o) => channel(o) === "offline" && COUNTABLE.has(String(o.status))));
  console.log("  online_platform 可計銷售 ", cnt((o) => channel(o) === "online_platform" && COUNTABLE.has(String(o.status))));
  console.log("  online_projection 可計銷售", cnt((o) => channel(o) === "online_projection" && COUNTABLE.has(String(o.status))));

  console.log("\n=== orders[] 張數 ===");
  console.log("  v1（online_order_id is null, 全部狀態）", cnt((o) => !o.online_order_id));
  console.log("  v2（全量, 剔 cancelled）                 ", ordersNew.length, "張");
  const canc = rows.filter((o) => String(o.status) === "cancelled");
  console.log("  其中 cancelled:", canc.length, "張", canc.map((o) => channel(o) + "/" + o.status).join(","));
})();
