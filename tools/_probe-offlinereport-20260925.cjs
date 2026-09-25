/**
 * 唯讀探測（2026-09-25）：為「Ledger 線下報表 API 契約」取事實。
 *
 * 答三條問題：
 *   ① 正式環境邊幾個 store_id 有單（揀 UAT 對照店用）
 *   ② pos_orders.total 實際值格式 → 判斷係 MOP 小數定 avos 整數
 *   ③ 0057 settled_at 跑咗未 + online_order_id 投影單有幾多（口徑驗證用）
 *
 * 只讀、零憑證（由線上 bundle 抽公開 anon key）。
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
        K = m[0];
        break;
      }
    } catch {}
  }
  if (!K) {
    console.log("❌ 抽唔到 anon key");
    return;
  }
  const payload = JSON.parse(Buffer.from(K.split(".")[1], "base64").toString());
  console.log("anon key ref =", payload.ref, "（應為 iyrywzormzisyppkokbi）\n");

  const q = async (path) => {
    const r = await get(`https://${REF}.supabase.co/rest/v1/${path}`, {
      apikey: K,
      authorization: `Bearer ${K}`,
    });
    let body = null;
    try {
      body = JSON.parse(r.body);
    } catch {}
    return { status: r.status, body };
  };

  // ── ① 邊幾個 store_id 有單（近 24 小時窗口，anon 可讀窗口之內）──
  const recent = await q(
    "pos_orders?select=id,store_id,status,total,online_order_id,settled_at,created_at,source&order=created_at.desc&limit=300",
  );
  if (!Array.isArray(recent.body)) {
    console.log("查詢失敗：", recent.status, String(recent.body).slice(0, 400));
    return;
  }
  console.log(`=== anon 可見 pos_orders 最新 ${recent.body.length} 行（limit=300）===`);
  const byStore = {};
  for (const o of recent.body) {
    const s = o.store_id ?? "(NULL)";
    byStore[s] = byStore[s] || { n: 0, status: {}, online: 0, settledAtNon: 0, totals: [], sources: {} };
    byStore[s].n += 1;
    byStore[s].status[o.status ?? "(null)"] = (byStore[s].status[o.status ?? "(null)"] || 0) + 1;
    if (o.online_order_id) byStore[s].online += 1;
    if (o.settled_at) byStore[s].settledAtNon += 1;
    if (byStore[s].totals.length < 8) byStore[s].totals.push(o.total);
    byStore[s].sources[o.source ?? "(null)"] = (byStore[s].sources[o.source ?? "(null)"] || 0) + 1;
  }
  for (const [s, v] of Object.entries(byStore)) {
    console.log(`store_id = ${s}`);
    console.log(`  行數=${v.n}  online_order_id 非空=${v.online}  settled_at 有值=${v.settledAtNon}`);
    console.log(`  status: ${JSON.stringify(v.status)}`);
    console.log(`  source: ${JSON.stringify(v.sources)}`);
    console.log(`  total 樣本: ${JSON.stringify(v.totals)}`);
  }

  // ── ② total 欄位型別（migration 0011: numeric）＋ ③ settled_at 欄位存在未 ──
  console.log("\n=== 欄位存在性（HTTP 200 = 存在；400/42703 = 未加） ===");
  for (const col of ["total", "settled_at", "reopened_at", "refunded_amount", "party_size", "payment_method", "table_id", "online_order_id"]) {
    const r = await q(`pos_orders?select=${col}&limit=1`);
    console.log(`  ${col.padEnd(18)} HTTP ${r.status} ${r.status === 200 ? "OK" : String(r.body).slice(0, 150)}`);
  }

  // ── ④ 今日（澳門）線下 vs 線上 逐張加總，示範契約口徑 ──
  const macauTodayStart = new Date(Date.now() + 8 * 3600_000);
  macauTodayStart.setUTCHours(0, 0, 0, 0);
  const startIso = new Date(macauTodayStart.getTime() - 8 * 3600_000).toISOString();
  const today = await q(
    `pos_orders?select=id,status,total,online_order_id,payment_method,table_id,party_size,settled_at,updated_at&created_at=gte.${startIso}&limit=300`,
  );
  console.log(`\n=== 澳門今日（自 ${startIso}）${Array.isArray(today.body) ? today.body.length : "?"} 行 ===`);
  if (Array.isArray(today.body)) {
    let sumAll = 0;
    let sumOffline = 0;
    let sumOnline = 0;
    const methods = {};
    for (const o of today.body) {
      if (o.status !== "settled" && o.status !== "paid") continue;
      const t = Number(o.total ?? 0);
      sumAll += t;
      if (o.online_order_id) sumOnline += t;
      else {
        sumOffline += t;
        const m = o.payment_method ?? "未記錄";
        methods[m] = (methods[m] || 0) + t;
      }
    }
    console.log(`  Σ total（settled|paid，全部）  = ${sumAll.toFixed(2)} MOP`);
    console.log(`  Σ total（線下，排除線上投影）  = ${sumOffline.toFixed(2)} MOP  ← 契約 kpi.revenueAvos 應等於呢個 ×100`);
    console.log(`  Σ total（線上投影單）          = ${sumOnline.toFixed(2)} MOP  ← 契約要求排除`);
    console.log(`  線下 byPayment: ${JSON.stringify(methods)}`);
  }
})();
