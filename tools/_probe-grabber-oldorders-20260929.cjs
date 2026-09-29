/**
 * 唯讀探測（2026-09-29）：回答三條問題嘅 DB 事實層
 *   Q1. MFOOD#75 / 澳覓#10 呢類舊測試單——係「今日被重發」定「24/09 測試嗰陣已入庫」？
 *       → 比 created_at（平台單時間）同 updated_at（入庫／最後更新時間）。
 *   Q2. 有冇任何一張係今日先寫入／被對帳更新過？（platform_settled_at 有冇值）
 *   Q3. MFOOD#883658 呢種單號：external_order_id 係咩、local_order_no 係咩。
 *
 * 另外拉 pos_platform_settlements 睇今日對帳到底寫咗邊啲帳期。
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

  const orders = await q(
    "pos_orders?source=in.(aomi,mfood)&select=store_id,local_order_no,source,external_order_id,status,total,discount_amount,platform_net_amount,platform_settled_at,created_at,updated_at,client_updated_at&order=created_at.asc&limit=400",
  );
  console.log("\n=== pos_orders (source=aomi|mfood) ===");
  if (!Array.isArray(orders)) {
    console.log("NOT ARRAY:", JSON.stringify(orders));
    return;
  }
  console.log("total rows =", orders.length);

  const stores = new Set(orders.map((o) => o.store_id));
  console.log("store_id =", [...stores].join(" | "));

  // ── 逐日統計（以 created_at 日期前綴）──
  const byDay = new Map();
  for (const o of orders) {
    const day = String(o.created_at || "").slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  console.log("\n── 按 created_at 日期分佈 ──");
  for (const [day, n] of [...byDay.entries()].sort()) console.log("  ", day, "×", n);

  // ── 入庫時間 vs 平台時間（逐張列印）──
  console.log("\n── 逐張：local_no | src | created_at(平台) | updated_at(入庫/更新) | client_updated_at | settled_at | total/discount ──");
  for (const o of orders) {
    const created = String(o.created_at || "").replace("T", " ").slice(0, 19);
    const updated = String(o.updated_at || "").replace("T", " ").slice(0, 19);
    const clientUp = String(o.client_updated_at || "").replace("T", " ").slice(0, 19);
    const settled = String(o.platform_settled_at || "—").replace("T", " ").slice(0, 19);
    console.log(
      [
        String(o.local_order_no).padEnd(16),
        String(o.source).padEnd(5),
        created,
        "| upd " + updated,
        "| cli " + clientUp,
        "| pset " + settled,
        "| " + o.total + "/" + o.discount_amount,
        "ext=" + String(o.external_order_id),
      ].join("  "),
    );
  }

  // ── 帳期級結算 ──
  const ps = await q("pos_platform_settlements?select=*&order=fetched_at.desc&limit=20");
  console.log("\n=== pos_platform_settlements（最近 20）===");
  if (!Array.isArray(ps)) {
    console.log("NOT ARRAY:", JSON.stringify(ps));
  } else {
    for (const p of ps) {
      console.log(
        [
          "store=" + String(p.store_id),
          "src=" + String(p.source),
          "period=" + String(p.period),
          "should=" + String(p.should_amount),
          "receive=" + String(p.receive_amount),
          "fetched=" + String(p.fetched_at),
        ].join("  "),
      );
    }
  }
})();
