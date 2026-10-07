/**
 * 唯讀取證（2026-10-07）· 第二輪：驗證支付方式分項擴充所需嘅口徑。
 *
 * 第一輪已確認（tools/_probe-offlinereport-online-20261007.cjs）：
 *   · 90 日內 94 張：offline 66 / online 28（projection 19 + platform 9）
 *   · 線上佔 28 張 / 29% 金額 —— 唔係小數字，必須納入
 *   · 🔴 線上單嘅 payment_method 有 raw Ledger 值（in_store / balance）漏咗出嚟
 *   · dishes 聯集 64 款（離線 49 / 線上 25，有 10 款重疊）
 *
 * 呢輪驗證：
 *   ① 應收金額算法（POS 報表頁口徑）＝ Σ(item.price × qty) + service_charge_amount + tax_amount
 *      —— 同實收（total）嘅差額分佈，決定 byPayment 擴充值唔值得
 *   ② payment_method raw 值全清單（確認邊啲需要 paymentModeLabel 翻譯）
 *   ③ 線上單 items 結構同離線是否一致（menuItemId / name / quantity / price / voided 齊唔齊）
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
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const SINCE = "2026-07-09T16:00:00Z";

function classify(o) {
  if (o.online_order_id) return "online_projection";
  const s = String(o.source || "");
  if (s === "aomi" || s === "mfood") return "online_platform";
  return "offline";
}

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
      if (m && m.length) { K = m[0]; break; }
    } catch {}
  }
  if (!K) { console.log("❌ 抽唔到 key"); return; }
  const H = { apikey: K, authorization: `Bearer ${K}` };

  const sel = "id,status,total,items,payment_method,discount_amount,service_charge_amount,tax_amount,subtotal," +
    "platform_fees,platform_net_amount,platform_subsidy_net,online_order_id,source,created_at,updated_at,reopened_at,settled_at";
  const rows = [];
  for (let off = 0; off < 2000; off += 1000) {
    const url =
      `https://${REF}.supabase.co/rest/v1/pos_orders?select=${sel}` +
      `&store_id=eq.${STORE}` +
      `&or=(settled_at.gte.${SINCE},reopened_at.gte.${SINCE},updated_at.gte.${SINCE},created_at.gte.${SINCE})` +
      `&order=created_at.desc&limit=1000&offset=${off}`;
    const r = await get(url, H);
    if (r.status >= 400) { console.log("❌", r.status, r.body.slice(0, 200)); return; }
    const b = JSON.parse(r.body);
    rows.push(...b);
    if (b.length < 1000) break;
  }

  const sale = rows.filter((o) => o.status === "settled" || o.status === "paid");

  console.log(`可計銷售單：${sale.length} 張\n`);

  console.log("=== ① 應收 vs 實收差額（POS 報表頁口徑）===");
  console.log("單號             channel             實收    應收    差額   服務費  稅  折扣");
  console.log("-".repeat(88));
  let sumPaid = 0, sumRecv = 0, withDiff = 0;
  for (const o of sale) {
    const arr = Array.isArray(o.items) ? o.items : [];
    const itemsGross = arr.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0);
    const recv = itemsGross + (Number(o.service_charge_amount) || 0) + (Number(o.tax_amount) || 0);
    const paid = Number(o.total) || 0;
    const diff = recv - paid;
    sumPaid += paid; sumRecv += recv;
    if (Math.abs(diff) > 0.01) withDiff += 1;
    if (Math.abs(diff) > 0.01) {
      console.log(
        `${String(o.id).slice(0, 8)}  ${classify(o).padEnd(18)}` +
        `${paid.toFixed(2).padStart(8)}${recv.toFixed(2).padStart(8)}${diff.toFixed(2).padStart(8)}` +
        `${(Number(o.service_charge_amount) || 0).toFixed(2).padStart(8)}` +
        `${(Number(o.tax_amount) || 0).toFixed(2).padStart(6)}` +
        `${(Number(o.discount_amount) || 0).toFixed(2).padStart(7)}`,
      );
    }
  }
  console.log(`\nΣ實收 MOP ${sumPaid.toFixed(2)}｜Σ應收 MOP ${sumRecv.toFixed(2)}｜Σ差額 MOP ${(sumRecv - sumPaid).toFixed(2)}`);
  console.log(`有差額嘅單：${withDiff} / ${sale.length}（${((withDiff / sale.length) * 100).toFixed(0)}%）`);
  console.log(`⇒ 應收欄值得加：${withDiff > 0 ? "有，差額來自服務費/稅/全單折扣" : "呢批單冇差額，加咗都係 0（但平台單/優惠單會有）"}`);

  console.log("\n=== ② payment_method 全清單（可計銷售單）===");
  const byCh = {};
  for (const o of sale) {
    const ch = classify(o);
    const pm = String(o.payment_method || "").trim() || "(空)";
    byCh[ch] = byCh[ch] || {};
    byCh[ch][pm] = (byCh[ch][pm] || 0) + 1;
  }
  for (const [ch, m] of Object.entries(byCh)) {
    console.log(`  -- ${ch} --`);
    for (const [k, v] of Object.entries(m).sort((a, b) => b[1] - a[1])) console.log(`     ${JSON.stringify(k).padEnd(22)} ${v} 張`);
  }
  const rawLedger = sale.filter((o) => ["in_store", "balance"].includes(String(o.payment_method || "").trim()));
  console.log(`\n🔴 raw Ledger payment_mode 值（未經 paymentModeLabel 翻譯）：${rawLedger.length} 張`);
  console.log(`   → POS 報表頁會顯示「in_store」/「balance」，而 translation 表會顯示「到店付款」/「餘額扣點」`);
  console.log(`   → 這就是「支付分類要同 macau-pos 一樣補上」的核心：SQL 側要做同一套 mapping`);

  console.log("\n=== ③ 線上單 items 欄位完整性 ===");
  const online = sale.filter((o) => classify(o) !== "offline");
  const keys = {};
  let missingMenuId = 0, totalItems = 0;
  for (const o of online) {
    const arr = Array.isArray(o.items) ? o.items : [];
    totalItems += arr.length;
    for (const it of arr) {
      for (const k of Object.keys(it || {})) keys[k] = (keys[k] || 0) + 1;
      if (!it || it.menuItemId == null || String(it.menuItemId).trim() === "") missingMenuId += 1;
    }
  }
  console.log(`  線上可計銷售 ${online.length} 張，共 ${totalItems} 行 item`);
  console.log(`  item 欄位出現次數：${JSON.stringify(keys)}`);
  console.log(`  缺 menuItemId 嘅行：${missingMenuId}（⇒ 聚合 key 會退化用名稱）`);

  console.log("\n=== ④ 平台單結算欄位（有值 = 已對帳）===");
  const plat = sale.filter((o) => classify(o) === "online_platform");
  for (const o of plat) {
    console.log(
      `  ${String(o.id).slice(0, 14)} src=${String(o.source).padEnd(6)} 營業額 ${(Number(o.total) || 0).toFixed(2).padStart(8)}` +
      ` 實收 ${String(o.platform_net_amount ?? "null").padStart(8)} 補貼後 ${String(o.platform_subsidy_net ?? "null").padStart(8)}` +
      ` fees=${Array.isArray(o.platform_fees) ? o.platform_fees.length : 0}`,
    );
  }
})();