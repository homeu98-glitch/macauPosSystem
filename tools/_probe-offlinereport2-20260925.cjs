/**
 * 唯讀探測 v2（2026-09-25）：為契約「驗收清單」出一份可直接對數嘅底稿。
 *
 * 口徑（＝交付時要同 POS `/reports` 夾埋嘅嗰套）：
 *   · 計入 status ∈ {settled, paid}；refunded / partially_refunded 整張剔除
 *   · 排除 online_order_id 非空（線上投影單）
 *   · 日歸屬 = coalesce(settled_at, reopened_at, updated_at, created_at) 轉 Asia/Macau
 *   · 只讀
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

function macauDayKey(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "(bad)";
  const d = new Date(t + 8 * 3600_000);
  return d.toISOString().slice(0, 10);
}

function eventInstant(o) {
  for (const raw of [o.settled_at, o.reopened_at, o.updated_at, o.created_at]) {
    if (typeof raw === "string" && raw.trim() && raw !== "0") {
      const t = Date.parse(raw);
      if (Number.isFinite(t) && t > 0) return t;
    }
  }
  return 0;
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
  const q = async (path) => {
    const r = await get(`https://${REF}.supabase.co/rest/v1/${path}`, {
      apikey: K,
      authorization: `Bearer ${K}`,
    });
    try {
      return JSON.parse(r.body);
    } catch {
      return null;
    }
  };

  const SEL =
    "id,local_order_no,store_id,status,total,online_order_id,payment_method,table_id,party_size,settled_at,reopened_at,updated_at,created_at,discount_amount,refunded_amount";
  const rows = await q(`pos_orders?select=${SEL}&order=updated_at.desc&limit=300`);
  if (!Array.isArray(rows)) {
    console.log("查詢失敗", String(rows).slice(0, 300));
    return;
  }
  console.log(`anon 可見 pos_orders ${rows.length} 行（72h 窗 + limit 300）\n`);

  const stores = [...new Set(rows.map((r) => r.store_id))];
  const methods = {};
  for (const store of stores) {
    const mine = rows.filter((r) => r.store_id === store);
    console.log(`════ store_id = ${store}（${mine.length} 行）════`);
    const byDay = {};
    for (const o of mine) {
      const t = eventInstant(o);
      const day = t ? macauDayKey(new Date(t).toISOString()) : "(no-time)";
      const b = (byDay[day] = byDay[day] || {
        all: { n: 0, sum: 0 },
        offline: { n: 0, sum: 0 },
        online: { n: 0, sum: 0 },
        methods: {},
        statuses: {},
        coversFootfall: 0,
      });
      const amount = Number(o.total ?? 0);
      const countable = o.status === "settled" || o.status === "paid";
      b.statuses[o.status] = (b.statuses[o.status] || 0) + 1;
      if (!countable) continue;
      b.all.n += 1;
      b.all.sum += amount;
      if (o.online_order_id) {
        b.online.n += 1;
        b.online.sum += amount;
      } else {
        b.offline.n += 1;
        b.offline.sum += amount;
        const m = o.payment_method ?? "未記錄";
        b.methods[m] = (b.methods[m] || 0) + amount;
        methods[m] = (methods[m] || 0) + amount;
        b.coversFootfall += o.table_id === "counter" ? 1 : Math.max(1, o.party_size ?? 1);
      }
    }
    for (const day of Object.keys(byDay).sort().reverse()) {
      const b = byDay[day];
      console.log(`  【${day}】status: ${JSON.stringify(b.statuses)}`);
      console.log(
        `      全部 settled|paid : ${b.all.n} 張 / ${b.all.sum.toFixed(2)} MOP`,
      );
      if (b.online.n) {
        console.log(`      其中線上投影單    : ${b.online.n} 張 / ${b.online.sum.toFixed(2)} MOP ← 契約要求排除`);
      }
      console.log(
        `      ★ 線下（契約口徑）  : ${b.offline.n} 張 / ${b.offline.sum.toFixed(2)} MOP = ${Math.round(b.offline.sum * 100)} avos，covers=${b.coversFootfall}`,
      );
      console.log(`      byPayment: ${JSON.stringify(b.methods)}`);
    }
    console.log("");
  }

  console.log("=== 全窗 payment_method 值域（Ledger 要顯示，唔可以自己發明） ===");
  Object.entries(methods).forEach(([m, v]) => console.log(`  "${m}"  Σ ${v.toFixed(2)} MOP`));
})();
