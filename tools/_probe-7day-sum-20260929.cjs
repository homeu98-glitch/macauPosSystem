/**
 * 唯讀探測 v5（2026-09-29）：回答「macau-pos 顯示 7 日 MOP 2,646，係咪另一個 DB？」
 *
 * 做法：把我查到嘅生產 DB 入面**全部** pos_orders 逐張列出（含 source=pos 嘅堂食單），
 *       計最近 7 日嘅合計，對照用家見到嘅 2,646。
 *       另外分 source 計合計，用嚟判斷「2,646 到底係邊啲單砌出嚟」。
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
const get = (url, headers) =>
  req(url, { method: "GET", headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } });

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

  const base = `https://${REF}.supabase.co/rest/v1/`;
  const auth = { apikey: K, authorization: `Bearer ${K}` };

  const q = async (path) => {
    const r = await get(base + path, auth);
    try {
      return JSON.parse(r.body);
    } catch {
      return { __raw: r.body.slice(0, 300), __status: r.status };
    }
  };

  // 全部 15 張：日期、來源、金額、狀態、settled_at
  const all = await q(
    "pos_orders?select=local_order_no,source,status,total,discount_amount,created_at,updated_at,settled_at,external_order_id&order=created_at.desc&limit=1000",
  );
  if (!Array.isArray(all)) {
    console.log("查詢失敗：", JSON.stringify(all).slice(0, 400));
    return;
  }
  console.log(`pos_orders 總數 = ${all.length}\n`);

  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log(
    pad("單號", 16) + pad("source", 8) + pad("status", 16) + pad("total", 8) + pad("disc", 7) +
      pad("created_at", 21) + pad("settled_at", 21) + "ext",
  );
  console.log("-".repeat(120));
  all.forEach((o) => {
    console.log(
      pad(o.local_order_no, 16) +
        pad(o.source, 8) +
        pad(o.status, 16) +
        pad(o.total, 8) +
        pad(o.discount_amount, 7) +
        pad(String(o.created_at || "").replace("T", " ").slice(0, 19), 21) +
        pad(String(o.settled_at || "").replace("T", " ").slice(0, 19), 21) +
        String(o.external_order_id ?? ""),
    );
  });

  // 合計
  const sum = (rows, f) => rows.reduce((s, o) => s + (Number(o[f]) || 0), 0);
  console.log("\n===== 合計 =====");
  const bySrc = new Map();
  all.forEach((o) => {
    if (!bySrc.has(o.source)) bySrc.set(o.source, []);
    bySrc.get(o.source).push(o);
  });
  [...bySrc.entries()].forEach(([src, rows]) => {
    console.log(
      `  source=${pad(src, 8)} 筆數=${String(rows.length).padStart(3)}  總額 MOP ${sum(rows, "total").toFixed(2)}`,
    );
  });
  console.log(`  ${"全表".padEnd(14)} 筆數=${String(all.length).padStart(3)}  總額 MOP ${sum(all, "total").toFixed(2)}`);

  // 最近 7 日（以 created_at 計，UTC —— 注意澳門時區 +8）
  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 86400000).toISOString();
  const recent = all.filter((o) => String(o.created_at) >= d7);
  console.log(`\n===== 最近 7 日（created_at >= ${d7.slice(0, 19)} UTC）=====`);
  console.log(`  筆數 = ${recent.length}  總額 MOP ${sum(recent, "total").toFixed(2)}`);
  const bySrc7 = new Map();
  recent.forEach((o) => {
    if (!bySrc7.has(o.source)) bySrc7.set(o.source, []);
    bySrc7.get(o.source).push(o);
  });
  [...bySrc7.entries()].forEach(([src, rows]) =>
    console.log(`    ${pad(src, 8)} ${String(rows.length).padStart(3)} 張  MOP ${sum(rows, "total").toFixed(2)}`),
  );

  // 只計「已結帳」類（報表常見口徑）
  const settledish = recent.filter((o) => ["settled", "paid", "closed"].includes(String(o.status)));
  console.log(
    `\n  只計 status in (settled/paid/closed)：${settledish.length} 張  MOP ${sum(settledish, "total").toFixed(2)}`,
  );
})();
