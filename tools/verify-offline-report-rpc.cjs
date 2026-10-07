/**
 * 🔴🔴 本地真跑 `pos_offline_report`（0066）—— 唯一唔使 service role 都可以驗證 RPC 嘅方法。
 *
 * **點解需要呢支**：Postgres 嘅 `create or replace function` 只驗**語法**、**唔驗欄位**
 * （`check_function_bodies` 只做 parse）。所以 Supabase SQL Editor 會回
 * `Success. No rows returned`，但函數實際係壞嘅 —— 要到**執行**先爆 42703。
 * 2026-10-08 就係咁：連續兩條 CTE 漏欄（`status`、`dname`），SQL Editor 全部報 Success。
 *
 * **做法**：
 *   ① 由已部署 bundle 抽 anon key（唔使任何憑證）
 *   ② 由 PostgREST 抓主店全部 `pos_orders` 行（`Prefer: count=exact` + `Content-Range` 驗證）
 *   ③ 落 PGlite（WASM Postgres）建表、建函數、**執行**
 *   ④ 對 `_probe-offlinereport-truth` 獨立取證探針定落嘅基線 ＋ 不變量
 *
 * **用法**：
 *   NODE_PATH=<workspace>/node_modules node tools/verify-offline-report-rpc.cjs
 * 需要 `@electric-sql/pglite`；冇裝會印安裝指令然後 exit 3（當 skip，唔當 fail）。
 */
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const REF = "iyrywzormzisyppkokbi";
const STORE = process.env.POS_PROBE_STORE || "8291f843-9def-4956-9d0b-1cfef2598306";
const FROM = process.env.POS_PROBE_FROM || "2026-07-10";
const TO = process.env.POS_PROBE_TO || "2026-10-07";
const BASE = `https://${REF}.supabase.co/rest/v1`;
const MIG = "supabase/migrations/0066_pos_offline_report_channel.sql";

// ── 合成種子：抓唔到生產資料時嘅降級（仍然捉到「漏欄」呢類 bug）──────────────
const SEED_ROWS = [
  { id: "s1", store_id: "S1", status: "settled", source: null, online_order_id: null, local_order_no: "A-1",
    total: 100, discount_amount: 0, refunded_amount: null, refund_records: null, payment_method: "Mpay",
    service_charge_amount: 0, tax_amount: 0,
    items: [{ menuItemId: "m1", name: "乾炒牛河", quantity: 2, price: 30 }], table_id: "T1", party_size: 2,
    settled_at: "2026-10-06T04:00:00+00:00", created_at: "2026-10-06T04:00:00+00:00", updated_at: "2026-10-06T04:00:00+00:00" },
  { id: "s2", store_id: "S1", status: "paid", source: null, online_order_id: null, local_order_no: "A-2",
    total: 50, discount_amount: 5, refunded_amount: null, refund_records: null, payment_method: "cash",
    service_charge_amount: 0, tax_amount: 0,
    items: [{ menuItemId: "m2", name: "凍檸茶", quantity: 1, price: 20 }], table_id: "counter", party_size: 1,
    settled_at: "2026-10-06T05:00:00+00:00", created_at: "2026-10-06T05:00:00+00:00", updated_at: "2026-10-06T05:00:00+00:00" },
  { id: "s3", store_id: "S1", status: "settled", source: null, online_order_id: "ONL-1", local_order_no: null,
    total: 80, discount_amount: 0, refunded_amount: null, refund_records: null, payment_method: "in_store",
    service_charge_amount: 0, tax_amount: 0,
    items: [{ menuItemId: "m1", name: "乾炒牛河", quantity: 1, price: 30 }, { menuItemId: "m3", name: "魚皮", quantity: 1, price: 26 }],
    table_id: null, party_size: 1,
    settled_at: "2026-10-06T06:00:00+00:00", created_at: "2026-10-06T06:00:00+00:00", updated_at: "2026-10-06T06:00:00+00:00" },
  { id: "s4", store_id: "S1", status: "settled", source: "aomi", online_order_id: null, local_order_no: null,
    total: 60, discount_amount: 0, refunded_amount: null, refund_records: null, payment_method: "外賣平台",
    service_charge_amount: 0, tax_amount: 0,
    items: [{ menuItemId: "m2", name: "凍檸茶", quantity: 2, price: 20 }], table_id: null, party_size: 1,
    settled_at: "2026-10-06T07:00:00+00:00", created_at: "2026-10-06T07:00:00+00:00", updated_at: "2026-10-06T07:00:00+00:00" },
  { id: "s5", store_id: "S1", status: "cancelled", source: "mfood", online_order_id: null, local_order_no: null,
    total: 65, discount_amount: 0, refunded_amount: null, refund_records: null, payment_method: "外賣平台",
    service_charge_amount: 0, tax_amount: 0,
    items: [{ menuItemId: "m4", name: "叉燒飯", quantity: 1, price: 38 }], table_id: null, party_size: 1,
    settled_at: null, created_at: "2026-10-06T08:00:00+00:00", updated_at: "2026-10-06T08:00:00+00:00" },
  { id: "s6", store_id: "S1", status: "refunded", source: null, online_order_id: null, local_order_no: "A-3",
    total: 40, discount_amount: 0, refunded_amount: 10, refund_records: [{ amount: 10 }], payment_method: "Mpay",
    service_charge_amount: 0, tax_amount: 0,
    items: [{ menuItemId: "m2", name: "凍檸茶", quantity: 2, price: 20 }], table_id: "T2", party_size: 2,
    settled_at: "2026-10-06T09:00:00+00:00", created_at: "2026-10-06T09:00:00+00:00", updated_at: "2026-10-06T09:00:00+00:00" },
  { id: "s7", store_id: "S1", status: "partially_refunded", source: null, online_order_id: null, local_order_no: "A-4",
    total: 70, discount_amount: 0, refunded_amount: 0, refund_records: null, payment_method: "Mpay",
    service_charge_amount: 0, tax_amount: 0,
    items: [{ menuItemId: "m1", name: "乾炒牛河", quantity: 1, price: 30 }], table_id: "T3", party_size: 1,
    settled_at: "2026-10-06T10:00:00+00:00", created_at: "2026-10-06T10:00:00+00:00", updated_at: "2026-10-06T10:00:00+00:00" },
  { id: "s8", store_id: "S1", status: "settled", source: null, online_order_id: null, local_order_no: "A-5",
    total: 33, discount_amount: 0, refunded_amount: null, refund_records: null, payment_method: "Mpay",
    service_charge_amount: 0, tax_amount: 0,
    items: [{ menuItemId: "m5", name: "已退菜", quantity: 1, price: 33, voided: "true" },
            { menuItemId: "m1", name: "乾炒牛河", quantity: 1, price: 30 }], table_id: "T1", party_size: 1,
    settled_at: "2026-10-07T02:00:00+00:00", created_at: "2026-10-07T02:00:00+00:00", updated_at: "2026-10-07T02:00:00+00:00" },
];

const COLS = ["id", "store_id", "status", "source", "online_order_id", "local_order_no", "total",
  "discount_amount", "refunded_amount", "refund_records", "payment_method", "service_charge_amount",
  "tax_amount", "items", "table_id", "party_size", "settled_at", "reopened_at", "updated_at", "created_at"];

const DDL = `
create table public.pos_orders (
  -- id 係 text，唔係 uuid：平台單 id 係 "aomi-<store>-TK..." 呢類字串
  id               text primary key,
  store_id         text,
  status           text,
  source           text,
  online_order_id  text,
  local_order_no   text,
  total            numeric,
  discount_amount  numeric,
  refunded_amount  numeric,
  refund_records   jsonb,
  payment_method   text,
  service_charge_amount numeric,
  tax_amount       numeric,
  items            jsonb,
  table_id         text,
  party_size       integer,
  settled_at       timestamptz,
  reopened_at      timestamptz,
  updated_at       timestamptz,
  created_at       timestamptz
);
`;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${String(label).padEnd(50)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

function req(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
      const cs = [];
      r.on("data", (c) => cs.push(c));
      r.on("end", () => {
        const buf = Buffer.concat(cs);
        res({ status: r.statusCode, body: buf.toString("utf8"), cr: r.headers["content-range"] || "" });
      });
    }).on("error", rej);
  });
}

async function fetchProdRows() {
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) {
    try {
      const r = await req(`https://macau-pos-system.vercel.app${p}`, {});
      (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch (e) { /* next */ }
  }
  let K = "";
  for (const s of chunks) {
    try {
      const r = await req(`https://macau-pos-system.vercel.app${s}`, {});
      const m = r.body.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g);
      if (m && m.length) { K = m[0]; break; }
    } catch (e) { /* next */ }
  }
  if (!K) return null;
  const H = { apikey: K, authorization: `Bearer ${K}`, prefer: "count=exact" };
  const rows = [];
  let claimed = -1;
  const STEP = 500;
  for (let off = 0; ; off += STEP) {
    const url = `${BASE}/pos_orders?select=${COLS.join(",")}&store_id=eq.${STORE}&order=id.asc`;
    const r = await req(url, { ...H, range: `${off}-${off + STEP - 1}` });
    if (r.status >= 400) return null;
    const part = JSON.parse(r.body);
    rows.push(...part);
    const mm = (r.cr || "").match(/\/(\d+)$/);
    if (mm) claimed = Number(mm[1]);
    if (part.length < STEP) break;
    if (claimed >= 0 && rows.length >= claimed) break;
  }
  // 🔴 冇抓齊就寧願降級，唔好對一份殘缺資料落結論
  if (claimed >= 0 && rows.length !== claimed) return null;
  return rows;
}

(async () => {
  let PGlite;
  try {
    PGlite = require("@electric-sql/pglite").PGlite;
  } catch (e) {
    console.log("SKIP：冇裝 @electric-sql/pglite。");
    console.log("安裝：cd <node workspace> && npm i @electric-sql/pglite");
    console.log("再跑：NODE_PATH=<node workspace>/node_modules node tools/verify-offline-report-rpc.cjs");
    process.exit(3);
  }

  const migRaw = fs.readFileSync(MIG, "utf8").replace(/\r\n/g, "\n");
  // 🔴 必須用「行首」配對：註解入面都有「create or replace function」呢幾個字
  const mStart = migRaw.match(/^create or replace function/m);
  if (!mStart) { console.log("搵唔到 create or replace function"); process.exit(1); }
  const fnSql = migRaw.slice(mStart.index, migRaw.indexOf("$$;", migRaw.indexOf("as $$", mStart.index)) + 3);

  let rows = await fetchProdRows().catch(() => null);
  const mode = rows ? "PRODUCTION" : "SYNTHETIC";
  if (!rows) { rows = SEED_ROWS; console.log("⚠️ 抓唔到生產資料，降級用合成種子（仍然捉到漏欄 bug）"); }
  console.log(`[mode] ${mode}　[rows] ${rows.length}　[range] ${FROM} → ${TO}\n`);

  const db = await new PGlite();
  await db.exec(DDL);

  try {
    await db.exec(fnSql);
    console.log("[1] create function OK");
  } catch (e) {
    console.log("[1] create function FAIL: " + e.message);
    process.exit(1);
  }

  const ph = COLS.map((_, i) => `$${i + 1}`).join(",");
  const insSql = `insert into public.pos_orders (${COLS.join(",")}) values (${ph})`;
  try {
    for (const r of rows) {
      await db.query(insSql, COLS.map((c) => {
        const v = r[c];
        if (v === undefined || v === null) return null;
        return typeof v === "object" ? JSON.stringify(v) : v;
      }));
    }
    console.log(`[2] seeded ${rows.length} 行`);
  } catch (e) {
    console.log("[2] seed FAIL: " + e.message);
    process.exit(1);
  }

  let obj;
  try {
    const res = await db.query("select public.pos_offline_report($1,$2,$3) as r", [rows[0].store_id, FROM, TO]);
    obj = res.rows[0].r;
    console.log("[3] 🔴 execute OK（呢步先至係真驗證）\n");
  } catch (e) {
    console.log("[3] 🔴🔴 execute FAIL >>> " + e.message);
    console.log("    ⇒ SQL Editor 會回 Success，但函數實際係壞嘅。呢個就係本工具存在嘅原因。");
    process.exit(1);
  }

  const sum = (a, f) => (a || []).reduce((s, x) => s + (f ? f(x) : x), 0);
  const d = obj.dishes || [];
  const dc = obj.dishesByChannel || [];
  const pb = obj.paymentBreakdown || [];
  const k = obj.kpiByChannel || {};
  const legacyNames = new Set(d.map((x) => x.name));

  if (mode === "PRODUCTION") {
    console.log("=== 對 production 基線（獨立取證探針定落）===");
    eq("orderCount（v1）", obj.orderCount, 74);
    eq("revenueAvos（v1）", obj.revenueAvos, 547100);
    eq("ordersTotal（v1）", obj.ordersTotal, 74);
    eq("ordersByChannelTotal", obj.ordersByChannelTotal, 93);
    eq("dishesTotal", obj.dishesTotal, 58);
    eq("dishes Σqty", sum(d, (x) => x.qty), 198);
    eq("dishes ΣrevenueAvos", sum(d, (x) => x.revenueAvos), 549900);
    eq("dishesByChannelTotal", obj.dishesByChannelTotal, 63);
    eq("dishesByChannel Σqty", sum(dc, (x) => x.qty), 225);
    eq("dishesByChannel ΣrevenueAvos", sum(dc, (x) => x.revenueAvos), 667600);
    eq("kpiByChannel.offline.orderCount", k.offline && k.offline.orderCount, 66);
    eq("kpiByChannel.offline.revenueAvos", k.offline && k.offline.revenueAvos, 477200);
    eq("kpiByChannel.online.orderCount", k.online && k.online.orderCount, 19);
    eq("kpiByChannel.online.revenueAvos", k.online && k.online.revenueAvos, 119700);
    eq("kpiByChannel.onlinePlatform.orderCount", k.onlinePlatform && k.onlinePlatform.orderCount, 8);
    eq("kpiByChannel.onlinePlatform.revenueAvos", k.onlinePlatform && k.onlinePlatform.revenueAvos, 69900);
    eq("Σ paymentBreakdown.paidAvos（全渠道）", sum(pb, (x) => x.paidAvos), 666800);
    eq("Σ paymentBreakdown.paidAvos（排除 online_projection）",
       sum(pb.filter((x) => x.channel !== "online_projection"), (x) => x.paidAvos), 547100);
  }

  console.log("=== 不變量（兩種 mode 都驗）===");
  eq("拆欄數量守恆（全部行）", dc.filter((x) => x.offlineQty + x.onlineQty === x.qty).length, dc.length);
  eq("拆欄金額守恆（全部行）",
     dc.filter((x) => x.offlineRevenueAvos + x.onlineRevenueAvos === x.revenueAvos).length, dc.length);
  eq("舊 dishes 每個名都喺 dishesByChannel（舊⊂新）",
     d.filter((x) => !dc.some((y) => y.name === x.name)).length, 0);
  eq("新多出嘅名全部 offlineQty=0", dc.filter((x) => !legacyNames.has(x.name) && x.offlineQty !== 0).length, 0);
  eq("新多出嘅名全部 offlineRevenueAvos=0",
     dc.filter((x) => !legacyNames.has(x.name) && x.offlineRevenueAvos !== 0).length, 0);
  eq("同名行 dishes.qty >= offlineQty",
     d.filter((x) => { const y = dc.find((z) => z.name === x.name); return y && x.qty < y.offlineQty; }).length, 0);
  eq("舊 dishes[] 嚴格三欄（冇拆欄污染）",
     d.filter((x) => Object.keys(x).sort().join(",") !== "name,qty,revenueAvos").length, 0);
  eq("orders[] 冇 online_projection",
     (obj.orders || []).filter((x) => x.channel === "online_projection").length, 0);
  eq("ordersByChannelTotal − ordersTotal = projection 數",
     obj.ordersByChannelTotal - obj.ordersTotal,
     (obj.ordersByChannel || []).filter((x) => x.channel === "online_projection").length);
  eq("ordersTotal === length(orders)", obj.ordersTotal, (obj.orders || []).length);
  eq("dishesTotal === length(dishes)", obj.dishesTotal, d.length);
  eq("六個新 key 全齊",
     ["kpiByChannel", "paymentBreakdown", "ordersByChannelTotal", "ordersByChannel",
      "dishesByChannelTotal", "dishesByChannel"].filter((x) => obj[x] === undefined).length, 0);

  console.log(`\n總計 ${pass + fail} 條，失敗 ${fail} 條`);
  process.exit(fail === 0 ? 0 : 1);
})();
