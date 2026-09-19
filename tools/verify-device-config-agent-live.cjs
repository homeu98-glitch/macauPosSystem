/**
 * 用「真實 agent 憑證」驗 device-config 的 agent 通道（2026-09-18）。
 *
 * 執行前先設兩個環境變數（唔落 shell history 會更好，見下）：
 *   RELAY_AGENT_ID=ag-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   RELAY_AGENT_TOKEN=<明文 token>
 *
 * 例（Git Bash，用 read 讀入，唔會入 history）：
 *   read -r -p "agentId: " RELAY_AGENT_ID
 *   read -rs -p "token  : " RELAY_AGENT_TOKEN; echo
 *   export RELAY_AGENT_ID RELAY_AGENT_TOKEN
 *   node tools/verify-device-config-agent-live.cjs
 *
 * 驗四項（brief §2 表格）：
 *   R1 匿名 + storeId            → 401
 *   R2 本店真 agent              → 200 且 deviceConfig.printers 有內容
 *   R3 甲店 agent 打乙店 storeId → 401
 *   R4 撤銷後（revoked）agent    → 401     ← 需另跑，見尾註
 *
 * 全部唯讀 GET，唔會改任何嘢。
 */

const BASE = process.argv[2] || "https://macau-pos-system.vercel.app";

const AGENT_ID = process.env.RELAY_AGENT_ID?.trim();
const AGENT_TOKEN = process.env.RELAY_AGENT_TOKEN?.trim();

const FAKE_STORE = "00000000-0000-0000-0000-000000000000";

async function probe(label, path, headers) {
  try {
    const res = await fetch(BASE + path, { headers, redirect: "manual" });
    const txt = await res.text();
    let json = null;
    try {
      json = JSON.parse(txt);
    } catch {
      /* not json */
    }
    console.log(`\n── ${label}`);
    console.log(`   GET ${path}`);
    console.log(`   → HTTP ${res.status}`);
    if (json) {
      const printers = json?.deviceConfig?.printers;
      const summary = {
        ok: json.ok,
        error: json.error,
        deviceConfig: json.deviceConfig
          ? {
              terminalName: json.deviceConfig.terminalName,
              storeId: json.deviceConfig.storeId,
              printersCount: Array.isArray(printers) ? printers.length : null,
              printers: Array.isArray(printers)
                ? printers.map((p) => ({ name: p?.name, ip: p?.ip, port: p?.port, group: p?.group }))
                : undefined,
            }
          : null,
        localSettings: json.localSettings,
      };
      console.log("   → " + JSON.stringify(summary));
    } else {
      console.log("   → " + txt.slice(0, 240).replace(/\s+/g, " "));
    }
    return { status: res.status, json };
  } catch (e) {
    console.log(`\n── ${label}\n   → 網絡錯誤: ${e.message}`);
    return { status: null, json: null };
  }
}

(async () => {
  console.log("═".repeat(72));
  console.log("device-config agent 通道實證（用真憑證）");
  console.log("BASE =", BASE);
  console.log("═".repeat(72));

  if (!AGENT_ID || !AGENT_TOKEN) {
    console.log("\n❌ 缺 RELAY_AGENT_ID / RELAY_AGENT_TOKEN 環境變數。");
    console.log("   （請照檔頭註解用 read 讀入，避免落入 shell history）");
    return;
  }
  console.log(`agentId = ${AGENT_ID.slice(0, 10)}…${AGENT_ID.slice(-4)}  (len=${AGENT_ID.length})`);
  console.log(`token   = ${"*".repeat(Math.min(AGENT_TOKEN.length, 8))}…(len=${AGENT_TOKEN.length})`);

  const agentHeaders = { "x-agent-id": AGENT_ID, "x-agent-token": AGENT_TOKEN };

  // R1 匿名 + storeId
  await probe("R1 匿名零憑證 + storeId（期望 401）", `/api/pos/device-config?storeId=${FAKE_STORE}`, {});

  // R2 先探自己店：用 agent header 打「真 storeId」。但我們未知真 storeId，
  //    所以先用「亂造 storeId + 真憑證」→ 應該 401（證明綁店檢查生效）；
  //    再用「真憑證 + 正確 storeId」→ 200。正確 storeId 由 /pair 或環境變數提供。
  const SELF_STORE = process.env.RELAY_STORE_ID?.trim();
  if (SELF_STORE) {
    const r2 = await probe(
      "R2 本店真 agent + 本店 storeId（期望 200 且 printers 有內容）",
      `/api/pos/device-config?storeId=${SELF_STORE}`,
      agentHeaders,
    );
    if (r2.status === 200) {
      const n = r2.json?.deviceConfig?.printers?.length ?? 0;
      console.log(`   ✅ R2 通過（printers=${n}）` + (n === 0 ? "  ⚠️ 但 printers 為 0，請確認本店有配置打印機" : ""));
    } else {
      console.log("   ❌ R2 未通過（期望 200）");
    }

    // R3 真憑證 + 別店 storeId（期望 401）
    const other = SELF_STORE === FAKE_STORE ? "11111111-1111-1111-1111-111111111111" : FAKE_STORE;
    await probe("R3 本店 agent 打別店 storeId（期望 401，證明綁店）", `/api/pos/device-config?storeId=${other}`, agentHeaders);
  } else {
    console.log("\n⚠️ 未設 RELAY_STORE_ID ⇒ 跳過 R2/R3（需要本店真 storeId 才能驗）。");
    console.log("   可由 GET /api/pos/print-agent/pair?agentId=<你的 agentId> 讀出 storeId，");
    console.log("   或直接用你手上知道嘅 merchantId。");
    // 至少用亂造 storeId + 真憑證，證明「憑證有效但綁店失敗」仍 401
    await probe("R2' 真憑證 + 亂造 storeId（期望 401，說明綁店檢查生效）", `/api/pos/device-config?storeId=${FAKE_STORE}`, agentHeaders);
  }

  console.log("\n" + "═".repeat(72));
  console.log("R4（revoked agent → 401）：需先喺 DB 把該 agent 設 revoked_at 再重跑，屬破壞性操作，");
  console.log("   建議改喺測試 agent 上做，或者用 tools/print-relay-revoke-stale-agents.sql 撤銷舊機。");
  console.log("   （本次 APK 上線不必驗 R4；R4 是驗 server 側 verifyAgent 有讀 revoked_at。）");
  console.log("═".repeat(72));
})();
