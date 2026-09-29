/**
 * 唯讀探測 v3（2026-09-29）：用 `Prefer: count=exact` 攞真實總數，
 * 分辨「RLS 時窗擋住」定「生產 DB 真係冇 mfood 單」。
 */
const https = require("node:https");

function req(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, headers: r.headers, body: d }));
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
      const r = await req(SITE + p);
      (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch {}
  }
  let K = "";
  for (const s of chunks) {
    try {
      const r = await req(SITE + s);
      const m = r.body.match(JWT);
      if (m) for (const tok of m) {
        try {
          if (JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString()).ref === REF) { K = tok; break; }
        } catch {}
      }
      if (K) break;
    } catch {}
  }

  const q = async (path) => {
    const r = await req(`https://${REF}.supabase.co/rest/v1/${path}`, {
      apikey: K,
      authorization: `Bearer ${K}`,
      prefer: "count=exact",
    });
    return { range: r.headers["content-range"] || r.headers["Content-Range"], status: r.status, body: r.body };
  };

  const show = async (label, path) => {
    const r = await q(path);
    console.log(`--- ${label}\n    status=${r.status} content-range=${r.range || "(none)"}`);
    if (r.status >= 400) console.log("    body:", r.body.slice(0, 300));
  };

  await show("pos_orders 全表總數", "pos_orders?select=id&limit=1");
  await show("pos_orders source=mfood 總數", "pos_orders?select=id&source=eq.mfood&limit=1");
  await show("pos_orders source=aomi 總數", "pos_orders?select=id&source=eq.aomi&limit=1");
  await show("pos_orders external_order_id 非空 總數", "pos_orders?select=id&external_order_id=not.is.null&limit=1");
  await show("pos_orders platform_settled_at 非空 總數", "pos_orders?select=id&platform_settled_at=not.is.null&limit=1");

  // 最舊嘅 10 列
  const oldest = await req(`https://${REF}.supabase.co/rest/v1/pos_orders?select=id,store_id,source,created_at,external_order_id&order=created_at.asc&limit=10`, {
    apikey: K, authorization: `Bearer ${K}`,
  });
  console.log("\n--- 最舊 10 列:");
  console.log(oldest.body.slice(0, 1500));

  // 表清單（用 OpenAPI）
  const openapi = await req(`https://${REF}.supabase.co/rest/v1/`, { apikey: K, authorization: `Bearer ${K}` });
  const names = Object.keys(JSON.parse(openapi.body || "{}").paths || {});
  console.log("\n--- PostgREST 可見表（搵 platform / settlement）:");
  console.log(names.filter((n) => /platform|settle|summary/i.test(n)).join("\n") || "(冇)");
  console.log("\n--- 全部表數目 =", names.length);
  console.log(names.join(", "));
})();
