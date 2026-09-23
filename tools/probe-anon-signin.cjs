/**
 * `tools/probe-anon-signin.cjs` —— 驗證 POS 專案嘅 **Anonymous Sign-In 真係開咗**。
 *
 * ## 為何要真打一次
 * `GET /auth/v1/settings` **唔會**回 `anonymous_users` 欄（實測），
 * 所以由設定端點判斷唔到。唯一可靠方法就係真正 call 一次匿名註冊：
 *   · 成功（回 session）→ 開咗 ✅
 *   · `422 Anonymous sign-ins are disabled` → 未開
 *
 * ## ⚠️ 副作用（唔可以唔講）
 * 呢個腳本會喺 `auth.users` **建立一個匿名用戶**（冇 store claim ⇒ 讀唔到任何業務資料；
 * 佢就係 POS 終端日後會用嘅同一種身份）。
 * 想清理：Supabase Dashboard → Authentication → Users → 刪嗰個 `anonymous` 用戶。
 *
 * 用法：node tools/probe-anon-signin.cjs
 */
const https = require("node:https");

function req(method, url, headers, body) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const r = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      (x) => {
        let d = "";
        x.on("data", (c) => (d += c));
        x.on("end", () => res({ status: x.statusCode, body: d }));
      },
    );
    r.on("error", rej);
    if (body) r.write(body);
    r.end();
  });
}

function get(url) {
  return new Promise((res, rej) => {
    https
      .get(url, { headers: { "user-agent": "Mozilla/5.0" } }, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => res(d));
      })
      .on("error", rej);
  });
}

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/", "/pos", "/orders", "/login"]) {
    try {
      const b = await get(base + p);
      (b.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch { /* 忽略 */ }
  }
  let anonKey = null;
  for (const s of chunks) {
    try {
      const b = await get(base + s);
      const m = b.match(JWT);
      if (m && m.length) {
        anonKey = m[0];
        break;
      }
    } catch { /* 忽略 */ }
  }
  if (!anonKey) {
    console.log("🔴 抽唔到 anon key，請手動傳入：node tools/probe-anon-signin.cjs <anonKey>");
    return;
  }
  console.log("anon key:", anonKey.slice(0, 20) + "…(" + anonKey.length + ")");

  const HOST = "https://iyrywzormzisyppkokbi.supabase.co";
  const r = await req(
    "POST",
    `${HOST}/auth/v1/signup`,
    {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      "content-type": "application/json",
      "user-agent": "macaupos-probe",
    },
    "{}",
  );

  console.log("\nPOST /auth/v1/signup（匿名）→", r.status);
  let j = null;
  try {
    j = JSON.parse(r.body);
  } catch { /* 唔係 JSON */ }

  if (r.status === 200 && j?.access_token) {
    console.log("✅ Anonymous Sign-In 已開啟（回咗 session）");
    console.log("   用戶 id:", String(j.user?.id ?? "?").slice(0, 8) + "…");
    console.log("   is_anonymous:", j.user?.is_anonymous);
    console.log("   role:", j.user?.role);
    // 淨係睇 claim 有冇 store_id（應該冇 —— 未綁店）
    const payload = j.access_token.split(".")[1];
    let claims = null;
    try {
      claims = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    } catch { /* 忽略 */ }
    console.log("   app_metadata:", JSON.stringify(claims?.app_metadata ?? null));
    console.log("   → 未有 store_id 係正常（要經 /api/pos/realtime-bind 綁）");
    console.log("\n⚠️ 今次建立咗一個匿名用戶；要清理就去 Dashboard → Authentication → Users 刪佢。");
    return;
  }

  const msg = String(j?.msg ?? j?.error_description ?? j?.message ?? r.body ?? "");
  if (/anonymous.*disabled/i.test(msg)) {
    console.log("🔴 未開啟：", msg);
    console.log("   → Dashboard → Authentication → Sign In / Providers → Anonymous Sign-Ins");
  } else {
    console.log("回應：", msg.slice(0, 300));
  }
})();
