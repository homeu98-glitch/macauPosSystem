/**
 * 唯讀探測 v4（2026-09-29）：PostgREST root OpenAPI —— anon 角色睇得到嘅表清單。
 * 目的：回答「grabber 端完全冇 trace」嘅追蹤環節 —— 究竟生產 DB 有冇任何
 *       推送／稽核／queue 表可以事後查到「邊張單幾時被推過」。
 */
const https = require("node:https");

function req(url, opts) {
  return new Promise((res, rej) => {
    const r = https.request(url, { ...opts }, (resp) => {
      let d = "";
      resp.on("data", (c) => (d += c));
      resp.on("end", () => res({ status: resp.statusCode, headers: resp.headers, body: d }));
    });
    r.on("error", rej);
    r.end();
  });
}
const get = (url, headers) =>
  req(url, { method: "GET", headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } });

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
        for (const tok of m) {
          try {
            const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString());
            if (payload && payload.ref === REF) {
              K = tok;
              break;
            }
          } catch {}
        }
      }
      if (K) break;
    } catch {}
  }

  const base = `https://${REF}.supabase.co/rest/v1/`;
  const auth = { apikey: K, authorization: `Bearer ${K}` };

  const spec = await get(base, auth);
  let j = null;
  try {
    j = JSON.parse(spec.body);
  } catch {}
  if (!j || !j.paths) {
    console.log("無法取得 OpenAPI：", spec.status, spec.body.slice(0, 300));
    return;
  }
  const paths = Object.keys(j.paths).filter((p) => p !== "/" && p !== "/rpc");
  paths.sort();
  console.log(`anon 可見 endpoint 數 = ${paths.length}\n`);
  const interesting = /audit|log|event|queue|push|grabber|integration|sync|import|raw|inbound|settlement/i;
  console.log("── 疑似的追蹤／稽核相關表 ──");
  const hit = paths.filter((p) => interesting.test(p));
  hit.forEach((p) => console.log("   " + p));
  console.log(`   (命中 ${hit.length} 條)`);
  console.log("\n── 全部列表 ──");
  paths.forEach((p) => console.log("   " + p));
})();
