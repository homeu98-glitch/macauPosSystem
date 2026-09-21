/**
 * 只讀估算：用「真實欄位結構」砌出代表性 payload，量度位元組數。
 * 唔連任何 DB，純字串長度量度。用完可刪。
 */
const b = (o) => Buffer.byteLength(JSON.stringify(o), "utf8");
const kb = (n) => (n / 1024).toFixed(0);
const mb = (n) => (n / 1024 / 1024).toFixed(2);

// ── 一張餐飲單（4 件菜、每件 1 個規格組、部分帶備註）──
function makeItem(i) {
  return {
    menuItemId: `menu-${i}-${"x".repeat(6)}`,
    name: ["凍檸茶", "豬扒包", "葡撻", "咖喱魚蛋"][i % 4],
    quantity: 1,
    price: 38,
    printerGroup: "kitchen",
    selectedSpecs: [
      {
        groupId: `sg-${i}`,
        groupName: "甜度",
        optionId: `op-${i}`,
        optionLabel: "少甜",
        priceDelta: 0,
      },
    ],
    note: i % 2 ? "走冰" : undefined,
  };
}

function makeOrder(nItems = 4) {
  return {
    id: `order-1a2b3c4d-${"y".repeat(8)}`,
    storeId: `11111111-2222-3333-4444-555555555555`,
    localOrderNo: "A0001",
    tableId: "t-01",
    tableName: "A1",
    status: "settled",
    fulfillmentStatus: "served",
    sentToKitchenAt: "2026-09-20T04:12:33.123Z",
    servedAt: "2026-09-20T04:31:02.000Z",
    items: Array.from({ length: nItems }, (_, i) => makeItem(i)),
    orderNote: "唔要蔥",
    subtotal: 152,
    taxAmount: 0,
    serviceChargeAmount: 15.2,
    discountAmount: 0,
    total: 167.2,
    prepaidAmount: 0,
    onlineOrderId: undefined,
    source: "pos",
    partySize: 2,
    compNote: undefined,
    compedAt: undefined,
    discountNote: undefined,
    paymentMethod: "cash",
    createdAt: "2026-09-20T04:12:30.000Z",
    updatedAt: "2026-09-20T04:31:02.500Z",
    clientUpdatedAt: "2026-09-20T04:31:02.400Z",
    reopenCount: undefined,
    reopenedAt: undefined,
    reopenReason: undefined,
  };
}

const order = makeOrder();
const orderBytes = b(order);
const orderNoItems = b({ ...order, items: [] });

// 一個 print job（廚房單 4 行 items）
const printJob = b({
  id: "job-1a2b3c4d",
  orderId: order.id,
  orderNo: "A0001",
  tableName: "A1",
  ticketType: "normal",
  printerGroup: "kitchen",
  printerName: "廚房機",
  printerId: "p-1",
  onceKey: "kitchen:A0001:0:hash",
  items: order.items,
  status: "sent",
  createdAt: "2026-09-20T04:12:31.000Z",
});

// 一個 queue event（payload = 完整訂單快照）
const queueEvent = b({
  id: "evt-1a2b3c4d",
  type: "ORDER_CREATED",
  entityId: order.id,
  payload: order,
  status: "pending",
  createdAt: "2026-09-20T04:12:31.000Z",
  storeId: order.storeId,
});

// ── 各路徑嘅單次 payload ──
const rows = [
  ["1 張 pos_orders row（帶 items）", orderBytes],
  ["1 張 pos_orders row（只 id/status/updated_at 投影）", b({ id: order.id, status: "settled", updated_at: order.updatedAt })],
  ["1 條 pos_queue_events row（payload=完整訂單）", queueEvent],
  ["1 條 pos_print_jobs row（帶 items）", printJob],
  ["① /api/pos/state 全量（orders200 + queue300 + printJobs200）",
    orderBytes * 200 + queueEvent * 300 + printJob * 200],
  ["② /api/pos/state?ordersOnly=1&limit=5000（對賬守護，無日期下限）",
    orderBytes * 5000],
  ["② 同上，但只回 id/status（投影後）",
    b({ id: order.id, status: "settled", updated_at: order.updatedAt }) * 5000],
  ["③ 報表：2000/頁 × 3 條腿（PAGE=2000）",
    orderBytes * 2000 * 3],
  ["③ 報表：2000/頁 × 3 條腿 → 改 1 條腿 + 投影",
    b({ id: order.id, total: 167.2, status: "settled", created_at: order.createdAt, updated_at: order.updatedAt, reopened_at: null }) * 2000],
  ["④ KDS board（300 單，select *，帶 items）", orderBytes * 300],
  ["⑤ 交班頁（今日 limit=5000 × 3 條腿，實際命中 = 今日單數）", orderBytes * 3],
];

console.log("單位：位元組（B）");
for (const [k, v] of rows) {
  console.log(`${k.padEnd(58, " ")} ${String(v).padStart(10)} B  = ${mb(v).padStart(8)} MB`);
}

console.log("\n── 日用量模型（單一終端，營業 12 小時）──");
const cases = [
  ["對賬守護：5000 上限全店拉，每 10 分鐘 1 次", orderBytes * 5000 * 6 * 12],
  ["對賬守護：5000 上限全店拉，每 10 分鐘 5 次（>100 張待核實）", orderBytes * 5000 * 5 * 6 * 12],
  ["對賬守護改投影 + 帶日期下限（7 日 ≈ 700 單）", b({ id: "x", status: "settled", updated_at: "y" }) * 700 * 6 * 12],
  ["全量 state：每個 queue-changed / mount 拉一次（實測每單 1-2 次）", orderBytes * 200 + queueEvent * 300 + printJob * 200],
  ["KDS 看門狗：每 60 秒拉 300 單 × 12 小時", orderBytes * 300 * 60 * 12],
  ["報表：3 分鐘刷新、all/30d 範圍（最多 10 頁 × 2000 × 3 腿）", orderBytes * 2000 * 3 * 20],
];
for (const [k, v] of cases) {
  console.log(`${k.padEnd(58, " ")} ${mb(v).padStart(10)} MB/日`);
}
