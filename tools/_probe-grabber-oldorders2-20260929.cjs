/**
 * 唯讀探測 v2（2026-09-29）：舊測試單（MFOOD#75 / 澳覓#10 等，24/09）到底喺邊？
 *   ① 24/09 全部 pos_orders（唔限 source）——睇下嗰日有咩單
 *   ② local_order_no like 搜尋（澳覓#10 / MFOOD#75 / 786777 …）
 *   ③ 全表 source 分佈
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
            if (payload && payload.ref === REF) {
              K = tok;
              break;
            }
          } catch {}
        }
      }
      if (K) break;
    } catch {}
  }
  console.log("anonKey len =", K.length);

  const q = async (path) => {
    const r = await get(`https://${REF}.supabase.co/rest/v1/${path}`, {
      apikey: K,
      authorization: `Bearer ${K}`,
    });
    try {
      return JSON.parse(r.body);
    } catch {
      return { __raw: r.body.slice(0, 400), __status: r.status };
    }
  };

  const dump = (rows) => {
    for (const o of rows || []) {
      console.log(
        [
          String(o.local_order_no).padEnd(16),
          String(o.source).padEnd(6),
          String(o.status).padEnd(15),
          String(o.created_at || "").replace("T", " ").slice(0, 19),
          "| upd " + String(o.updated_at || "").replace("T", " ").slice(0, 19),
          "| " + o.total,
        ].join("  "),
      );
    }
  };

  // ① 24/09 全部單（唔限 source）
  const d24 = await q(
    "pos_orders?created_at=gte.2026-09-24T00:00:00&created_at=lt.2026-09-25T00:00:00&select=local_order_no,source,status,total,created_at,updated_at&order=created_at.asc&limit=200",
  );
  console.log("\n=== ① created_at 落喺 2026-09-24 嘅單（全部 source）===");
  if (Array.isArray(d24)) {
    console.log("count =", d24.length);
    const bySrc = new Map();
    d24.forEach((o) => bySrc.set(o.source, (bySrc.get(o.source) || 0) + 1));
    console.log("source 分佈 =", JSON.stringify([...bySrc.entries()]));
    dump(d24.slice(0, 40));
  } else console.log(JSON.stringify(d24));

  // ② updated_at 落喺 24/09（可能 created_at 係平台時間但入庫係 24/09）
  const u24 = await q(
    "pos_orders?updated_at=gte.2026-09-24T00:00:00&updated_at=lt.2026-09-25T00:00:00&select=local_order_no,source,status,total,created_at,updated_at&order=updated_at.asc&limit=200",
  );
  console.log("\n=== ② updated_at 落喺 2026-09-24 嘅單 ===");
  if (Array.isArray(u24)) {
    console.log("count =", u24.length);
    dump(u24.slice(0, 40));
  } else console.log(JSON.stringify(u24));

  // ③ 單號 like 搜尋
  for (const needle of ["883658", "786777", "594220", "358708", "%25E6%25BE%25B3%25E8%25A6%2593%2523", "FAKE-"]) {
    const rows = await q(
      `pos_orders?local_order_no=like.*${needle}*&select=local_order_no,source,status,total,created_at,updated_at&order=created_at.desc&limit=10`,
    );
    console.log(`\n=== ③ local_order_no like *${needle}* ===`);
    if (Array.isArray(rows)) {
      console.log("count =", rows.length);
      dump(rows);
    } else console.log(JSON.stringify(rows));
  }

  // ④ 全表 source 分佈（拉 1000 統計）
  const all = await q(
    "pos_orders?select=local_order_no,source,created_at&order=created_at.desc&limit=1000",
  );
  if (Array.isArray(all)) {
    const bySrc = new Map();
    all.forEach((o) => bySrc.set(o.source, (bySrc.get(o.source) || 0) + 1));
    console.log("\n=== ④ 全表（最新 1000）source 分佈 ===");
    console.log("count =", all.length, JSON.stringify([...bySrc.entries()]));
    const stores = await q("pos_orders?select=store_id&limit=1000");
    if (Array.isArray(stores)) {
      const bs = new Map();
      stores.forEach((o) => bs.set(o.store_id, (bs.get(o.store_id) || 0) + 1));
      console.log("store 分佈 =", JSON.stringify([...bs.entries()].map(([k, v]) => [String(k).slice(0, 8), v])));
    }
  } else console.log(JSON.stringify(all));
})();
