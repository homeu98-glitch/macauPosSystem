/**
 * API 契約驗證（2026-09-21）：確認新增嘅 query param 唔會改動舊呼叫嘅回應。
 *
 * 重點核對三件事：
 *   ① 舊呼叫（唔傳新 param）→ 回應 keys 必須同改動前一致（唔可以少／多欄）
 *   ② 新 param（`fields` / `skipQueue`）→ 只可以影響「有冇回該部分」，唔可以 500
 *   ③ 非法／奇怪嘅 param 值 → 唔可以 500（白名單要靜默過濾）
 *
 * 用法：node tools/_verify-api-contract-20260921.cjs
 * 前提：本機 dev server 已喺 3017 跑起（無 Supabase env → 會走 mock 分支，
 *      但 query param 解析同 early-return 之前嘅邏輯全部照跑，所以足以捉「解析爆掉」）。
 */
const BASE = "http://localhost:3017";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";

/** 回應指紋：status ＋ top-level keys ＋ bytes（唔印內容，避免太長）。 */
async function probe(label, url, init) {
  let status = "ERR";
  let keys = "(n/a)";
  let bytes = 0;
  let note = "";
  try {
    const res = await fetch(BASE + url, init);
    status = res.status;
    const text = await res.text();
    bytes = Buffer.byteLength(text, "utf8");
    try {
      const json = JSON.parse(text);
      keys = Object.keys(json).sort().join(",");
      if (json.error) note = String(json.error).slice(0, 60);
      if (json.ok !== undefined) note = `ok=${json.ok}${note ? " " + note : ""}`;
    } catch {
      keys = "(非 JSON)";
      note = text.slice(0, 60);
    }
  } catch (err) {
    note = String(err.message).slice(0, 70);
  }
  return { label, status: String(status), bytes, keys, note };
}

(async () => {
  const cases = [
    // ── /api/pos/state：舊行為（基準）──
    ["state 全量（基準，唔傳新 param）", `/api/pos/state?storeId=${STORE}`],
    ["state ordersOnly（基準）", `/api/pos/state?storeId=${STORE}&ordersOnly=1&limit=200`],

    // ── /api/pos/state：新增 param ──
    ["state ordersOnly + fields（A1 投影）", `/api/pos/state?storeId=${STORE}&ordersOnly=1&fields=id,status,updated_at`],
    ["state ordersOnly + fields（含 items）", `/api/pos/state?storeId=${STORE}&ordersOnly=1&fields=id,items`],
    ["state ordersOnly + fields 全垃圾值（要靜默過濾，唔可以 500）", `/api/pos/state?storeId=${STORE}&ordersOnly=1&fields=;,DROP,xyz`],
    ["state 全量（唔應該受 fields 影響）", `/api/pos/state?storeId=${STORE}&fields=id`],
    ["state + skipQueue=1（A5）", `/api/pos/state?storeId=${STORE}&skipQueue=1`],
    ["state + skipQueue=1&ordersOnly=1", `/api/pos/state?storeId=${STORE}&skipQueue=1&ordersOnly=1`],
    ["state 冇 storeId（fail-safe 空回）", `/api/pos/state`],
    ["state limit 越界（要 400）", `/api/pos/state?storeId=${STORE}&limit=99999`],
    ["state offset 越界（要 400）", `/api/pos/state?storeId=${STORE}&offset=-1`],

    // ── 其他被動到嘅端點（確認仍然回答）──
    ["kds/board", `/api/pos/kds/board?storeId=${STORE}`],
    ["print-jobs/status", `/api/pos/print-jobs/status?storeId=${STORE}`],
    ["online-order-settings", `/api/online-order-settings?storeId=${STORE}`],
    ["pos/shift", `/api/pos/shift?storeId=${STORE}`],
    ["pos/store-status", `/api/pos/store-status?storeId=${STORE}`],
    ["pos/orders（GET）", `/api/pos/orders?storeId=${STORE}`],
    ["pos/print-templates", `/api/pos/print-templates?storeId=${STORE}`],
    // ── print-agent 三個 POST（2026-09-21 recordActivity 改動：確認 module 載得入、唔會 crash）──
    // 本機無 Supabase ⇒ 一律 503（未配置）。重點係**唔可以 500**（＝import／型別錯誤）。
    ["print-agent/heartbeat", "/api/pos/print-agent/heartbeat", { method: "POST" }],
    ["print-agent/claim", "/api/pos/print-agent/claim", { method: "POST" }],
    ["print-agent/result", "/api/pos/print-agent/result", { method: "POST" }],
    ["device-config（GET，唔可以寫入）", `/api/pos/device-config?storeId=${STORE}`],
  ];

  const rows = [];
  for (const [label, url, init] of cases) {
    rows.push(await probe(label, url, init));
  }

  console.log("================ API 契約驗證 ================");
  for (const r of rows) {
    console.log(
      `${String(r.status).padEnd(4)} ${String(r.bytes).padStart(7)}B  ${r.label}\n          keys = ${r.keys}${r.note ? `\n          ${r.note}` : ""}`,
    );
  }

  // ── 斷言 ──
  console.log("\n================ 判定 ================");
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  const checks = [];

  const full = byLabel["state 全量（基準，唔傳新 param）"];
  const fullWithFields = byLabel["state 全量（唔應該受 fields 影響）"];
  checks.push([
    "全量 state 帶 fields 唔可以改變回應（fields 只准 ordersOnly 生效）",
    full && fullWithFields && full.keys === fullWithFields.keys && full.bytes === fullWithFields.bytes,
  ]);

  const baseOrdered = byLabel["state ordersOnly（基準）"];
  const projOrdered = byLabel["state ordersOnly + fields（A1 投影）"];
  checks.push([
    "ordersOnly 帶 fields 唔可以少 key（唔可以少 ok/source/orders）",
    baseOrdered && projOrdered && baseOrdered.keys === projOrdered.keys,
  ]);

  const junk = byLabel["state ordersOnly + fields 全垃圾值（要靜默過濾，唔可以 500）"];
  checks.push(["垃圾 fields 值唔可以 500", junk && junk.status === "200"]);

  const skipFull = byLabel["state + skipQueue=1（A5）"];
  checks.push(["skipQueue=1 唔可以 500", skipFull && skipFull.status === "200"]);
  checks.push([
    "skipQueue 只影響 queue 欄（keys 唔可以變）",
    skipFull && full && skipFull.keys === full.keys,
  ]);

  const noStore = byLabel["state 冇 storeId（fail-safe 空回）"];
  checks.push(["冇 storeId 仍然 fail-safe 回答（唔係 500）", noStore && noStore.status === "200"]);

  const limitBad = byLabel["state limit 越界（要 400）"];
  const offsetBad = byLabel["state offset 越界（要 400）"];
  checks.push(["limit 越界仍然 400（既有驗證冇被繞過）", limitBad && limitBad.status === "400"]);
  checks.push(["offset 越界仍然 400", offsetBad && offsetBad.status === "400"]);
  // ── print-agent 三個 POST（recordActivity 改動）：本機未配置 → 503，重點係唔可以 500 ──
  for (const label of ["print-agent/heartbeat", "print-agent/claim", "print-agent/result"]) {
    const r = byLabel[label];
    checks.push([`${label} → 503（唔係 500 / crash）`, r?.status === "503"]);
  }
  checks.push([
    "device-config GET 仍然回答（唔可以 500）",
    ["200", "401", "503"].includes(byLabel["device-config（GET，唔可以寫入）"]?.status ?? ""),
  ]);

  for (const [name, ok] of checks) console.log(`${ok ? "✅" : "❌"} ${name}`);

  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n合計：${checks.length - failed} 通過 / ${failed} 失敗`);
  if (failed > 0) process.exitCode = 1;
})();
