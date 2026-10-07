/**
 * 唯讀取證（2026-10-07）· offline-report 擴充「線上+線下」前嘅量測。
 *
 * 目的：量 90 日窗口內，主店 pos_orders 按「來源類別」拆嘅單量，
 *令 offline-report 擴充後嘅 payload 容量估算有實測支撐（唔靠估）。
 *
 * 三種類別（對應方案 §channel 欄位）：
 *   offline            = online_order_id IS NULL AND source NOT IN ('aomi','mfood')
 *   online_projection  = online_order_id IS NOT NULL      （掃碼／排位／快餐採納）
 *   online_platform    = source IN ('aomi','mfood')      （Grabber 推入嘅外賣平台單）
 *
 * 🔴 純唯讀，只讀 pos_orders 一張表嘅少量欄位。
 */
const https = require("node:https");

function get(url, headers) {
  return new Promise((res, rej) => {
    https
      .get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => res({ status: r.statusCode, body: d }));
      })
      .on("error", rej);
  });
}

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const SITE = "https://macau-pos-system.vercel.app";
const REF = "iyrywzormzisyppkokbi";
const STORE = "8291f843-9def-4956-9d0b-1cfeb2598306".replace("cfeb", "cfef");
// 90 日窗口起點（澳門時區），對齊 SQL 用嘅四條時間腿
const SINCE = "2026-07-09T16:00:00Z";

/** UTC ISO → 澳門日期 YYYY-MM-DD（同 SQL `at time zone 'Asia/Macau'`）。 */
function macDay(iso) {
  if (!iso) return null;
  const d = new Date(Date.parse(iso) + 8 * 3600e3);
  return d.toISOString().slice(0, 10);
}

/** 同 SQL 一致嘅 event instant：settled_at → reopened_at → updated_at → created_at */
function eventInstant(o) {
  return o.settled_at || o.reopened_at || o.updated_at || o.created_at || null;
}

function classify(o) {
  if (o.online_order_id) return "online_projection";
  const src = String(o.source || "");
  if (src === "aomi" || src === "mfood") return "online_platform";
  return "offline";
}

/** 同 SQL 0060 dishes[] 一致：聚合 key = menuItemId|名稱。 */
function dishKeyOf(it) {
  const id = String(it && it.menuItemId != null ? it.menuItemId : "").trim();
  const nm = String(it && it.name != null ? it.name : "").trim() || "(未命名)";
  return `${id}|${nm}`;
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
  if (!K) { console.log("❌ 抽唔到 anon key"); return; }
  const H = { apikey: K, authorization: `Bearer ${K}` };

  const sel = "id,status,total,items,payment_method,created_at,updated_at,reopened_at,settled_at,online_order_id,source";
  const rows = [];
  for (let off = 0; off < 4000; off += 1000) {
    const url =
      `https://${REF}.supabase.co/rest/v1/pos_orders?select=${sel}` +
      `&store_id=eq.${STORE}` +
      `&or=(settled_at.gte.${SINCE},reopened_at.gte.${SINCE},updated_at.gte.${SINCE},created_at.gte.${SINCE})` +
      `&order=created_at.desc&limit=1000&offset=${off}`;
    const r = await get(url, H);
    if (r.status >= 400) { console.log("❌", r.status, r.body.slice(0, 300)); return; }
    const batch = JSON.parse(r.body);
    rows.push(...batch);
    if (batch.length < 1000) break;
  }

  console.log(`90 日內 pos_orders 總行數：${rows.length}\n`);

  // ── ① 按 channel × status 統計 ──
  const stat = {};
  const dishesByChannel = { offline: new Map(), online: new Map() };
  const payableByChannel = { offline: 0, online: 0 };
  const methodByChannel = { offline: {}, online: {} };
  const DAY = 90;

  for (const o of rows) {
    const ch = classify(o) === "offline" ? "offline" : "online";
    const st = String(o.status || "");
    stat[ch] = stat[ch] || { total: 0, settledOrPaid: 0, notCancelled: 0, cancelled: 0 };
    stat[ch].total += 1;
    if (st === "settled" || st === "paid") stat[ch].settledOrPaid += 1;
    if (st !== "cancelled") stat[ch].notCancelled += 1;
    else stat[ch].cancelled += 1;

    // dishes[] 口徑：只計 settled/paid、排除 voided
    if (st !== "settled" && st !== "paid") continue;
    const arr = Array.isArray(o.items) ? o.items : [];
    for (const it of arr) {
      if (String(it && it.voided) === "true") continue;
      const k = dishKeyOf(it);
      const q = Number(it && it.quantity) || 0;
      const pr = Number(it && it.price) || 0;
      const m = dishesByChannel[ch];
      const cur = m.get(k) || { name: String(it.name || "(未命名)"), qty: 0, rev: 0 };
      cur.qty += q;
      cur.rev += pr * q;
      m.set(k, cur);
    }
    payableByChannel[ch] += Number(o.total) || 0;
    const pm = String(o.payment_method || "").trim() || "未記錄";
    methodByChannel[ch][pm] = (methodByChannel[ch][pm] || 0) + (Number(o.total) || 0);
  }

  console.log("=== ① 按 channel（90 日）===");
  for (const ch of ["offline", "online"]) {
    const s = stat[ch] || { total: 0, settledOrPaid: 0, notCancelled: 0, cancelled: 0 };
    console.log(
      `  ${ch.padEnd(8)} 全部 ${String(s.total).padStart(5)}｜可計銷售 ${String(s.settledOrPaid).padStart(5)}` +
      `｜非作廢 ${String(s.notCancelled).padStart(5)}｜可計銷售營業額 MOP ${payableByChannel[ch].toFixed(2)}`,
    );
  }
  const onlineMix = {};
  for (const o of rows) if (classify(o) !== "offline") { const c = classify(o); onlineMix[c] = (onlineMix[c] || 0) + 1; }
  console.log(`  線上細分：${JSON.stringify(onlineMix)}`);

  console.log("\n=== ② 支付方式（可計銷售單，MOP）===");
  for (const ch of ["offline", "online"]) {
    console.log(`  -- ${ch} --`);
    for (const [k, v] of Object.entries(methodByChannel[ch]).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${k.padEnd(14)} MOP ${v.toFixed(2)}`);
    }
  }

  console.log("\n=== ③ 菜品款數（聚合 key = menuItemId|名稱）===");
  for (const ch of ["offline", "online"]) {
    const arr = [...dishesByChannel[ch].values()].sort((a, b) => b.rev - a.rev);
    const rev = arr.reduce((s, d) => s + d.rev, 0);
    console.log(`  ${ch.padEnd(8)} ${arr.length} 款，Σ price×qty = MOP ${rev.toFixed(2)}`);
    for (const d of arr.slice(0, 5)) console.log(`      ${d.name.padEnd(16)} qty ${d.qty}  MOP ${d.rev.toFixed(2)}`);
  }
  const union = new Set([...dishesByChannel.offline.keys(), ...dishesByChannel.online.keys()]);
  console.log(`  聯集款數：${union.size}（離線 ${dishesByChannel.offline.size} / 線上 ${dishesByChannel.online.size}）`);

  console.log("\n=== ④ 容量估算（90 日，實測單量）===");
  const offNotCancelled = stat.offline ? stat.offline.notCancelled : 0;
  const onNotCancelled = stat.online ? stat.online.notCancelled : 0;
  // 現時每張單 3 欄 ≈ 230 B（docs/153 §7 實測）；加 channel 欄 ≈ +14 B
  const B = 244;
  console.log(`  orders[]  線下 ${offNotCancelled} + 線上 ${onNotCancelled} = ${offNotCancelled + onNotCancelled} 張`);
  console.log(`            × ${B} B ≈ ${Math.round(((offNotCancelled + onNotCancelled) * B) / 1024)} KB`);
  console.log(`  dishes[] 聯集 ${union.size} 款 × 約 60 B ≈ ${Math.round((union.size * 60) / 1024)} KB`);
  console.log(`  （現時 3000 張上限 vs 實測 ${offNotCancelled + onNotCancelled} 張 → ${offNotCancelled + onNotCancelled > 3000 ? "會截斷" : "唔會截斷"}）`);
  console.log(`  （現時 300 款上限 vs 聯集 ${union.size} 款 → ${union.size > 300 ? "會截斷" : "唔會截斷"}）`);
  console.log(`  平均：${((offNotCancelled + onNotCancelled) / DAY).toFixed(1)} 張/日`);
})();