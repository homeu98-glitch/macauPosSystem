import assert from "node:assert/strict";
import test from "node:test";

// ⚠️ 一定要用**相對路徑 + .ts 副檔名**：`node --test` 用 Node 內建 type-stripping，
// 唔識 tsconfig 嘅 `@/` path alias（會 ERR_MODULE_NOT_FOUND）。
// 呢個模組嘅 `@/lib/types` 係 `import type` → 會被 strip 走，所以直接載入得到。
import {
  buildMenuIndex,
  grabberLifecycle,
  grabberLocalOrderNo,
  grabberTurnover,
  matchMenuItem,
  normalizeAomiLifecycle,
  normalizeMfoodLifecycle,
  platformFeeLines,
  projectGrabberOrder,
  type GrabberOrder,
  type MenuLike,
} from "./grabber-order.ts";

/**
 * 外賣平台單投影測試。
 *
 * 為什麼值得逐條鎖死：呢條路徑係「平台 → POS」，一旦悄悄出錯
 * （狀態當成正常、金額攞錯口徑、菜名對唔到但冇聲），
 * 症狀係「POS 多咗一張錯單」而唔係拋錯 —— 最難查嘅一種。
 */

// ── 測試替身 ─────────────────────────────────────────────────

const MENU: MenuLike[] = [
  { id: "m-1", name: "表嫂手打肉餅", price: 68, printerGroup: "kitchen" },
  { id: "m-2", name: "凍檸茶", price: 18, printerGroup: "bar" },
  { id: "m-3", name: "A16.洋蔥炒雞", price: 67, printerGroup: "kitchen" },
];

function aomiOrder(patch: Partial<GrabberOrder> = {}): GrabberOrder {
  return {
    source: "aomi",
    externalOrderId: "TK001361260917190710813",
    storeSeqNo: "#3",
    stateEnum: "ORDER_ARRIVED",
    stateRaw: "客戶已確認收餐",
    amount: { turnoverAmount: 126, payAmount: 121 },
    occurredAt: "2026-09-24 10:31:00",
    items: [
      { displayName: "表嫂手打肉餅", quantity: 1, unitPrice: 68, specs: ["馬蹄", "米飯", "蒸"] },
      { displayName: "例湯", quantity: 1, unitPrice: 0 },
    ],
    ...patch,
  };
}

function mfoodOrder(patch: Partial<GrabberOrder> = {}): GrabberOrder {
  return {
    source: "mfood",
    externalOrderId: "463403",
    orderNumber: 2,
    orderStatus: "completed",
    transactionStatus: "paid",
    amount: { businessAmount: 62, payAmount: 62 },
    items: [{ displayName: "凍檸茶", quantity: 2, unitPrice: 18 }],
    ...patch,
  };
}

// ── ① 生命週期 ───────────────────────────────────────────────

test("澳覓狀態：用 ASCII enum 判斷，唔用中文字串硬猜", () => {
  assert.equal(normalizeAomiLifecycle("ORDER_ARRIVED", "客戶已確認收餐"), "active");
  assert.equal(normalizeAomiLifecycle("ORDER_CANCELED", null), "cancelled");
  assert.equal(normalizeAomiLifecycle("ORDER_REFUND_APPLY", null), "refunded");
  assert.equal(normalizeAomiLifecycle("SOMETHING_NEW_V2", null), "unknown");
});

test("澳覓狀態：冇 enum 時，中文只作 fallback", () => {
  assert.equal(normalizeAomiLifecycle(null, "訂單已取消"), "cancelled");
  assert.equal(normalizeAomiLifecycle(null, "退款處理中"), "refunded");
  assert.equal(normalizeAomiLifecycle(null, "訂單已送達"), "active");
  assert.equal(normalizeAomiLifecycle(null, null), "unknown");
});

test("mfood 狀態：已知值只有 completed / paid，其餘一律 unknown", () => {
  assert.equal(normalizeMfoodLifecycle("completed", "paid"), "active");
  assert.equal(normalizeMfoodLifecycle("cancelled", null), "cancelled");
  assert.equal(normalizeMfoodLifecycle(null, null), "unknown");
  assert.equal(normalizeMfoodLifecycle("weird_new_status", null), "unknown");
});

test("grabberLifecycle 會跟來源揀啱嘅映射", () => {
  assert.equal(grabberLifecycle(aomiOrder()), "active");
  assert.equal(grabberLifecycle(mfoodOrder()), "active");
  assert.equal(grabberLifecycle({ source: "unknown_platform" }), "unknown");
});

// ── ② 單號 ───────────────────────────────────────────────────

test("localOrderNo：澳覓本身就帶 #，唔可以變 ##", () => {
  assert.equal(grabberLocalOrderNo(aomiOrder({ storeSeqNo: "#3" })), "澳覓#3");
  assert.equal(grabberLocalOrderNo(aomiOrder({ storeSeqNo: "3" })), "澳覓#3");
});

test("localOrderNo：mfood 由數字補上 #", () => {
  assert.equal(grabberLocalOrderNo(mfoodOrder({ orderNumber: 2 })), "MFOOD#2");
  assert.equal(grabberLocalOrderNo(mfoodOrder({ orderNumber: "12" })), "MFOOD#12");
});

test("localOrderNo：兩個編號都冇時，用外部單號尾 6 位兜底（起碼唔會撞名）", () => {
  assert.equal(
    grabberLocalOrderNo({ source: "mfood", externalOrderId: "CRD202609231747152464371" }),
    "MFOOD#464371",
  );
});

// ── ③ 金額口徑 ───────────────────────────────────────────────

test("營業額：澳覓用 turnoverAmount，唔用客人實付 payAmount", () => {
  const r = grabberTurnover({ amount: { turnoverAmount: 126, payAmount: 121 } });
  assert.equal(r.total, 126);
  assert.equal(r.fellBack, false);
});

test("營業額：mfood 用 businessAmount", () => {
  const r = grabberTurnover({ amount: { businessAmount: 62, payAmount: 70 } });
  assert.equal(r.total, 62);
});

test("營業額：冇 turnover / business 時退回 payAmount，並要標記 fellBack", () => {
  const r = grabberTurnover({ amount: { payAmount: 55 } });
  assert.equal(r.total, 55);
  assert.equal(r.fellBack, true);
});

// ── ④ 菜單比對 ───────────────────────────────────────────────

test("菜名比對：完全一致 → name", () => {
  const idx = buildMenuIndex(MENU);
  const r = matchMenuItem({ displayName: "表嫂手打肉餅" }, idx);
  assert.equal(r.menu?.id, "m-1");
  assert.equal(r.matchedBy, "name");
});

test("菜名比對：忽略空白與大小寫 → normalized", () => {
  const idx = buildMenuIndex(MENU);
  const r = matchMenuItem({ displayName: " 表嫂 手打肉餅 " }, idx);
  assert.equal(r.menu?.id, "m-1");
  assert.equal(r.matchedBy, "normalized");
});

test("菜名比對：純字面相同 / 去空白大小寫相同 —— 就係得呢兩級", () => {
  const idx = buildMenuIndex(MENU);
  const r = matchMenuItem({ displayName: "A16.洋蔥炒雞", name: "A16.洋蔥炒雞" }, idx);
  assert.equal(r.menu?.id, "m-3");
  assert.equal(r.matchedBy, "name");

  const r2 = matchMenuItem({ displayName: " 表嫂 手打肉餅 " }, idx);
  assert.equal(r2.menu?.id, "m-1");
  assert.equal(r2.matchedBy, "normalized");
});

test("🔴 平台菜名一律當 free text：唔會去猜編號（去咗前綴都要對唔到）", () => {
  const idx = buildMenuIndex(MENU);
  // 平台叫 "洋蔥炒雞"、POS 餐牌叫 "A16.洋蔥炒雞" → 唔可以當佢哋係同一樣嘢
  assert.equal(matchMenuItem({ displayName: "洋蔥炒雞" }, idx).menu, undefined);
  // 平台帶唔同編號 → 一樣唔可以當係
  assert.equal(matchMenuItem({ displayName: "B99.洋蔥炒雞" }, idx).menu, undefined);
});

test("菜名比對：對唔到就係對唔到，唔可以當數", () => {
  const idx = buildMenuIndex(MENU);
  const r = matchMenuItem({ displayName: "外星炒飯" }, idx);
  assert.equal(r.menu, undefined);
  assert.equal(r.matchedBy, null);
});

// ── ⑤ 投影 ───────────────────────────────────────────────────

test("投影：訂單層欄位一次過驗（枱號／來源／狀態／已付）", () => {
  const r = projectGrabberOrder({ order: mfoodOrder(), storeId: "store-1", menuItems: MENU });
  assert.equal(r.ok, true);
  const row = r.row!;
  assert.equal(row.id, "mfood-463403");
  assert.equal(row.external_order_id, "463403");
  assert.equal(row.source, "mfood");
  assert.equal(row.store_id, "store-1");
  assert.equal(row.local_order_no, "MFOOD#2");
  assert.equal(row.table_id, "counter");
  assert.equal(row.table_name, "外賣");
  assert.equal(row.total, 62);
  assert.equal(row.prepaid_amount, 62, "平台單一律線上已付");
  assert.equal(row.tax_amount, 0);
  assert.equal(row.service_charge_amount, 0);
});

test("🔴 投影：平台單一律 paid（線上已付款）；自動接單只控制出餐階段", () => {
  const on = projectGrabberOrder({ order: mfoodOrder(), storeId: "s", autoAccept: true });
  const off = projectGrabberOrder({ order: mfoodOrder(), storeId: "s", autoAccept: false });

  // 🔴 一定要係 `paid`：
  //    `pos-order-filters.getPaymentBadge()` 只認
  //    `paid | settled | refunded | partially_refunded` 為「已結帳」，
  //    用 `draft` / `sent_to_kitchen` 會顯示「未結帳」＋出現「結帳」掣
  //    （2026-09-24 使用者實案：澳覓#98 明明線上已付款卻顯示未結帳）。
  assert.equal(on.row!.status, "paid", "自動接單開：已付款");
  assert.equal(off.row!.status, "paid", "自動接單關：一樣係已付款（錢一早收咗）");

  // 待確認 vs 製作中 改用 fulfillmentStatus 區分
  assert.equal(on.row!.fulfillment_status, "preparing", "自動接單開 → 製作中");
  assert.equal(off.row!.fulfillment_status, null, "自動接單關 → 等員工接受");
});

test("投影：差額 = 菜品原價合計 − 營業額（含平台補貼），且唔可以係負數", () => {
  const r = projectGrabberOrder({ order: aomiOrder(), storeId: "s", menuItems: MENU });
  // items: 68 × 1 + 0 × 1 = 68；營業額 126 → 差額 clamp 0
  assert.equal(r.row!.subtotal, 68);
  assert.equal(r.row!.total, 126);
  assert.equal(r.row!.discount_amount, 0);
});

test("投影：菜品原價高過營業額時，差額正常計出", () => {
  const r = projectGrabberOrder({
    order: mfoodOrder({ amount: { businessAmount: 30 } }),
    storeId: "s",
    menuItems: MENU,
  });
  assert.equal(r.row!.subtotal, 36); // 18 × 2
  assert.equal(r.row!.total, 30);
  assert.equal(r.row!.discount_amount, 6);
});

test("投影：命中餐牌 → 用該菜品嘅 printerGroup；對唔到 → 退回 kitchen 並回報", () => {
  const hit = projectGrabberOrder({
    order: mfoodOrder(),
    storeId: "s",
    menuItems: MENU,
  });
  assert.equal(hit.row!.items[0].printerGroup, "bar");
  assert.deepEqual(hit.unmatched, []);

  const miss = projectGrabberOrder({
    order: mfoodOrder({ items: [{ displayName: "外星炒飯", quantity: 1, unitPrice: 20 }] }),
    storeId: "s",
    menuItems: MENU,
  });
  assert.equal(miss.row!.items[0].printerGroup, "kitchen");
  assert.equal(miss.row!.items[0].menuItemId, "ext-外星炒飯");
  assert.deepEqual(miss.unmatched, ["外星炒飯"]);
  assert.ok(
    miss.warnings.some((w) => w.includes("對唔到 POS 餐牌")),
    "🔴 對唔到餐牌一定要有可見 warning，唔可以靜靜當數",
  );
});

test("投影：方案 A —— 有平台分區時，所有品項都用佢（唔理餐牌比對）", () => {
  const r = projectGrabberOrder({
    order: mfoodOrder({
      items: [
        { displayName: "凍檸茶", quantity: 1, unitPrice: 18 },
        { displayName: "外星炒飯", quantity: 1, unitPrice: 30 },
      ],
    }),
    storeId: "s",
    menuItems: MENU,
    platformZone: "外賣平台",
  });
  assert.equal(r.row!.items[0].printerGroup, "外賣平台");
  assert.equal(r.row!.items[1].printerGroup, "外賣平台");
});

test("🔴 設了平台分區時，對唔到餐牌唔可以告警（對唔到係常態，告警會變噪音）", () => {
  const r = projectGrabberOrder({
    order: mfoodOrder({ items: [{ displayName: "平台獨有菜名", quantity: 1, unitPrice: 30 }] }),
    storeId: "s",
    menuItems: MENU,
    platformZone: "外賣平台",
  });
  assert.ok(
    !r.warnings.some((w) => w.includes("對唔到 POS 餐牌")),
    "有分區時唔應該為「對唔到餐牌」出警告",
  );
  // 但資料仍然要回報，方便匯總統計
  assert.deepEqual(r.unmatched, ["平台獨有菜名"]);
});

test("投影：規格只能當顯示文字（冇 group/option id、唔加價）", () => {
  const r = projectGrabberOrder({ order: aomiOrder(), storeId: "s", menuItems: MENU });
  const specs = r.row!.items[0].selectedSpecs ?? [];
  assert.equal(specs.length, 3);
  assert.equal(specs[0].optionLabel, "馬蹄");
  assert.equal(specs[0].priceDelta, 0);
  assert.equal(specs[0].groupId, "platform");
});

test("投影：已取消／已退款嘅單唔會建立（防禦，正常插件唔會推）", () => {
  const c = projectGrabberOrder({
    order: aomiOrder({ stateEnum: "ORDER_CANCELED" }),
    storeId: "s",
  });
  assert.equal(c.ok, false);
  assert.ok(c.reason?.includes("唔會建立"));
});

test("投影：狀態無法辨識 → 仍然建立，但一定要有 warning", () => {
  const r = projectGrabberOrder({
    order: mfoodOrder({ orderStatus: "brand_new", transactionStatus: null }),
    storeId: "s",
    menuItems: MENU,
  });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes("狀態無法辨識")));
});

test("投影：缺來源／外部單號／storeId／品項 → 一律 ok:false 且講明原因", () => {
  assert.equal(
    projectGrabberOrder({ order: mfoodOrder({ source: "unknown" }), storeId: "s" }).ok,
    false,
  );
  assert.equal(
    projectGrabberOrder({ order: mfoodOrder({ externalOrderId: "" }), storeId: "s" }).ok,
    false,
  );
  assert.equal(projectGrabberOrder({ order: mfoodOrder(), storeId: "" }).ok, false);
  const noItems = projectGrabberOrder({ order: mfoodOrder({ items: [] }), storeId: "s" });
  assert.equal(noItems.ok, false);
  assert.ok(noItems.reason?.includes("冇可用品項"));
});

test("投影：raw_json 原樣保存，方便事後重算", () => {
  const order = mfoodOrder();
  const r = projectGrabberOrder({ order, storeId: "s", menuItems: MENU });
  assert.equal(r.row!.raw_json, order);
});

// ── 費用逐項化（用 2026-09-24 使用者提供嘅**真實 payload** 做測試資料）──

test("🔴 澳覓真實單：172 + 5 + 1 + 0 − 21 = 157（逐項加得起來）", () => {
  // 真實 payload：TK001521260916184023332
  const order: GrabberOrder = {
    source: "aomi",
    externalOrderId: "TK001521260916184023332",
    storeSeqNo: "1",
    stateEnum: "ORDER_ARRIVED",
    amount: {
      turnoverAmount: 157, // turnoverAmt 15700 分 → 元
      totalAmt: 172, // 菜品原價合計
      boxAmt: 5, // boxAmt 500
      plasticAmt: 1, // plasticAmt 100
      holidayServiceAmt: 0,
      merchantActAmt: 21, // merchantActAmt 2100
      sendAmt: 10, // 顧客支付配送費（唔入營業額）
    },
    items: [
      { displayName: "即叫即蒸魚飯", quantity: 1, unitPrice: 68 },
      { displayName: "肉片炒時菜", quantity: 1, unitPrice: 48 },
      { displayName: "表嫂口水雞", quantity: 1, unitPrice: 56 },
    ],
  };

  const r = projectGrabberOrder({ order, storeId: "s" });
  const feeSum = r.row!.platform_fees.reduce((n, x) => (x.excluded ? n : n + x.amount), 0);

  assert.equal(r.row!.subtotal, 172, "菜品原價合計");
  assert.equal(r.row!.total, 157, "總額 = 營業額");
  assert.equal(
    r.row!.subtotal + feeSum - r.row!.discount_amount,
    r.row!.total,
    "🔴 菜品 + 費用 − 優惠 === 營業額",
  );
  // 逐項要有餐盒費、膠袋費、商家活動支出（負數）
  const labels = r.row!.platform_fees.map((f) => f.label);
  assert.ok(labels.includes("餐盒費"), "要有餐盒費");
  assert.ok(labels.includes("膠袋費"), "要有膠袋費");
  assert.ok(labels.includes("商家活動支出"), "要有商家活動支出");
  const act = r.row!.platform_fees.find((f) => f.label === "商家活動支出");
  assert.equal(act!.amount, -21, "商家活動支出要係負數");
  // 列出費用後殘差應該係 0
  assert.equal(r.row!.discount_amount, 0, "逐項列出後殘差 = 0");
});

test("🔴 mfood 真實單：118 + 3 + 1 − 4 = 118（逐項加得起來）", () => {
  // 真實 payload：CRD202609212007281125023
  const order: GrabberOrder = {
    source: "mfood",
    externalOrderId: "202609212007281125023",
    orderNumber: 1,
    orderStatus: "completed",
    transactionStatus: "paid",
    amount: {
      businessAmount: 118, // businessAmtn 118
      boxFee: 3,
      plasticBagFee: 1,
      serviceFee: 0,
      voucherAmtn: 0,
      fullReductionAmtn: 4,
      memberUpMoneyAmt: 0,
      merchantDisDeliveryAmtn: 12, // 商家配送費減免（唔入營業額）
      deliverySubsidyAmtn: 0.8,
    },
    // 品項單價要用實收價：productAmtn 67 / 51（唔係 skuPrice 58）
    items: [
      { displayName: "表嫂手打肉餅", quantity: 1, unitPrice: 67 },
      { displayName: "A17.紅燒肉碎燜茄子", quantity: 1, unitPrice: 51 },
    ],
  };

  const r = projectGrabberOrder({ order, storeId: "s" });
  const feeSum = r.row!.platform_fees.reduce((n, x) => (x.excluded ? n : n + x.amount), 0);

  assert.equal(r.row!.subtotal, 118, "菜品加總（用 productAmtn）");
  assert.equal(r.row!.total, 118, "總額 = 營業額");
  assert.equal(
    r.row!.subtotal + feeSum - r.row!.discount_amount,
    r.row!.total,
    "🔴 菜品 + 費用 − 優惠 === 營業額",
  );
  const labels = r.row!.platform_fees.map((f) => f.label);
  assert.ok(labels.includes("餐盒費"), "要有餐盒費");
  assert.ok(labels.includes("膠袋費"), "要有膠袋費");
  assert.ok(labels.includes("商家滿減"), "要有商家滿減");
  const full = r.row!.platform_fees.find((f) => f.label === "商家滿減");
  assert.equal(full!.amount, -4, "商家滿減要係負數");
  assert.equal(r.row!.discount_amount, 0, "逐項列出後殘差 = 0");
});

test("🔴 澳覓真實單 #2（專送）：250 + 4 + 3 + 0 − 9 = 248", () => {
  // 真實 payload：T20220924185044482686
  //
  // 🔴 呢張單同時證實咗「配送費」嘅歸屬：
  //    營業額 248 = 250 + 4 + 3 − 9（**冇**配送費）
  //    顧客實付 255 = 250 + 4 + 3 + 7(配送費) − 9 ✓
  //    ⇒ 配送費屬「顧客支付」，唔入商家營業額 —— 所以收據要標「不計入營業額」。
  //
  // 亦確認：呢間店嘅單冇「配送費(商家)」「配送費商家減免」（sendTypeEnum: ZHUANSONG，
  // 平台專送，商家唔使承擔配送費）→ 兩項恆為 0，由殘差行兜底即可。
  const order: GrabberOrder = {
    source: "aomi",
    externalOrderId: "T20220924185044482686",
    storeSeqNo: "10",
    stateEnum: "ORDER_ARRIVED",
    amount: {
      turnoverAmount: 248, // turnoverAmt 24800
      totalAmt: 250, // 菜品原價合計
      boxAmt: 4, // boxAmt 400
      plasticAmt: 3, // plasticAmt 300
      sendAmt: 7, // sendAmt 700（顧客支付配送費）
      holidayServiceAmt: 0,
      merchantActAmt: 9, // merchantActAmt 900
      goodsAllAmount: 257, // 商品總金額 = 250 + 4 + 3
    },
    items: [
      { displayName: "牛肉炒时菜", quantity: 1, unitPrice: 52 },
      { displayName: "表嫂酸菜魚", quantity: 1, unitPrice: 198 },
    ],
  };

  const r = projectGrabberOrder({ order, storeId: "s" });
  const feeSum = r.row!.platform_fees.reduce((n, x) => (x.excluded ? n : n + x.amount), 0);

  assert.equal(r.row!.subtotal, 250, "菜品原價合計");
  assert.equal(r.row!.total, 248, "總額 = 營業額");
  assert.equal(
    r.row!.subtotal + feeSum - r.row!.discount_amount,
    r.row!.total,
    "🔴 菜品 + 費用 − 優惠 === 營業額",
  );
  assert.equal(r.row!.discount_amount, 0, "殘差 = 0（費用已逐項齊全，唔使兜底）");

  // 配送費要出現（使用者要求不可省略），但係 excluded，唔會污染加總
  const delivery = r.row!.platform_fees.find((f) => f.label === "配送費");
  assert.ok(delivery, "要有配送費行");
  assert.equal(delivery!.amount, 7, "配送費 = sendAmt");
  assert.equal(delivery!.excluded, true, "🔴 配送費要標明不計入營業額");

  // 計入加總嘅費用唔可以包含配送費
  const included = r.row!.platform_fees.filter((f) => !f.excluded);
  assert.equal(
    included.reduce((n, x) => n + x.amount, 0),
    -2,
    "計入加總嘅只有 餐盒4 + 膠袋3 − 商家活動9 = −2",
  );
});

test("🔴 用「插件實際送出嘅欄位名」驗 mfood 商家優惠（回歸）", () => {
  // 教訓（2026-09-24）：先前測試用**平台原始名**（`fullReductionAmtn`），
  // 但插件 bridge 正規化之後送出嘅係 `fullReductionAmount` → POS 搵唔到 →
  // 真實單嘅「商家滿減／代金券／月卡紅包」一個都唔會出現，靠殘差行兜底。
  // ⇒ 測試一定要用**實際會出現嘅名字**。
  const order: GrabberOrder = {
    source: "mfood",
    externalOrderId: "NORM-1",
    amount: {
      businessAmount: 66,
      // bridge 正規化後嘅名（`*Amount`）—— 真實 payload 就係咁
      boxFee: 3,
      plasticBagFee: 1,
      serviceFee: 0,
      voucherAmount: 0,
      fullReductionAmount: 6,
      memberUpAmount: 0,
      merchantDeliveryAmount: 12,
      deliverySubsidyAmount: 0.8,
    },
    items: [{ displayName: "表嫂手打肉餅", quantity: 1, unitPrice: 68 }],
  };

  const r = projectGrabberOrder({ order, storeId: "s" });
  const labels = r.row!.platform_fees.map((f) => f.label);
  assert.ok(labels.includes("商家滿減"), "🔴 要認得 `fullReductionAmount`");
  const full = r.row!.platform_fees.find((f) => f.label === "商家滿減");
  assert.equal(full!.amount, -6);
  assert.ok(labels.includes("商家配送費減免"), "🔴 要認得 `merchantDeliveryAmount`");

  const feeSum = r.row!.platform_fees.reduce((n, x) => (x.excluded ? n : n + x.amount), 0);
  assert.equal(r.row!.subtotal + feeSum - r.row!.discount_amount, r.row!.total);
  assert.equal(r.row!.discount_amount, 0, "逐項齊全 → 殘差 0");
});

test("零費用唔會出現空行（amount === 0 一律略過）", () => {
  const order: GrabberOrder = {
    source: "mfood",
    externalOrderId: "X1",
    amount: {
      businessAmount: 100,
      boxFee: 0,
      plasticBagFee: 0,
      serviceFee: 0,
      voucherAmtn: 0,
      fullReductionAmtn: 0,
    },
    items: [{ displayName: "某菜", quantity: 1, unitPrice: 100 }],
  };
  const r = projectGrabberOrder({ order, storeId: "s" });
  assert.deepEqual(r.row!.platform_fees, [], "全部係 0 → 唔應該有費用行");
});
