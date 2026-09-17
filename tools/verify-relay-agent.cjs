/**
 * 中繼機 `device-config` 憑證驗收（唯讀，只發 GET）。
 *
 * 對應 `docs/integration/print-relay-device-config-runbook.md` §5 嘅 R1–R4。
 *
 * 用法：
 *   # R1：匿名（期望 401）
 *   node tools/verify-relay-agent.cjs
 *
 *   # R2：帶本店 agent 憑證（期望 200 且有 printers）
 *   RELAY_AGENT_ID=xxx RELAY_AGENT_TOKEN=yyy node tools/verify-relay-agent.cjs --agent
 *
 *   # R3：帶甲店憑證打乙店（期望 401）——測綁店檢查
 *   RELAY_AGENT_ID=xxx RELAY_AGENT_TOKEN=yyy node tools/verify-relay-agent.cjs --agent --store <乙店 storeId>
 *
 * 憑證用**環境變數**傳，唔好落 shell history / log。
 */
const BASE = process.env.POS_BASE_URL || "https://macau-pos-system.vercel.app";
const DEFAULT_STORE = "8291f843-9def-4956-9d0b-1cfef2598306";

const args = process.argv.slice(2);
const useAgent = args.includes("--agent");
const storeIdx = args.indexOf("--store");
const storeId = storeIdx >= 0 ? args[storeIdx + 1] : args.find((a) => !a.startsWith("--")) || DEFAULT_STORE;

const agentId = process.env.RELAY_AGENT_ID || "";
const agentToken = process.env.RELAY_AGENT_TOKEN || "";

function line(ok, label, detail) {
  console.log(`${ok ? "✅" : "🔴"} ${label}${detail ? "  — " + detail : ""}`);
}

(async () => {
  console.log(`target  = ${BASE}`);
  console.log(`storeId = ${storeId}`);
  console.log(`mode    = ${useAgent ? "帶 agent 憑證" : "匿名"}\n`);

  if (useAgent && (!agentId || !agentToken)) {
    console.log("🔴 用 --agent 但冇設 RELAY_AGENT_ID / RELAY_AGENT_TOKEN（唔好落 shell history）。");
    process.exit(2);
  }

  const headers = {
    "User-Agent": "abu-relay-verify/1.0 (+readonly probe)",
    ...(useAgent ? { "x-agent-id": agentId, "x-agent-token": agentToken } : {}),
  };

  let res;
  try {
    res = await fetch(`${BASE}/api/pos/device-config?storeId=${encodeURIComponent(storeId)}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    console.log(`🔴 連線失敗：${e?.message ?? e}`);
    process.exit(1);
  }

  const body = await res.text();

  if (!useAgent) {
    // R1：匿名必須 401
    line(res.status === 401, `R1 匿名 → ${res.status}`, res.status === 401 ? "閘已生效" : "🔴 閘未生效！");
    console.log(`   回應：${body.slice(0, 120).replace(/\s+/g, " ")}`);
    process.exit(res.status === 401 ? 0 : 1);
  }

  // R2 / R3：帶 agent 憑證
  if (res.status === 401) {
    line(false, `R2/R3 → 401`, "憑證被拒：可能 ① 仍未部署 server 兼容版本 ② token 錯／已撤銷 ③ 跨店（R3 時屬預期）");
    console.log(`   回應：${body.slice(0, 160).replace(/\s+/g, " ")}`);
    process.exit(1);
  }

  if (res.status !== 200) {
    line(false, `R2/R3 → ${res.status}（非預期）`, body.slice(0, 120));
    process.exit(1);
  }

  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    line(false, "R2/R3 → 200 但回應唔係 JSON", body.slice(0, 120));
    process.exit(1);
  }

  const printers = json?.deviceConfig?.printers;
  const list = Array.isArray(printers) ? printers : [];
  line(true, `R2 → 200`, `printers ${list.length} 部`);
  for (const p of list) {
    console.log(
      `     · ${p?.name ?? "(未命名)"}  role=${p?.role ?? "?"}  zone=${p?.zoneId ?? "-"}` +
        `  ${p?.ipAddress ?? "無 IP"}${p?.lanPort ? ":" + p.lanPort : ""}${p?.enabled === false ? "  [已停用]" : ""}`,
    );
  }
  if (list.length === 0) {
    console.log("     ⚠️ 0 部打印機：確認 storeId 係唔係該店，同 POS「設備設置」有冇配置打印機。");
  }
  console.log("\n   ↳ 呢個清單應該同中繼機 App UI 見到嘅路由一致（R5）。");
  console.log("   ↳ 現場核心驗收係 R6：重啟中繼機之後落一張單，要印得出紙而且印對機。");
})();
