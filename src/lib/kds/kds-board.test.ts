import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OrderItem, PosOrder } from "../types.ts";
import { orderItemKey } from "../pos/order-item-diff.ts";
import { buildKdsBoard, remainingQtyOf } from "./kds-board.ts";
import type { KdsBoardOrderInput, KdsItemStateRow } from "./types.ts";

/**
 * 後廚屏砌板規則（docs/116 §3.2 / §4.4 / §5 / §6.2）。
 *
 * 呢度每一條錯咗都係**靜默**失效（屏照出，但數字／內容錯），所以全部鎖死。
 * 最緊要嘅三條：
 *   1. 唔指定工位一定要回空 —— 否則「全部」模式會回歸。
 *   2. 加單（qty 1→3、done 1）要仍然顯示仲欠 2 —— 呢個係 `done_qty` vs boolean 嘅核心。
 *   3. 同一 `itemKey` 出現兩次要合併 —— 時價菜會撞 key，唔合併就寫唔到完成狀態。
 */

const BASE_ISO = "2026-09-11T06:00:00.000Z";
const BASE_MS = Date.parse(BASE_ISO);
const NOW_MS = BASE_MS + 60_000; // 落單 1 分鐘後

function item(over: Partial<OrderItem> = {}): OrderItem {
  return {
    menuItemId: "m1",
    name: "叉燒飯",
    quantity: 1,
    price: 50,
    printerGroup: "kitchen",
    ...over,
  };
}

function order(over: Partial<PosOrder> = {}): PosOrder {
  return {
    id: "ord1",
    localOrderNo: "A001",
    tableId: "counter",
    tableName: "自取",
    status: "sent_to_kitchen",
    items: [],
    subtotal: 0,
    taxAmount: 0,
    serviceChargeAmount: 0,
    discountAmount: 0,
    total: 0,
    createdAt: BASE_ISO,
    updatedAt: BASE_ISO,
    sentToKitchenAt: BASE_ISO,
    ...over,
  };
}

/** 用**真**嘅 `orderItemKey()` 算 key（唔可以喺測試自己砌，否則測唔到口徑一致）。 */
function entry(o: PosOrder): KdsBoardOrderInput {
  return { order: o, itemKeys: (o.items ?? []).map(orderItemKey) };
}

function state(orderId: string, itemKey: string, doneQty: number): KdsItemStateRow {
  return { order_id: orderId, item_key: itemKey, done_qty: doneQty };
}

function build(
  orders: PosOrder[],
  states: KdsItemStateRow[] = [],
  extra: Partial<Parameters<typeof buildKdsBoard>[0]> = {},
) {
  return buildKdsBoard({
    orders: orders.map(entry),
    states,
    station: "kitchen",
    serverNowMs: NOW_MS,
    serverTime: BASE_ISO,
    ...extra,
  });
}

describe("buildKdsBoard · 工位過濾", () => {
  it("只回本工位嘅行", () => {
    const o = order({
      items: [
        item({ menuItemId: "m1", name: "乾炒牛河", printerGroup: "kitchen" }),
        item({ menuItemId: "m2", name: "凍檸茶", printerGroup: "drinks" }),
      ],
    });
    const res = build([o]);
    assert.equal(res.orders.length, 1);
    assert.deepEqual(res.orders[0].items.map((i) => i.name), ["乾炒牛河"]);
  });

  it("本工位一行都冇 → 整張單唔上屏", () => {
    const o = order({ items: [item({ name: "凍檸茶", printerGroup: "drinks" })] });
    assert.equal(build([o]).orders.length, 0);
  });

  it("🔴 唔傳 station → 一律回空（防止「全部」模式回歸）", () => {
    const o = order({ items: [item()] });
    const res = buildKdsBoard({
      orders: [entry(o)],
      states: [],
      station: null,
      serverNowMs: NOW_MS,
      serverTime: BASE_ISO,
    });
    assert.deepEqual(res.orders, []);
    // 但 stations 仍然要回，唔係「揀崗位」畫面就冇嘢用
    assert.ok(res.stations.length >= 1);
  });

  it("明確 allowAllStations 就回全部（出餐台屏用）", () => {
    const o = order({ items: [item({ name: "凍檸茶", printerGroup: "drinks" })] });
    const res = build([o], [], { station: null, allowAllStations: true });
    assert.equal(res.orders.length, 1);
  });
});

describe("buildKdsBoard · done_qty 語意", () => {
  it("部分完成：done 1 / qty 3 → 仍然上屏", () => {
    const o = order({ items: [item({ quantity: 3 })] });
    const res = build([o], [state("ord1", orderItemKey(o.items[0]), 1)]);
    assert.equal(res.orders[0].items[0].doneQty, 1);
    assert.equal(remainingQtyOf(res.orders[0].items), 2);
  });

  it("🔴 加單：原本 x1 已完成，加到 x3 → 一定要重新亮起（唔可以靜默漏單）", () => {
    const o = order({ items: [item({ quantity: 3 })] });
    const res = build([o], [state("ord1", orderItemKey(o.items[0]), 1)]);
    assert.equal(res.orders.length, 1, "加單之後張單一定要重返屏上");
    assert.equal(res.orders[0].items[0].doneQty, 1);
    assert.equal(res.orders[0].items[0].quantity, 3);
  });

  it("done_qty 大過 quantity（減件）→ clamp 落 quantity", () => {
    const o = order({ items: [item({ quantity: 2 })] });
    const res = build([o], [state("ord1", orderItemKey(o.items[0]), 9)], {
      includeCompleted: true,
    });
    assert.equal(res.orders[0].items[0].doneQty, 2);
    assert.equal(remainingQtyOf(res.orders[0].items), 0);
  });

  it("done_qty 負數 → 夾做 0", () => {
    const o = order({ items: [item({ quantity: 1 })] });
    const res = build([o], [state("ord1", orderItemKey(o.items[0]), -5)]);
    assert.equal(res.orders[0].items[0].doneQty, 0);
  });

  it("冇狀態行 → doneQty 0", () => {
    const o = order({ items: [item()] });
    assert.equal(build([o]).orders[0].items[0].doneQty, 0);
  });
});

describe("buildKdsBoard · 合併與排除", () => {
  it("🔴 同一 itemKey 出現兩行（時價菜）→ 合併成一行，數量相加", () => {
    // 時價菜每次落單都係獨立一行，同價 + 同規格 + 冇備註 → 撞同一個 key
    const line = item({ menuItemId: "seafood", name: "蒸魚", price: 188 });
    const o = order({ items: [{ ...line }, { ...line }] });
    assert.equal(orderItemKey(o.items[0]), orderItemKey(o.items[1]), "前提：兩行真係撞 key");

    const res = build([o]);
    assert.equal(res.orders[0].items.length, 1, "撞 key 一定要合併，唔可以出兩行");
    assert.equal(res.orders[0].items[0].quantity, 2);
  });

  it("撞 key 時 done_qty 對嘅係合併後嘅總數", () => {
    const line = item({ menuItemId: "seafood", name: "蒸魚", price: 188 });
    const o = order({ items: [{ ...line }, { ...line }] });
    const res = build([o], [state("ord1", orderItemKey(line), 1)]);
    assert.equal(res.orders[0].items[0].doneQty, 1);
    assert.equal(remainingQtyOf(res.orders[0].items), 1);
  });

  it("退菜（voided）唔上屏", () => {
    const o = order({
      items: [item({ name: "退咗嘅菜", voided: true }), item({ name: "正常菜" })],
    });
    assert.deepEqual(build([o]).orders[0].items.map((i) => i.name), ["正常菜"]);
  });

  it("receipt / label 唔係工位，唔上屏", () => {
    const o = order({
      items: [
        item({ menuItemId: "r", name: "收據", printerGroup: "receipt" }),
        item({ menuItemId: "l", name: "杯貼", printerGroup: "label" }),
        item({ menuItemId: "k", name: "叉燒飯", printerGroup: "kitchen" }),
      ],
    });
    assert.deepEqual(build([o]).orders[0].items.map((i) => i.name), ["叉燒飯"]);
  });

  it("quantity <= 0 嘅行唔上屏", () => {
    const o = order({
      items: [
        item({ menuItemId: "z", name: "零件", quantity: 0 }),
        item({ menuItemId: "n", name: "正常" }),
      ],
    });
    assert.deepEqual(build([o]).orders[0].items.map((i) => i.name), ["正常"]);
  });

  it("規格譯成 optionLabel", () => {
    const o = order({
      items: [
        item({
          selectedSpecs: [
            { groupId: "g1", groupName: "份量", optionId: "o1", optionLabel: "大", priceDelta: 5 },
            { groupId: "g2", groupName: "冰", optionId: "o2", optionLabel: "少冰", priceDelta: 0 },
          ],
        }),
      ],
    });
    assert.deepEqual(build([o]).orders[0].items[0].specs, ["大", "少冰"]);
  });
});

describe("buildKdsBoard · 上屏資格", () => {
  it("🔴 冇 sentToKitchenAt（仲係 draft）→ 唔上屏", () => {
    // 有菜品、有 items，但未真正落廚房 → 唔可以上屏（師傅會做咗未確認嘅菜）
    const o = order({ status: "draft", sentToKitchenAt: undefined, items: [item({ menuItemId: "k" })] });
    assert.equal(build([o]).orders.length, 0);
  });

  it("已結帳（settled）→ 唔上屏", () => {
    const o = order({ status: "settled", items: [item({ menuItemId: "k" })] });
    assert.equal(build([o]).orders.length, 0);
  });

  it("已取消 → 唔上屏", () => {
    assert.equal(
      build([order({ status: "cancelled", items: [item({ menuItemId: "c" })] })]).orders.length,
      0,
    );
  });

  it("已付款但未出餐（paid）→ 要上屏（錢收咗但飯未做）", () => {
    assert.equal(
      build([order({ status: "paid", items: [item({ menuItemId: "p" })] })]).orders.length,
      1,
    );
  });

  it("超過 12 小時冇人動過 → 唔上屏", () => {
    const stale = new Date(BASE_MS - 13 * 60 * 60 * 1000).toISOString();
    const o = order({
      sentToKitchenAt: stale,
      updatedAt: stale,
      items: [item({ menuItemId: "k" })],
    });
    assert.equal(build([o]).orders.length, 0);
  });

  it("落單超過 12 小時、但啱啱加咗菜（updated_at 新）→ 仍然要上屏", () => {
    // 用 updated_at 而唔係 sentToKitchenAt 做窗口：酒樓長時間嘅單加菜唔應該消失
    const o = order({
      sentToKitchenAt: new Date(BASE_MS - 13 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(BASE_MS - 30_000).toISOString(),
      items: [item({ menuItemId: "k" })],
    });
    assert.equal(build([o]).orders.length, 1);
  });

  it("全部完成 → 預設唔回（reload 之後唔應該再見到綠色卡）", () => {
    const o = order({ items: [item({ menuItemId: "k", quantity: 2 })] });
    const res = build([o], [state("ord1", orderItemKey(o.items[0]), 2)]);
    assert.equal(res.orders.length, 0);
  });

  it("includeCompleted → 回（出餐台屏核對用）", () => {
    const o = order({ items: [item({ menuItemId: "k", quantity: 2 })] });
    const res = build([o], [state("ord1", orderItemKey(o.items[0]), 2)], {
      includeCompleted: true,
    });
    assert.equal(res.orders.length, 1);
  });

  it("🔴 一張單有兩個工位：本工位做完、另一個未做 → 本工位唔應該再見到張卡", () => {
    const o = order({
      items: [
        item({ menuItemId: "k", name: "炒飯", printerGroup: "kitchen", quantity: 1 }),
        item({ menuItemId: "d", name: "凍檸茶", printerGroup: "drinks", quantity: 1 }),
      ],
    });
    // 廚房嗰碟做完；水吧未做 → 廚房屏應該冇嘢做，唔應該留住一張綠色卡
    const res = build([o], [state("ord1", orderItemKey(o.items[0]), 1)]);
    assert.equal(res.orders.length, 0);
    // 但水吧嗰邊仍然要見到
    const drinksView = build([o], [state("ord1", orderItemKey(o.items[0]), 1)], {
      station: "drinks",
    });
    assert.equal(drinksView.orders.length, 1);
    assert.deepEqual(drinksView.orders[0].items.map((i) => i.name), ["凍檸茶"]);
  });
});

describe("buildKdsBoard · 排序與統計", () => {
  it("舊單行先", () => {
    const early = order({
      id: "early",
      sentToKitchenAt: new Date(BASE_MS - 300_000).toISOString(),
      items: [item({ menuItemId: "e" })],
    });
    const late = order({
      id: "late",
      sentToKitchenAt: new Date(BASE_MS - 10_000).toISOString(),
      items: [item({ menuItemId: "l" })],
    });
    const res = build([late, early]);
    assert.deepEqual(res.orders.map((o) => o.id), ["early", "late"]);
  });

  it("pending 用**未完成份數**，而且跨全部工位（唔扣 station 過濾）", () => {
    const o = order({
      items: [
        item({ menuItemId: "k", name: "炒飯", printerGroup: "kitchen", quantity: 3 }),
        item({ menuItemId: "d", name: "凍檸茶", printerGroup: "drinks", quantity: 2 }),
      ],
    });
    // 炒飯出咗 1 件 → kitchen 仲欠 2；凍檸茶出咗 0 → drinks 仲欠 2
    const res = build([o], [state("ord1", orderItemKey(o.items[0]), 1)]);
    const byId = Object.fromEntries(res.stations.map((s) => [s.id, s.pending]));
    assert.equal(byId.kitchen, 2);
    assert.equal(byId.drinks, 2);
  });

  it("已完成嘅行唔計入 pending", () => {
    const o = order({ items: [item({ quantity: 2 })] });
    const res = build([o], [state("ord1", orderItemKey(o.items[0]), 2)], {
      includeCompleted: true,
    });
    const byId = Object.fromEntries(res.stations.map((s) => [s.id, s.pending]));
    assert.equal(byId.kitchen, 0);
  });

  it("🔴 stations 主來源係商家 printZones（後廚1/2/3、水吧1/2/3 各自獨立）", () => {
    const res = build([], [], {
      printZones: [
        { id: "後廚1", name: "後廚1" },
        { id: "後廚2", name: "後廚2" },
        { id: "後廚3", name: "後廚3" },
        { id: "水吧1", name: "水吧1" },
        { id: "水吧2", name: "水吧2" },
        { id: "水吧3", name: "水吧3" },
      ],
    });
    assert.deepEqual(res.stations.map((s) => s.name), [
      "後廚1",
      "後廚2",
      "後廚3",
      "水吧1",
      "水吧2",
      "水吧3",
    ]);
  });

  it("舊 printerGroups 只做 fallback（剔走 receipt / label）", () => {
    const res = build([], [], { printerGroups: ["kitchen", "drinks", "receipt", "label"] });
    assert.deepEqual(res.stations.map((s) => s.id), ["kitchen", "drinks"]);
  });

  it("訂單出現過嘅工位一定會入清單（即使 printerGroups 係空）", () => {
    const o = order({ items: [item({ menuItemId: "d", printerGroup: "drinks" })] });
    const res = build([o], [], { station: "drinks", printerGroups: [] });
    assert.deepEqual(res.stations.map((s) => s.id), ["drinks"]);
  });

  it("stations 唔會夾硬塞入綁定嘅分區（要反映真實清單）", () => {
    // 綁定咗「炸爐」但店根本冇呢個分區（printZones / 菜單 / 單都冇）→
    // 清單唔應該出現「炸爐」。客戶端**唔會**因為咁而自動彈返揀崗位
    // （見 kitchen-screen.tsx）—— 掛喺牆上嘅屏唔應該無啦啦跳去揀崗位。
    const res = build([], [], { station: "炸爐", printerGroups: [], menuItemGroups: [] });
    assert.ok(!res.stations.some((s) => s.id === "炸爐"));
    assert.deepEqual(res.stations, []);
  });

  it("冇 printZones、冇單、冇菜單 → 回空清單（UI 顯示「未設定打印分區」）", () => {
    // ⚠️ 刻意**唔**造假 fallback（以前係硬編碼「廚房」）：屏上顯示一個商家冇設定過
    // 嘅分區，比顯示「請去設定分區」更差 —— 師傅會揀咗一個永遠冇出品嘅崗位。
    const res = build([], [], { printerGroups: [], menuItemGroups: [] });
    assert.deepEqual(res.stations, []);
  });
});

describe("remainingQtyOf", () => {
  it("加總所有行嘅未完成份數", () => {
    assert.equal(
      remainingQtyOf([
        { itemKey: "a", name: "a", quantity: 3, station: "kitchen", specs: [], doneQty: 1 },
        { itemKey: "b", name: "b", quantity: 2, station: "kitchen", specs: [], doneQty: 2 },
      ]),
      2,
    );
  });

  it("空陣列 → 0", () => {
    assert.equal(remainingQtyOf([]), 0);
  });
});
