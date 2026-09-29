/**
 * 唯讀探測（2026-09-29）：診斷「POS 搵到張 mfood 單，但實收價格冇補返」。
 *
 * 要答嘅問題：
 *   A. pos_orders.external_order_id（插件接單時寫入）到底係咩格式？
 *      同財務頁嘅 tradeNo（CRD2026...）係咪同一個值？
 *   B. platform_net_amount / platform_subsidy_net / platform_settled_at 有冇寫到？
 *   C. pos_platform_settlements（帳期級）有冇寫到？
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
  console.log("anonKey len =", K.length, "ref ok =", (() => {
    try {
      return JSON.parse(Buffer.from(K.split(".")[1], "base64").toString()).ref;
    } catch {
      return "(n/a)";
    }
  })());

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

  // ── A + B：mfood 單（含結算三欄）──
  const orders = await q(
    "pos_orders?source=eq.mfood&select=store_id,local_order_no,external_order_id,total,status,platform_net_amount,platform_subsidy_net,platform_settled_at,created_at&order=created_at.desc&limit=25",
  );
  console.log("\n=== A/B: pos_orders (source=mfood) ===");
  if (!Array.isArray(orders)) {
    console.log("NOT ARRAY:", JSON.stringify(orders));
  } else {
    console.log("count =", orders.length);
    const stores = new Set(orders.map((o) => o.store_id));
    console.log("store_id 出現過 =", [...stores].join(" | "));
    for (const o of orders) {
      console.log(
        [
          String(o.local_order_no).padEnd(12),
          "ext=" + String(o.external_order_id),
          "total=" + String(o.total),
          "net=" + String(o.platform_net_amount),
          "sub=" + String(o.platform_subsidy_net),
          "settledAt=" + String(o.platform_settled_at),
          "created=" + String(o.created_at),
        ].join("  "),
      );
    }
  }

  // ── C：帳期級 ──
  const ps = await q("pos_platform_settlements?select=*&order=fetched_at.desc&limit=30");
  console.log("\n=== C: pos_platform_settlements ===");
  if (!Array.isArray(ps)) {
    console.log("NOT ARRAY:", JSON.stringify(ps));
  } else {
    console.log("count =", ps.length);
    for (const p of ps) {
      console.log(
        [
          "store=" + String(p.store_id),
          "src=" + String(p.source),
          "period=" + String(p.period),
          "should=" + String(p.should_amount),
          "receive=" + String(p.receive_amount),
          "subsidy=" + String(p.subsidy_amount),
          "fee=" + String(p.service_fee),
          "fetched=" + String(p.fetched_at),
        ].join("  "),
      );
    }
  }

  // ── D：欄位存在未（migration 0060）──
  const col = await q("pos_orders?select=platform_net_amount&limit=1");
  console.log("\n=== D: platform_net_amount 欄位可讀? ===", JSON.stringify(col));
})();
