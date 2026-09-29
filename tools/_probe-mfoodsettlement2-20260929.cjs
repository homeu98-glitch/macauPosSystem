/**
 * 唯讀探測 v2（2026-09-29）：
 *   · pos_orders 到底有冇 mfood 單？（上面 v1 查到 0 —— 要排除係 RLS 定真係冇）
 *   · source 分佈
 *   · pos_platform_settlements 表係咪真係唔存在
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
      if (m && m.length) {
        for (const tok of m) {
          try {
            const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString());
            if (payload && payload.ref === REF) { K = tok; break; }
          } catch {}
        }
      }
      if (K) break;
    } catch {}
  }

  const q = async (path, extra) => {
    const r = await get(`https://${REF}.supabase.co/rest/v1/${path}`, {
      apikey: K,
      authorization: `Bearer ${K}`,
      ...(extra || {}),
    });
    try { return JSON.parse(r.body); } catch { return { __status: r.status, __raw: r.body.slice(0, 500) }; }
  };

  // ① 全表 source 分佈（睇 RLS 有冇擋）
  const all = await q("pos_orders?select=id,store_id,source,external_order_id,created_at&order=created_at.desc&limit=200");
  console.log("=== ① pos_orders 全表（最近 200）===");
  if (!Array.isArray(all)) { console.log(JSON.stringify(all)); }
  else {
    const bySrc = {};
    for (const o of all) bySrc[String(o.source)] = (bySrc[String(o.source)] || 0) + 1;
    console.log("返回列數 =", all.length, " source 分佈 =", JSON.stringify(bySrc));
    const stores = [...new Set(all.map((o) => o.store_id))];
    console.log("store_id =", stores.join(" | "));
    console.log("前 5 列:");
    for (const o of all.slice(0, 5)) console.log("  ", JSON.stringify(o));
  }

  // ② 唔帶任何 filter，淨揀 external_order_id（睇有冇外賣單）
  const ext = await q("pos_orders?select=external_order_id,source,local_order_no,platform_net_amount,platform_settled_at&external_order_id=not.is.null&order=created_at.desc&limit=40");
  console.log("\n=== ② external_order_id 非空嘅單 ===");
  if (!Array.isArray(ext)) console.log(JSON.stringify(ext));
  else {
    console.log("count =", ext.length);
    for (const o of ext.slice(0, 20)) console.log("  ", JSON.stringify(o));
  }

  // ③ 結算欄位有值嘅單
  const settled = await q("pos_orders?select=external_order_id,source,local_order_no,platform_net_amount,platform_subsidy_net,platform_settled_at&platform_settled_at=not.is.null&limit=40");
  console.log("\n=== ③ platform_settled_at 非空（已對帳）嘅單 ===");
  if (!Array.isArray(settled)) console.log(JSON.stringify(settled));
  else { console.log("count =", settled.length); for (const o of settled.slice(0, 20)) console.log("  ", JSON.stringify(o)); }

  // ④ 表存在未（多種寫法交叉驗）
  for (const t of ["pos_platform_settlements", "pos_platform_settlement"]) {
    const r = await q(`${t}?select=*&limit=1`);
    console.log(`\n=== ④ ${t} ===`, JSON.stringify(r).slice(0, 300));
  }
})();
