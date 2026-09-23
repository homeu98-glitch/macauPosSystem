/**
 * `tools/probe-auth-settings.cjs` —— 唯讀探測 POS 專案嘅 Supabase Auth 設定。
 *
 * 用途：確認 **Anonymous sign-ins 有冇開啟**（per-store token 第 2 階段嘅前置條件），
 * 以及睇下有冇其他會影響 RLS 嘅 auth 設定。
 *
 * 只讀 `/auth/v1/settings`（GoTrue 嘅公開設定端點），**唔會建立任何用戶**。
 *
 * 用法：node tools/probe-auth-settings.cjs
 */
const https = require("node:https");

function get(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    }).on("error", rej);
  });
}

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/", "/pos", "/orders", "/login"]) {
    try {
      const r = await get(base + p, { "user-agent": "Mozilla/5.0" });
      (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch { /* 忽略 */ }
  }

  let anonKey = process.argv[2] || null;
  const hosts = new Set();
  for (const s of chunks) {
    try {
      const r = await get(base + s, { "user-agent": "Mozilla/5.0" });
      if (!anonKey) {
        const m = r.body.match(JWT);
        if (m && m.length) anonKey = m[0];
      }
      (r.body.match(/https:\/\/[a-z0-9]{15,}\.supabase\.co/g) || []).forEach((h) => hosts.add(h));
    } catch { /* 忽略 */ }
  }
  if (!anonKey) {
    console.log("🔴 抽唔到 anon key —— 可以手動傳入：node tools/probe-auth-settings.cjs <anonKey>");
    return;
  }
  console.log("anon key:", anonKey.slice(0, 20) + "…(" + anonKey.length + ")");
  console.log("候選 host:", [...hosts].join(", ") || "(冇抽到，試 POS 專案預設)");

  const HOST = "https://iyrywzormzisyppkokbi.supabase.co";
  const r = await get(`${HOST}/auth/v1/settings`, {
    apikey: anonKey,
    authorization: `Bearer ${anonKey}`,
    "user-agent": "Mozilla/5.0",
  });
  console.log("\nGET /auth/v1/settings →", r.status);
  try {
    const j = JSON.parse(r.body);
    const interesting = [
      "disable_signup",
      "mailer_autoconfirm",
      "phone_autoconfirm",
      "anonymous_users",
      "saml_enabled",
      "external_email_enabled",
      "external_phone_enabled",
    ];
    console.log("--- 關鍵設定 ---");
    for (const k of interesting) {
      if (k in j) console.log("  " + k.padEnd(26), j[k]);
    }
    const ext = j.external || {};
    const enabled = Object.entries(ext).filter(([, v]) => v === true).map(([k]) => k);
    console.log("  已啟用嘅外部供應商：", enabled.length ? enabled.join(", ") : "(冇)");
    if (!("anonymous_users" in j)) {
      console.log("\n⚠️ 呢個回應冇 `anonymous_users` 欄 —— 唔可以由此斷定有冇開；");
      console.log("   要確認就要真正 call 一次 signInAnonymously（會建立一個用戶）。");
    }
  } catch {
    console.log("回應原文:", r.body.slice(0, 400));
  }
})();
