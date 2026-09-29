/**
 * 唯讀探測 v5（2026-09-29）：線上 bundle 入面有邊幾個 Supabase 專案 ref？
 * 目的：確認 settlement route（server 端）同我探測嘅係同一個專案。
 */
const https = require("node:https");

function req(url, headers) {
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

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/pos", "/orders"]) {
    try {
      const r = await req(SITE + p);
      (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch {}
  }
  console.log("chunk 數 =", chunks.size);
  const refs = new Map();
  for (const s of chunks) {
    try {
      const r = await req(SITE + s);
      const m = r.body.match(JWT) || [];
      for (const tok of m) {
        try {
          const pl = JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString());
          if (pl && pl.ref) refs.set(pl.ref, (refs.get(pl.ref) || 0) + 1);
        } catch {}
      }
    } catch {}
  }
  console.log("bundle 內嘅 supabase ref：");
  for (const [ref, n] of refs) console.log("  ", ref, "×", n);
})();
