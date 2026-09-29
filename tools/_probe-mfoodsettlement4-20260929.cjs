/**
 * 唯讀探測 v4（2026-09-29）：用 PostgREST OpenAPI 列出生產實際可見嘅表，
 * 確認 pos_platform_settlements 係「未建」定「schema cache 未 refresh」。
 */
const https = require("node:https");

function req(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, headers: r.headers, body: d }));
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
      const r = await req(SITE + p);
      (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch {}
  }
  let K = "";
  for (const s of chunks) {
    try {
      const r = await req(SITE + s);
      const m = r.body.match(JWT);
      if (m) for (const tok of m) {
        try {
          if (JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString()).ref === REF) { K = tok; break; }
        } catch {}
      }
      if (K) break;
    } catch {}
  }

  const r = await req(`https://${REF}.supabase.co/rest/v1/`, {
    apikey: K,
    authorization: `Bearer ${K}`,
    accept: "application/openapi+json",
  });
  console.log("status =", r.status, "content-type =", r.headers["content-type"]);
  try {
    const j = JSON.parse(r.body);
    const names = Object.keys(j.paths || {}).map((p) => p.replace(/^\//, ""));
    console.log("表數目 =", names.length);
    console.log("含 settlement/platform 嘅表:", names.filter((n) => /platform|settle/i.test(n)).join(", ") || "(冇)");
    console.log("全部表:");
    console.log(names.sort().join("\n"));
  } catch (e) {
    console.log("parse fail:", r.body.slice(0, 300));
  }
})();
