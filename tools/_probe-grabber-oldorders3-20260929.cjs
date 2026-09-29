/**
 * 唯讀探測 v3（2026-09-29）：用 PostgREST exact count 坐實「到底有冇 24/09 舊測試單」
 *
 * v2 嘅盲點：只 pull 最新 1000 張（order=created_at.desc）⇒ 若全表 > 1000，
 * 舊單會被截走而睇落「好似冇」。
 * v3 改用 HEAD + Prefer: count=exact 直接問伺服器「有幾多列」，不受 limit 影響。
 *
 * 查：
 *   ① pos_orders 全表總數
 *   ② created_at 落喺 2026-09-24 嘅總數（唔限 source）
 *   ③ external_order_id 以 FAKE- 開頭嘅總數（假單產生器嘅指紋）
 *   ④ local_order_no like 'MFOOD#%' 總數（用嚟判斷有冇過 MFOOD#1..#7x）
 *   ⑤ source=aomi|mfood 總數
 */
const https = require("node:https");

function req(url, opts) {
  return new Promise((res, rej) => {
    const r = https.request(url, { ...opts }, (resp) => {
      let d = "";
      resp.on("data", (c) => (d += c));
      resp.on("end", () => res({ status: resp.statusCode, headers: resp.headers, body: d }));
    });
    r.on("error", rej);
    r.end();
  });
}

function get(url, headers) {
  return req(url, { method: "GET", headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } });
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
  console.log("anonKey len =", K.length, "| ref =", REF);

  const base = `https://${REF}.supabase.co/rest/v1/`;
  const auth = { apikey: K, authorization: `Bearer ${K}` };

  /** HEAD + Prefer: count=exact ⇒ 由 Content-Range 攞伺服器端精確總數 */
  const count = async (path, label) => {
    try {
      const r = await req(base + path, {
        method: "HEAD",
        headers: { ...auth, Prefer: "count=exact" },
      });
      const cr = r.headers["content-range"] || "";
      console.log(`  [${label}] HTTP ${r.status} | Content-Range = ${cr || "(無)"} `);
    } catch (e) {
      console.log(`  [${label}] ERROR ${e.message}`);
    }
  };

  console.log("\n===== exact count（唔受 limit 影響）=====");
  await count("pos_orders?select=id", "① pos_orders 全表總數");
  await count(
    "pos_orders?select=id&created_at=gte.2026-09-24T00:00:00&created_at=lt.2026-09-25T00:00:00",
    "② created_at 落喺 2026-09-24",
  );
  await count(
    "pos_orders?select=id&updated_at=gte.2026-09-24T00:00:00&updated_at=lt.2026-09-25T00:00:00",
    "②b updated_at 落喺 2026-09-24",
  );
  await count(
    "pos_orders?select=id&external_order_id=like.FAKE-*",
    "③ external_order_id 以 FAKE- 開頭（假單指紋）",
  );
  await count(
    "pos_orders?select=id&local_order_no=like.MFOOD*",
    "④ local_order_no like 'MFOOD%'",
  );
  await count(
    "pos_orders?select=id&local_order_no=like.%E6%BE%B3%E8%A6%93*",
    "④b local_order_no like '澳覓%'",
  );
  await count(
    "pos_orders?select=id&source=in.(aomi,mfood)",
    "⑤ source=aomi|mfood 總數",
  );

  // ⑥ 抽出所有 MFOOD / 澳覓 單號，睇下最大序號去到幾多（判斷係咪真存在 #75 / #10）
  const rows = await get(
    base +
      "pos_orders?source=in.(aomi,mfood)&select=local_order_no,source,external_order_id,created_at&order=created_at.desc&limit=1000",
    auth,
  );
  let arr = [];
  try {
    arr = JSON.parse(rows.body);
  } catch {}
  console.log("\n===== ⑥ 所有平台單（最多 1000）=====");
  if (Array.isArray(arr)) {
    console.log("count =", arr.length);
    arr.forEach((o) =>
      console.log(
        `   ${String(o.local_order_no).padEnd(16)} ${String(o.source).padEnd(6)} ${String(
          o.created_at || "",
        ).slice(0, 19)}  ext=${o.external_order_id}`,
      ),
    );
  } else {
    console.log(JSON.stringify(arr).slice(0, 400));
  }
})();
