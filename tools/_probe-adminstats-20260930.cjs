/**
 * 唯讀覆核（2026-09-30）：`/api/admin/merchants` 改口徑之後，店鋪總覽「今日」會係幾多。
 *
 * 呢個腳本**照抄** route 改動後嘅邏輯（`loadPosStats()`）：
 *   · 拉近 7 日窗口（超集）
 *   · status ∈ {settled, paid}
 *   · 日歸屬 = orderEventInstant()（settled_at → reopened_at → updated_at → created_at）
 * 同時跑一次**舊邏輯**（日歸屬 = created_at）做對照，證明改動前後嘅差異。
 *
 * ⚠️ anon 讀 `pos_orders` 有 ~72h 時間窗 RLS ⇒ d7 覆蓋唔齊（只作參考），
 *    但 `today` 完整，正是本次事故嘅判別點。
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
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";

/** 澳門 2026-09-30 00:00 = UTC 09-29T16:00Z。 */
const TODAY_START = "2026-09-29T16:00:00Z";
/** 澳門 2026-09-23 00:00（7 日前）—— 作 7 日窗口起點。 */
const D7_START = "2026-09-22T16:00:00Z";

const mac = (s) =>
  s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19).replace("T", " ") : "-";
const countable = (o) => o.status === "settled" || o.status === "paid";

/** 改動後 route 用嘅口徑（同 src/lib/pos/order-event-time.ts 逐字對齊）。 */
function eventInstant(o) {
  return o.settled_at || o.reopened_at || o.updated_at || o.created_at || "";
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
      if (m && m.length) {
        K = m[0];
        break;
      }
    } catch {}
  }
  const H = { apikey: K, authorization: `Bearer ${K}` };

  const url =
    `https://${REF}.supabase.co/rest/v1/pos_orders` +
    `?select=id,local_order_no,status,total,created_at,updated_at,reopened_at,settled_at,source` +
    `&or=(created_at.gte.${D7_START},updated_at.gte.${D7_START})` +
    `&order=created_at.asc&limit=1000`;
  const r = await get(url, H);
  if (r.status >= 400) {
    console.log("❌", r.status, r.body.slice(0, 300));
    return;
  }
  const rows = JSON.parse(r.body).filter(countable);
  console.log(`可計銷售單共 ${rows.length} 張（受 anon 72h 窗限制，非完整 7 日）\n`);

  const todayStartMs = Date.parse(TODAY_START);
  const d7StartMs = Date.parse(D7_START);

  const bucket = (predicate) => {
    const today = new Map();
    const d7 = new Map();
    for (const o of rows) {
      const ms = predicate(o);
      if (!(ms > 0)) continue;
      const key = o.source || "pos";
      const add = (map) => {
        const cur = map.get(key) || { n: 0, amt: 0 };
        cur.n += 1;
        cur.amt += Number(o.total || 0);
        map.set(key, cur);
      };
      if (ms >= d7StartMs) add(d7);
      if (ms >= todayStartMs) add(today);
    }
    return { today, d7 };
  };

  const NEW = bucket((o) => Date.parse(eventInstant(o)) || 0);
  const OLD = bucket((o) => Date.parse(o.created_at) || 0);

  const sum = (map) => {
    let n = 0;
    let amt = 0;
    for (const v of map.values()) {
      n += v.n;
      amt += v.amt;
    }
    return { n, amt };
  };

  const show = (label, set) => {
    const t = sum(set.today);
    const w = sum(set.d7);
    console.log(`【${label}】`);
    console.log(`  今日   ${t.n} 單 / MOP ${t.amt.toFixed(2)}`);
    console.log(`  近7日  ${w.n} 單 / MOP ${w.amt.toFixed(2)}`);
    console.log(`  今日逐來源：`);
    for (const [k, v] of [...set.today].sort()) {
      console.log(`    ${String(k).padEnd(8)} ${String(v.n).padStart(3)} 單 / MOP ${v.amt.toFixed(2)}`);
    }
    console.log("");
  };

  show("改動後 · orderEventInstant（新）", NEW);
  show("改動前 · created_at（舊）", OLD);

  console.log("=== 差異（舊有 · 新冇 ＝ 被修正嘅跨日單）===");
  const newTodayIds = new Set(
    rows.filter((o) => Date.parse(eventInstant(o)) >= todayStartMs).map((o) => o.id),
  );
  for (const o of rows) {
    if (Date.parse(o.created_at) >= todayStartMs && !newTodayIds.has(o.id)) {
      console.log(
        `  ${String(o.local_order_no).padEnd(12)} ${o.source}  MOP ${o.total}` +
          `  created=${mac(o.created_at)}  settled=${mac(o.settled_at)}  updated=${mac(o.updated_at)}`,
      );
    }
  }
})();
