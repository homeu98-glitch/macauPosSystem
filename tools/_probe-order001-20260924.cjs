/**
 * 唯讀取證：2026-09-24「取餐號 001 / MOP 43」為何在訂單頁見到、報表與交班卻冇。
 * 由線上 bundle 抽 anon key（ref=iyrywzormzisyppkokbi）→ 直查 pos_orders（近 72h）。
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

const REF = "iyrywzormzisyppkokbi";
const H = `https://${REF}.supabase.co`;
const SITE = "https://macau-pos-system.vercel.app";
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

function jwtRef(tok) {
  try {
    const p = JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString("utf8"));
    return { ref: p.ref, role: p.role };
  } catch {
    return {};
  }
}

async function pickAnonKey() {
  const chunks = new Set();
  for (const p of ["/prints", "/pos", "/orders"]) {
    try {
      const r = await get(SITE + p);
      (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch {}
  }
  const score = [];
  for (const s of chunks) {
    try {
      const r = await get(SITE + s);
      const m = r.body.match(JWT);
      if (!m) continue;
      for (const tok of m) {
        const { ref, role } = jwtRef(tok);
        score.push({ chunk: s, ref, role, tok: tok.slice(0, 24) + "…", full: tok });
        if (ref === REF && role === "anon") return tok;
      }
    } catch {}
  }
  console.log("抽唔到 POS anon key，見過：");
  for (const s of score.slice(0, 20)) console.log(" ", s.ref, s.role, s.chunk);
  return null;
}

const mac = (s) => (s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19) : "-");

async function q(K, path) {
  const r = await get(`${H}/rest/v1/${path}`, { apikey: K, authorization: `Bearer ${K}` });
  return { status: r.status, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })(), raw: r.body };
}

(async () => {
  const K = await pickAnonKey();
  if (!K) process.exit(1);
  console.log("anon key OK (ref=%s)\n", REF);

  // 1) 近 72h 全部訂單（澳門 09-23 00:00 起）
  const cols = "id,local_order_no,status,total,online_order_id,external_order_id,source,created_at,updated_at,settled_at,reopen_count,table_name,payment_method";
  const since = "2026-09-23T00:00:00Z";
  let r = await q(K, `pos_orders?select=${cols}&or=(created_at.gte.${since},updated_at.gte.${since})&order=updated_at.desc&limit=200`);
  if (r.status !== 200) {
    console.log("查詢失敗，退回 select=*：", r.status, String(r.raw).slice(0, 200));
    r = await q(K, `pos_orders?select=*&created_at=gte.${since}&order=created_at.desc&limit=200`);
  }
  if (r.status !== 200) { console.log("仍然失敗", r.status, String(r.raw).slice(0, 300)); process.exit(1); }

  const rows = r.json || [];
  console.log("近 72h pos_orders 共 %d 張（按 updated_at desc）\n", rows.length);
  console.log("local_no | status | total | online_order_id | src | created | updated | settled | reopen | table");
  for (const o of rows) {
    console.log(
      [
        String(o.local_order_no ?? "-").padEnd(8),
        String(o.status ?? "-").padEnd(20),
        String(o.total ?? "-").padEnd(6),
        String(o.online_order_id ?? "-").slice(0, 18).padEnd(18),
        String(o.source ?? "-").padEnd(10),
        mac(o.created_at),
        mac(o.updated_at),
        mac(o.settled_at),
        String(o.reopen_count ?? "-").padEnd(3),
        String(o.table_name ?? "-"),
      ].join(" | ")
    );
  }

  // 2) 針對 001 / 43 元嘅單特別標記
  console.log("\n=== 命中「001」或 total=43 嘅單 ===");
  const hits = rows.filter(
    (o) => String(o.local_order_no ?? "").includes("001") || Number(o.total) === 43
  );
  if (!hits.length) console.log("（冇任何命中 —— 即係 001 完全唔喺雲端 pos_orders）");
  for (const o of hits) console.log(JSON.stringify(o, null, 2));
})();
