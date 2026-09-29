/**
 * 唯讀探測（2026-09-29）：查「澳覓單 已對帳 但實收 0」嘅 DB 真相。
 *
 * 背景：插件 popup 顯示某澳覓單「實收價格 MOP 43.21」，
 *       但 POS 報表「澳覓 結算」三格顯示「實收金額 MOP 0（已對帳）」。
 *
 * 要答嘅問題：
 *   ① pos_orders 入面澳覓單嘅 platform_net_amount / platform_subsidy_net /
 *      platform_settled_at 到底係幾多？（null ＝ 未對帳；0 ＝ 假零）
 *   ② external_order_id 係咩格式？（TK… 定純數字）
 *   ③ pos_platform_settlements 有冇澳覓帳期？should / receive / subsidy 幾多？
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
  if (!K) {
    console.log("抽唔到 anon key（中止）");
    return;
  }

  const base = `https://${REF}.supabase.co/rest/v1/`;
  const auth = { apikey: K, authorization: `Bearer ${K}` };

  const q = async (path) => {
    const r = await get(base + path, auth);
    try {
      return JSON.parse(r.body);
    } catch {
      return { __raw: r.body.slice(0, 400), __status: r.status };
    }
  };

  const pad = (s, n) => String(s ?? "").padEnd(n);

  // ───────── ① 全部平台單（aomi / mfood）逐張列 ─────────
  const all = await q(
    "pos_orders?source=in.(aomi,mfood)&select=local_order_no,source,status,total,platform_net_amount,platform_subsidy_net,platform_settled_at,external_order_id,created_at&order=created_at.desc&limit=200",
  );
  if (!Array.isArray(all)) {
    console.log("查 pos_orders 失敗：", JSON.stringify(all).slice(0, 500));
  } else {
    console.log(`\n===== pos_orders（source in aomi,mfood）共 ${all.length} 張 =====`);
    console.log(
      pad("單號", 12) +
        pad("source", 8) +
        pad("status", 16) +
        pad("total", 8) +
        pad("net", 10) +
        pad("subsidy", 10) +
        pad("settled_at", 22) +
        "external_order_id",
    );
    console.log("-".repeat(130));
    all.forEach((o) => {
      console.log(
        pad(o.local_order_no, 12) +
          pad(o.source, 8) +
          pad(o.status, 16) +
          pad(o.total, 8) +
          pad(o.platform_net_amount === null ? "(null)" : o.platform_net_amount, 10) +
          pad(o.platform_subsidy_net === null ? "(null)" : o.platform_subsidy_net, 10) +
          pad(String(o.platform_settled_at || "").replace("T", " ").slice(0, 19), 22) +
          String(o.external_order_id ?? ""),
      );
    });
  }

  // ───────── ② 帳期級 ─────────
  const per = await q(
    "pos_platform_settlements?select=store_id,source,period,should_amount,receive_amount,subsidy_amount,service_fee,fetched_at&order=fetched_at.desc&limit=50",
  );
  if (!Array.isArray(per)) {
    console.log("\n查 pos_platform_settlements 失敗：", JSON.stringify(per).slice(0, 500));
  } else {
    console.log(`\n===== pos_platform_settlements 共 ${per.length} 筆 =====`);
    console.log(
      pad("source", 8) +
        pad("period", 30) +
        pad("should", 10) +
        pad("receive", 10) +
        pad("subsidy", 10) +
        pad("fee", 8) +
        "fetched_at",
    );
    console.log("-".repeat(120));
    per.forEach((p) => {
      console.log(
        pad(p.source, 8) +
          pad(p.period, 30) +
          pad(p.should_amount === null ? "(null)" : p.should_amount, 10) +
          pad(p.receive_amount === null ? "(null)" : p.receive_amount, 10) +
          pad(p.subsidy_amount === null ? "(null)" : p.subsidy_amount, 10) +
          pad(p.service_fee === null ? "(null)" : p.service_fee, 8) +
          String(p.fetched_at || "").replace("T", " ").slice(0, 19),
      );
    });
  }

  // ───────── ③ 欄位存在性（migration 跑咗未）─────────
  const probeCol = await q("pos_orders?select=platform_net_amount&limit=1");
  console.log(
    "\n欄位 platform_net_amount 存在性：",
    Array.isArray(probeCol) ? "存在" : JSON.stringify(probeCol).slice(0, 200),
  );
})();
