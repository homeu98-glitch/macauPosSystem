/**
 * 唯讀：抽 Ledger anon key（ref=zymdemjflsckicwcinxl），查 2026-09-24 嘅線上單，
 * 特別係「取餐號 001 / MOP 43」為何未進 POS pos_orders、亦未進報表明細。
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

function jwtInfo(tok) {
  try {
    const p = JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString("utf8"));
    return { ref: p.ref, role: p.role };
  } catch {
    return {};
  }
}

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/pos", "/orders", "/login"]) {
    try {
      const r = await get(SITE + p);
      (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch {}
  }

  const byRef = new Map();
  for (const s of chunks) {
    try {
      const r = await get(SITE + s);
      const m = r.body.match(JWT);
      if (!m) continue;
      for (const tok of m) {
        const { ref, role } = jwtInfo(tok);
        if (!ref || !role) continue;
        if (!byRef.has(ref)) byRef.set(ref, new Map());
        if (!byRef.get(ref).has(role)) byRef.get(ref).set(role, tok);
      }
    } catch {}
  }
  console.log("bundle 內見到嘅專案：");
  for (const [ref, roles] of byRef) console.log(" ", ref, [...roles.keys()].join(","));

  const LEDGER = "zymdemjflsckicwcinxl";
  const anon = byRef.get(LEDGER)?.get("anon");
  if (!anon) { console.log("\n抽唔到 Ledger anon key"); return; }
  console.log("\nLedger anon key OK");

  const LH = `https://${LEDGER}.supabase.co/rest/v1`;
  const H = { apikey: anon, authorization: `Bearer ${anon}` };

  // 1) 表頭形狀
  let r = await get(`${LH}/orders?select=*&limit=2`, H);
  console.log("\n[orders 表] status=", r.status, String(r.body).slice(0, 600));

  // 2) 09-24 全部線上單
  r = await get(
    `${LH}/orders?select=*&order=created_at.desc&limit=100`,
    H
  );
  let rows = [];
  try { rows = JSON.parse(r.body); } catch {}
  if (!Array.isArray(rows)) {
    console.log("\n讀 orders 失敗：", r.status, String(r.body).slice(0, 300));
    return;
  }
  console.log(`\n[orders] 共 ${rows.length} 筆`);
  const mac = (s) => (s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19) : "-");
  for (const o of rows) console.log(JSON.stringify({
    id: o.id, no: o.order_no ?? o.pickup_code ?? o.local_order_no ?? o.code,
    status: o.status, pay: o.payment_status, mode: o.payment_mode,
    total_avos: o.total_avos, created: mac(o.created_at), updated: mac(o.updated_at),
    merchant: o.merchant_id,
  }));

  console.log("\n=== 03:00–08:00 UTC（＝澳門 11:00–16:00）內、total_avos=4300 或 no 含 001 ===");
  for (const o of rows) {
    const no = String(o.order_no ?? o.pickup_code ?? o.local_order_no ?? o.code ?? "");
    if (Number(o.total_avos) === 4300 || no.includes("001") || no === "1") {
      console.log(JSON.stringify(o, null, 2).slice(0, 2000));
      console.log("---");
    }
  }
})();
