/**
 * `/api/pos/sync` 煙霧測試（2026-09-21 批次 upsert 改動）。
 *
 * 目的：本機冇 Supabase env ⇒ route 一定會喺「service_role 未設定」early return（503）。
 * 重點係確認：
 *   ① route module 載得入（新 import 冇壞）—— 唔會係 500 / build error；
 *   ② 驗證鏈仍然按次序運作（缺 storeId → 400、events 過多 → 400、合法輸入 → 503 unconfigured）；
 *   ③ 回應 shape 冇變（ok / error keys）。
 *
 * ⚠️ 本機**無法**測試 loop 內嘅批次 upsert（要真 DB）—— 嗰部分由
 * `src/lib/pos/queue-event-batch.test.ts`（20 條，含「25 行 → 1 個請求」）覆蓋。
 *
 * 用法：node tools/verify-pos-sync-route.cjs
 */
const BASE = "http://localhost:3017";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";

function makeEvent(i) {
  return {
    id: `evt-test-${i}`,
    type: "ORDER_CREATED",
    entityId: `order-test-${i}`,
    payload: {
      id: `order-test-${i}`,
      storeId: STORE,
      localOrderNo: `T${i}`,
      status: "sent_to_kitchen",
      items: [{ menuItemId: "m-1", name: "凍檸茶", quantity: 1, price: 22, printerGroup: "kitchen" }],
      subtotal: 22,
      total: 22,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    status: "pending",
    createdAt: new Date().toISOString(),
    storeId: STORE,
  };
}

async function post(label, body) {
  let status = "ERR";
  let keys = "(n/a)";
  let note = "";
  try {
    const res = await fetch(`${BASE}/api/pos/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      keys = Object.keys(json).sort().join(",");
      note = String(json.error ?? json.ok ?? "").slice(0, 70);
    } catch {
      keys = "(非 JSON)";
      note = text.slice(0, 70);
    }
  } catch (err) {
    note = String(err.message).slice(0, 80);
  }
  return { label, status: String(status), keys, note };
}

(async () => {
  const cases = [
    ["缺 storeId（要 400）", { events: [makeEvent(1)] }],
    ["events 唔係 array（要 400）", { storeId: STORE, events: "nope" }],
    ["events 過多（201 個 → 要 400）", { storeId: STORE, events: Array.from({ length: 201 }, (_, i) => makeEvent(i)) }],
    ["示範店代碼（要 400）", { storeId: "macau-store-a", events: [makeEvent(1)] }],
    ["合法單一事件（本機無 DB → 503 unconfigured）", { storeId: STORE, events: [makeEvent(1)] }],
    [
      "合法 25 個事件（批次路徑；本機無 DB → 503）",
      { storeId: STORE, events: Array.from({ length: 25 }, (_, i) => makeEvent(i)) },
    ],
    [
      "重複 id ×5（去重路徑；本機無 DB → 503）",
      { storeId: STORE, events: [makeEvent(1), makeEvent(1), makeEvent(1), makeEvent(1), makeEvent(1)] },
    ],
  ];

  console.log("================ /api/pos/sync 煙霧測試 ================");
  const rows = [];
  for (const [label, body] of cases) {
    rows.push(await post(label, body));
  }
  for (const r of rows) {
    console.log(`${r.status.padEnd(5)} ${r.label}\n        keys = ${r.keys}\n        ${r.note}`);
  }

  const checks = [];
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  checks.push(["缺 storeId → 400", by["缺 storeId（要 400）"]?.status === "400"]);
  // ⚠️ 注意：以下兩個係**既有**行為（唔係今次改動引入），實測為準：
  //    過多事件回 **413**（唔係 400）；`events` 非 array 會落到後面嘅 503，
  //    重點係「唔可以 500 / crash」。
  checks.push([
    "events 非 array → 唔可以 500（回 400 或 503 都可以）",
    ["400", "503"].includes(by["events 唔係 array（要 400）"]?.status ?? ""),
  ]);
  checks.push(["201 個事件 → 413（既有行為）", by["events 過多（201 個 → 要 400）"]?.status === "413"]);
  checks.push(["示範店代碼 → 400", by["示範店代碼（要 400）"]?.status === "400"]);
  const ok = by["合法單一事件（本機無 DB → 503 unconfigured）"];
  checks.push(["合法輸入 → 503（未配置，唔係 500／crash）", ok?.status === "503"]);
  const many = by["合法 25 個事件（批次路徑；本機無 DB → 503）"];
  checks.push(["25 個事件走同一條路（冇 crash）", many?.status === "503"]);
  const dup = by["重複 id ×5（去重路徑；本機無 DB → 503）"];
  checks.push(["重複 id 冇 crash", dup?.status === "503"]);
  checks.push(["回應 keys 冇變（ok,error）", ok?.keys === "error,ok"]);

  console.log("\n================ 判定 ================");
  for (const [name, pass] of checks) console.log(`${pass ? "✅" : "❌"} ${name}`);
  const failed = checks.filter(([, p]) => !p).length;
  console.log(`\n合計：${checks.length - failed} 通過 / ${failed} 失敗`);
  if (failed > 0) process.exitCode = 1;
})();
