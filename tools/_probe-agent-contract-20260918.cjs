/**
 * 驗商戶 App 交接單「§3 不要改的契約」（唯讀，2026-09-18）。
 *
 * §3 契約：
 *   · claim / heartbeat / result 繼續只驗 agent（唔需要 POS 登入 Bearer）
 *   · 中繼唔可以變成必須 POS 登入 Bearer
 *   · /pair 自動配對（未有配對碼）
 *
 * 驗法：用**無效** agent 憑證打三條端點 + /pair。
 *   · 若回 401（憑證錯）而**唔係** 403「需要登入」⇒ 證明佢係認 agent 憑證，
 *     冇偷偷改成要 POS Bearer。
 *   · 若回 200/400 等非 401 ⇒ 要細看（可能係端點本身設計）。
 * 全部唯讀：帶假 token，唔會寫任何嘢（verifyAgent 必失敗 ⇒ 唔會落 DB）。
 */

const BASE = process.argv[2] || "https://macau-pos-system.vercel.app";
const FAKE_ID = "ag-00000000000000000000000000000000";
const FAKE_TOKEN = "invalid-probe-token-0000000000000000000000000000";

async function probe(label, method, path, init = {}) {
  const url = BASE + path;
  try {
    const res = await fetch(url, { method, ...init, redirect: "manual" });
    let body = "";
    try {
      body = (await res.text()).slice(0, 240).replace(/\s+/g, " ");
    } catch {
      body = "(無法讀取)";
    }
    console.log(`\n── ${label}`);
    console.log(`   ${method} ${path}  →  HTTP ${res.status}`);
    console.log(`   ${body}`);
    return res.status;
  } catch (e) {
    console.log(`\n── ${label}\n   → 網絡錯誤: ${e.message}`);
    return null;
  }
}

(async () => {
  console.log("═".repeat(72));
  console.log("§3 契約驗證：claim / heartbeat / result / pair 只認 agent 憑證");
  console.log("BASE =", BASE);
  console.log("═".repeat(72));

  const h = { "content-type": "application/json", "x-agent-id": FAKE_ID, "x-agent-token": FAKE_TOKEN };

  // claim：只認 agent（有 agent header 但 token 錯 ⇒ 應該 401，唔應該要 Bearer）
  await probe("claim（假憑證）", "POST", "/api/pos/print-agent/claim", { headers: h, body: "{}" });
  // claim：完全匿匵 ⇒ 401（agent 驗證失敗），唔應該係「需要 POS 登入」
  await probe("claim（匿匵）", "POST", "/api/pos/print-agent/claim", {
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  await probe("heartbeat（假憑證）", "POST", "/api/pos/print-agent/heartbeat", { headers: h, body: "{}" });
  await probe("result（假憑證）", "POST", "/api/pos/print-agent/result", { headers: h, body: "{}" });

  // /pair：自動配對通道，唔應該被本次 Auth 改動影響
  await probe("GET /pair（真 agentId 格式，未配對）", "GET", `/api/pos/print-agent/pair?agentId=${FAKE_ID}`);
  await probe("GET /pair（冇 agentId）", "GET", "/api/pos/print-agent/pair");

  // pair-status：POS「打印中心」banner 用
  await probe("GET /pair-status（假 storeId）", "GET", `/api/pos/print-agent/pair-status?storeId=${FAKE_ID}`);

  console.log("\n" + "═".repeat(72));
  console.log("判讀：");
  console.log("  claim/heartbeat/result 假憑證回 401 ⇒ ✅ 契約不變（只認 agent，冇改要 POS Bearer）");
  console.log("  若回 403 / 「請先登入」 ⇒ ❌ 端點被誤加 POS 登入要求，要查。");
  console.log("═".repeat(72));
})();
