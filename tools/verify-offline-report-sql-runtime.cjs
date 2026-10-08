/**
 * 🔴🔴 本地真跑 `supabase/verify/0066_verify_production_20261007.sql` 全部語句。
 *
 * **點解需要呢支**：pglast 嗰類「語法檢查」捉唔到欄位／別名錯誤 ——
 * 2026-10-08 就係咁：`jsonb_array_elements(r -> 'ordersByChannel')` 漏咗 `as p`，
 * 語法 100% 正確，但要**執行**先爆 `42703: column "p" does not exist`。
 * 呢支嘢喺 PGlite 落真實 production 行，逐條執行驗收 SQL，任何一條爆即紅。
 *
 * 用法：
 *   NODE_PATH=<node workspace>/node_modules node tools/verify-offline-report-sql-runtime.cjs
 */
const https = require("node:https");
const fs = require("node:fs");

const REF = "iyrywzormzisyppkokbi";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const BASE = `https://${REF}.supabase.co/rest/v1`;
const MIG = "supabase/migrations/0066_pos_offline_report_channel.sql";
const VERIFY = "supabase/verify/0066_verify_production_20261007.sql";

const COLS = ["id", "store_id", "status", "source", "online_order_id", "local_order_no", "total",
  "discount_amount", "refunded_amount", "refund_records", "payment_method", "service_charge_amount",
  "tax_amount", "items", "table_id", "party_size", "settled_at", "reopened_at", "updated_at", "created_at"];

const DDL = `
create table public.pos_orders (
  id text primary key, store_id text, status text, source text, online_order_id text,
  local_order_no text, total numeric, discount_amount numeric, refunded_amount numeric,
  refund_records jsonb, payment_method text, service_charge_amount numeric, tax_amount numeric,
  items jsonb, table_id text, party_size integer,
  settled_at timestamptz, reopened_at timestamptz, updated_at timestamptz, created_at timestamptz
);
`;

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
  for (let off = 0; ; off += 500) {
    const url = `${BASE}/pos_orders?select=${COLS.join(",")}&store_id=eq.${STORE}&order=id.asc`;
    const r = await req(url, { ...H, range: `${off}-${off + 499}` });
    if (r.status >= 400) return null;
    const part = JSON.parse(r.body);
    rows.push(...part);
    const mm = (r.cr || "").match(/\/(\d+)$/);
    if (mm) claimed = Number(mm[1]);
    if (part.length < 500) break;
    if (claimed >= 0 && rows.length >= claimed) break;
  }
  if (claimed >= 0 && rows.length !== claimed) return null;
  return rows;
}

/** 剝 `--` 註解（只剝成行註解；本檔冇行內字串含 `--`）→ 用 `;` 切語句。 */
function splitStatements(sql) {
  const noComments = sql
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
  return noComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

(async () => {
  let PGlite;
  try {
    PGlite = require("@electric-sql/pglite").PGlite;
  } catch (e) {
    console.log("SKIP：冇裝 @electric-sql/pglite。");
    console.log("安裝：cd <node workspace> && npm i @electric-sql/pglite");
    process.exit(3);
  }

  const rows = await fetchProdRows().catch(() => null);
  if (!rows) { console.log("抓唔到生產資料 ⇒ 放棄（唔可以對殘缺資料落結論）"); process.exit(1); }

  const db = await new PGlite();
  await db.exec(DDL);

  const migRaw = fs.readFileSync(MIG, "utf8").replace(/\r\n/g, "\n");
  const mStart = migRaw.match(/^create or replace function/m);
  await db.exec(migRaw.slice(mStart.index, migRaw.indexOf("$$;", migRaw.indexOf("as $$", mStart.index)) + 3));

  const ph = COLS.map((_, i) => `$${i + 1}`).join(",");
  for (const r of rows) {
    await db.query(`insert into public.pos_orders (${COLS.join(",")}) values (${ph})`,
      COLS.map((c) => {
        const v = r[c];
        if (v === undefined || v === null) return null;
        return typeof v === "object" ? JSON.stringify(v) : v;
      }));
  }
  console.log(`[seed] ${rows.length} 行（production）\n`);

  const stmts = splitStatements(fs.readFileSync(VERIFY, "utf8"));
  console.log(`=== 驗收 SQL 共 ${stmts.length} 條語句，逐條執行 ===\n`);

  let bad = 0;
  let skipped = 0;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    // 🔴 `set role` / `reset role` 係 session 指令，PGlite 冇 `anon` 呢個 role
    //    ⇒ 本地唔驗（呢條要喺 Supabase 用 service role 跑先有意義），標 SKIP 唔當 fail。
    if (/^\s*(set\s+role|reset\s+role)\b/i.test(s)) {
      skipped++;
      console.log(`  SKIP [${i + 1}] ${s.split("\n")[0]}（本地冇該 role，要喺 Supabase 驗）`);
      continue;
    }
    try {
      const res = await db.query(s);
      const r = res.rows || [];
      const flat = r.length === 1 ? r[0] : r;
      console.log(`  OK   [${i + 1}] ${JSON.stringify(flat)}`);
    } catch (e) {
      bad++;
      console.log(`  FAIL [${i + 1}] ${e.message}`);
      console.log(`       ${s.split("\n")[0].slice(0, 120)}`);
    }
  }

  console.log(`\n總計 ${stmts.length} 條，執行失敗 ${bad} 條，本地跳過 ${skipped} 條（set role）`);
  process.exit(bad === 0 ? 0 : 1);
})();
