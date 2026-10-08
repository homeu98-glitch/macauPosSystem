// 一次性：用 production 真實資料，跑單一日嘅 RPC，print 舊欄 + 新 key 實際值
const https = require("node:https");
const fs = require("node:fs");
const WS = "C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules";
const { PGlite } = require(WS + "/@electric-sql/pglite");

const MIG = "supabase/migrations/0066_pos_offline_report_channel.sql";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const DAY = process.argv[2] || "2026-10-07";

const COLS = ["id","store_id","status","source","online_order_id","local_order_no","total",
  "discount_amount","refunded_amount","refund_records","payment_method","service_charge_amount",
  "tax_amount","items","table_id","party_size","settled_at","reopened_at","updated_at","created_at"];

const DDL = `create table public.pos_orders (id text primary key, store_id text, status text, source text,
 online_order_id text, local_order_no text, total numeric, discount_amount numeric, refunded_amount numeric,
 refund_records jsonb, payment_method text, service_charge_amount numeric, tax_amount numeric, items jsonb,
 table_id text, party_size integer, settled_at timestamptz, reopened_at timestamptz, updated_at timestamptz,
 created_at timestamptz);`;

function req(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
      const cs = [];
      r.on("data", (c) => cs.push(c));
      r.on("end", () => res({ status: r.statusCode, body: Buffer.concat(cs).toString("utf8"), cr: r.headers["content-range"] || "" }));
    }).on("error", rej);
  });
}

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) {
    try {
      const r = await req(`https://macau-pos-system.vercel.app${p}`, {});
      (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch (e) {}
  }
  let K = "";
  for (const s of chunks) {
    try {
      const r = await req(`https://macau-pos-system.vercel.app${s}`, {});
      const m = r.body.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g);
      if (m && m.length) { K = m[0]; break; }
    } catch (e) {}
  }
  if (!K) { console.log("no key"); return; }
  const H = { apikey: K, authorization: "Bearer " + K, prefer: "count=exact" };
  const rows = [];
  for (let off = 0; ; off += 500) {
    const r = await req(`https://iyrywzormzisyppkokbi.supabase.co/rest/v1/pos_orders?select=${COLS.join(",")}&store_id=eq.${STORE}&order=id.asc`, { ...H, range: off + "-" + (off + 499) });
    const part = JSON.parse(r.body);
    rows.push(...part);
    if (part.length < 500) break;
  }

  const db = await new PGlite();
  await db.exec(DDL);
  const migRaw = fs.readFileSync(MIG, "utf8").replace(/\r\n/g, "\n");
  const mStart = migRaw.match(/^create or replace function/m);
  await db.exec(migRaw.slice(mStart.index, migRaw.indexOf("$$;", migRaw.indexOf("as $$", mStart.index)) + 3));
  const ph = COLS.map((_, i) => `$${i + 1}`).join(",");
  for (const r of rows) {
    await db.query(`insert into public.pos_orders (${COLS.join(",")}) values (${ph})`,
      COLS.map((c) => { const v = r[c]; if (v == null) return null; return typeof v === "object" ? JSON.stringify(v) : v; }));
  }

  const res = await db.query("select public.pos_offline_report($1,$2,$3) as r", [STORE, DAY, DAY]);
  const o = res.rows[0].r;
  const money = (a) => (Number(a) / 100).toFixed(2);
  const k = o.kpiByChannel || {};

  console.log(`\n=== ${DAY}（production 真實資料，本地 PGlite 實跑）===`);
  console.log("\n【舊欄 — Ledger 現有嗰張卡讀呢組，方案 A 鐵律：一個數字都唔可以變】");
  console.log(`  kpi.orderCount        ${o.orderCount} 張`);
  console.log(`  kpi.revenueAvos       MOP ${money(o.revenueAvos)}`);
  console.log(`  kpi.covers            ${o.covers}`);
  console.log("  byPayment:");
  (o.byPayment || []).forEach((b) => console.log(`      ${String(b.method).padEnd(14)} MOP ${money(b.amountAvos)}`));
  console.log(`  orders[]              ${o.ordersTotal} 張`);
  console.log(`  dishes[]              ${o.dishesTotal} 款`);

  console.log("\n【新 key — 要 Ledger 自己寫 code 讀先會顯示】");
  console.log(`  kpiByChannel.offline         ${k.offline?.orderCount ?? "-"} 張   MOP ${money(k.offline?.revenueAvos ?? 0)}`);
  console.log(`  kpiByChannel.online          ${k.online?.orderCount ?? "-"} 張   MOP ${money(k.online?.revenueAvos ?? 0)}`);
  console.log(`  kpiByChannel.onlinePlatform  ${k.onlinePlatform?.orderCount ?? "-"} 張   MOP ${money(k.onlinePlatform?.revenueAvos ?? 0)}`);
  console.log(`  ordersByChannel[]            ${o.ordersByChannelTotal} 張`);
  console.log(`  dishesByChannel[]            ${o.dishesByChannelTotal} 款`);
  console.log(`  paymentBreakdown[]           ${(o.paymentBreakdown || []).length} 行`);
  (o.paymentBreakdown || []).forEach((b) =>
    console.log(`      ${String(b.label).padEnd(10)} ${String(b.channel).padEnd(18)} ${b.orderCount} 張  實收 MOP ${money(b.paidAvos)}`));
})();
