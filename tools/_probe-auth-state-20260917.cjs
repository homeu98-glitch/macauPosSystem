/**
 * 生產環境鑑權探測（唯讀）。
 *
 * 目的：回答一個問題 —— 「而家 `POS_REQUIRE_DEVICE_AUTH` 係開定關？」
 *
 * 判準（`pos-route-auth.ts:57-66` / `pos/state/route.ts:38-51`）：
 *   auth 關（= 0）→ `authorized` 恆真 → **零憑證都回 200**（要求帶 storeId）
 *   auth 開（= 1 或未設）→ 零憑證 → **401**
 *
 * 全部係 GET / 無副作用請求，唔會改任何嘢。
 */

const BASE = process.argv[2] || "https://macau-pos-system.vercel.app";

async function probe(label, path, init) {
  const url = BASE + path;
  try {
    const res = await fetch(url, { ...init, redirect: "manual" });
    let body = "";
    try {
      body = (await res.text()).slice(0, 220).replace(/\s+/g, " ");
    } catch {
      body = "(無法讀取 body)";
    }
    console.log(`\n── ${label}`);
    console.log(`   ${init?.method || "GET"} ${path}`);
    console.log(`   → HTTP ${res.status}`);
    console.log(`   → ${body}`);
    return res.status;
  } catch (e) {
    console.log(`\n── ${label}`);
    console.log(`   ${init?.method || "GET"} ${path}`);
    console.log(`   → 網絡錯誤: ${e.message}`);
    return null;
  }
}

(async () => {
  console.log("═".repeat(70));
  console.log("生產環境鑑權探測");
  console.log("BASE =", BASE);
  console.log("═".repeat(70));

  // ── 0. 部署有冇反應（對照組）──
  await probe("0. 部署可達性（對照）", "/manifest.webmanifest");

  // ── 1. 🔴 核心：鑑權閘而家開定關？──
  //    匿名、零憑證、帶 storeId。auth 關 → 200；auth 開 → 401。
  const fakeStore = "00000000-0000-0000-0000-000000000000";
  const stateStatus = await probe(
    "1. 鑑權閘狀態（匿名零憑證打 state）",
    `/api/pos/state?storeId=${fakeStore}&limit=1`,
  );

  // ── 2. 其他曾被點名嘅端點（同樣匿名零憑證）──
  await probe("2a. device-config（匿名）", `/api/pos/device-config?storeId=${fakeStore}`);
  await probe("2b. print-jobs/status（匿名）", `/api/pos/print-jobs/status?storeId=${fakeStore}`);
  await probe("2c. orders（匿名）", `/api/pos/orders?storeId=${fakeStore}`);

  // ── 3. 缺 storeId 應該 400（另一道閘，唔關 auth 事）──
  await probe("3. state 缺 storeId（應 400）", "/api/pos/state");

  // ── 4. device-token 簽發能力（假 token）──
  //    400 = 缺 accessToken（路由通）
  //    503「Ledger 未配置」= Ledger env 缺
  //    401「會話失效」= Ledger env 通、路由正常（假 token 預期結果）
  await probe("4. device-token 簽發（假 token）", "/api/pos/device-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: "dummy.invalid.token", refreshToken: "dummy" }),
  });

  // ── 5. 缺 accessToken 應該 400 ──
  await probe("5. device-token 缺 accessToken（應 400）", "/api/pos/device-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  console.log("\n" + "═".repeat(70));
  console.log("判讀：");
  console.log("  第 1 項回 200  ⇒ 鑑權閘**關閉中**（POS_REQUIRE_DEVICE_AUTH=0）");
  console.log("  第 1 項回 401  ⇒ 鑑權閘**已開** ⇒ 可以做帳號級角色");
  console.log("  第 2 項同樣係旁證（曾實測全回 200）");
  console.log("═".repeat(70));
})();
