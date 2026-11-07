// 訂位核心純函數測試 —— 營業日、時段、預點菜計價與入座映射。
//
// 呢三個模組係整個功能的正確性基礎：
//   · 營業日算錯 → 凌晨訂位去錯日、報表對唔上
//   · 時段算錯 → 可訂窗口錯、客人訂到打烊後
//   · 計價算錯 → 預付金額錯、到店差額對唔上
// 所以全部用純函數 + 固定輸入測試，唔依賴系統時區或當前時間。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bizDateWindow,
  parseHm,
  reservationBizDate,
  shiftYmd,
  ymdWeekday,
} from "./biz-date.ts";
import { buildDaySlots, generateSlotTimes, rangeToDates } from "./slots.ts";
import {
  computeReservationTotals,
  itemNetPrice,
  mapItemsForSeat,
  sanitizeReservationItems,
} from "./items.ts";
import type { ReservationItem, ServiceHours } from "./types.ts";

/** 全週同一時段，避免測試依賴某一日係星期幾。 */
function everyDay(open: string, close: string): ServiceHours {
  const hours: ServiceHours = {};
  for (let d = 1; d <= 7; d += 1) hours[String(d)] = { open, close };
  return hours;
}

describe("營業日 biz_date", () => {
  it("非跨日：晚上 19:30 屬於當天", () => {
    // 2026-11-06 19:30 澳門 = 11:30Z
    const at = new Date("2026-11-06T11:30:00Z");
    assert.equal(reservationBizDate(at, everyDay("11:00", "22:30")), "2026-11-06");
  });

  it("跨日：凌晨 01:30 屬於前一天", () => {
    // 2026-11-07 01:30 澳門 = 2026-11-06 17:30Z
    const at = new Date("2026-11-06T17:30:00Z");
    assert.equal(reservationBizDate(at, everyDay("17:30", "02:00")), "2026-11-06");
  });

  it("跨日：凌晨 02:30 已過打烊 → 回當天（fallback，不 throw）", () => {
    // 澳門 11-07 02:30。已超出 17:30–02:00 的服務窗口，無法判斷是否夜宵遲到，
    // 所以保守回「當天」。實際上這個時刻根本不會被生成成可訂時段。
    const at = new Date("2026-11-06T18:30:00Z");
    assert.equal(reservationBizDate(at, everyDay("17:30", "02:00")), "2026-11-07");
  });

  it("跨日：當天 18:00 屬於當天", () => {
    const at = new Date("2026-11-06T10:00:00Z"); // 澳門 11-06 18:00
    assert.equal(reservationBizDate(at, everyDay("17:30", "02:00")), "2026-11-06");
  });

  it("沒有設定時段時回當天", () => {
    const at = new Date("2026-11-06T11:30:00Z");
    assert.equal(reservationBizDate(at, {}), "2026-11-06");
  });

  it("接受 ISO 字串輸入", () => {
    assert.equal(
      reservationBizDate("2026-11-06T11:30:00Z", everyDay("11:00", "22:30")),
      "2026-11-06",
    );
  });
});

describe("日期工具", () => {
  it("shiftYmd 跨月", () => {
    assert.equal(shiftYmd("2026-01-31", 1), "2026-02-01");
    assert.equal(shiftYmd("2026-03-01", -1), "2026-02-28");
  });

  it("ymdWeekday 回 ISO 星期（1=週一，7=週日）", () => {
    assert.equal(ymdWeekday("2026-11-02"), 1); // 週一
    assert.equal(ymdWeekday("2026-11-08"), 7); // 週日
  });

  it("parseHm 容錯", () => {
    assert.equal(parseHm("17:30"), 1050);
    assert.equal(parseHm("7:05"), 425);
    assert.equal(parseHm(""), null);
    assert.equal(parseHm("abc"), null);
  });
});

describe("服務窗口", () => {
  it("跨日窗口的 end 落在下一個自然日", () => {
    const win = bizDateWindow("2026-11-06", everyDay("17:30", "02:00"));
    assert.ok(win);
    assert.equal(win.crossDay, true);
    // 17:30 澳門 = 09:30Z
    assert.equal(win.start.toISOString(), "2026-11-06T09:30:00.000Z");
    // 翌日 02:00 澳門 = 前一日 18:00Z
    assert.equal(win.end.toISOString(), "2026-11-06T18:00:00.000Z");
  });

  it("非跨日窗口時長正確", () => {
    const win = bizDateWindow("2026-11-06", everyDay("11:30", "22:30"));
    assert.ok(win);
    assert.equal(win.crossDay, false);
    assert.equal((win.end.getTime() - win.start.getTime()) / 60_000, 660);
  });
});

describe("時段生成", () => {
  it("17:30–22:30 每 30 分鐘 = 10 格", () => {
    const slots = generateSlotTimes("2026-11-06", everyDay("17:30", "22:30"), 30);
    assert.equal(slots.length, 10);
    assert.equal(slots[0]?.toISOString(), "2026-11-06T09:30:00.000Z"); // 17:30 澳門
    assert.equal(slots[9]?.toISOString(), "2026-11-06T14:00:00.000Z"); // 22:00 澳門
  });

  it("跨日 17:30–02:00 每 60 分鐘 = 9 格（17:30 … 翌日 01:30）", () => {
    const slots = generateSlotTimes("2026-11-06", everyDay("17:30", "02:00"), 60);
    assert.equal(slots.length, 9);
    assert.equal(slots[8]?.toISOString(), "2026-11-06T17:30:00.000Z"); // 翌日 01:30 澳門
  });

  it("沒有時段設定回空陣列", () => {
    assert.deepEqual(generateSlotTimes("2026-11-06", {}, 30), []);
  });
});

describe("時段餘量", () => {
  const settings = {
    serviceHours: everyDay("17:30", "22:30"),
    slotIntervalMinutes: 30,
    slotQuota: 2,
    leadMinutesMin: 0,
  };
  const now = new Date("2026-11-06T09:00:00Z"); // 澳門 17:00，全部時段都在未來

  it("已用 2 組 → 該格 full", () => {
    const used = [
      { slotAt: "2026-11-06T10:00:00.000Z", used: 2, guests: 8 }, // 18:00
    ];
    const slots = buildDaySlots({ bizDate: "2026-11-06", settings, usage: used, now });
    const target = slots.find((s) => s.slotAt === "2026-11-06T10:00:00.000Z");
    assert.ok(target);
    assert.equal(target.remaining, 0);
    assert.equal(target.full, true);
    assert.equal(target.label, "18:00");
  });

  it("已用 1 組 → 剩 1 組", () => {
    const used = [{ slotAt: "2026-11-06T10:00:00.000Z", used: 1, guests: 4 }];
    const slots = buildDaySlots({ bizDate: "2026-11-06", settings, usage: used, now });
    const target = slots.find((s) => s.slotAt === "2026-11-06T10:00:00.000Z");
    assert.equal(target?.remaining, 1);
    assert.equal(target?.full, false);
  });

  it("已過時間的時段標 past", () => {
    const lateNow = new Date("2026-11-06T12:00:00Z"); // 澳門 20:00
    const slots = buildDaySlots({ bizDate: "2026-11-06", settings, usage: [], now: lateNow });
    const early = slots.find((s) => s.slotAt === "2026-11-06T09:30:00.000Z"); // 17:30
    assert.equal(early?.past, true);
    const later = slots.find((s) => s.slotAt === "2026-11-06T13:00:00.000Z"); // 21:00
    assert.equal(later?.past, false);
  });
});

describe("日期範圍換算", () => {
  it("today / tomorrow / 7d / 30d", () => {
    assert.deepEqual(rangeToDates("today", "2026-11-06"), { from: "2026-11-06", to: "2026-11-06" });
    assert.deepEqual(rangeToDates("tomorrow", "2026-11-06"), { from: "2026-11-07", to: "2026-11-07" });
    assert.deepEqual(rangeToDates("7d", "2026-11-06"), { from: "2026-11-06", to: "2026-11-12" });
    assert.deepEqual(rangeToDates("30d", "2026-11-06"), { from: "2026-11-06", to: "2026-12-05" });
    assert.deepEqual(rangeToDates("all", "2026-11-06"), { from: null, to: null });
  });
});

function makeItem(over: Partial<ReservationItem>): ReservationItem {
  return {
    menuItemId: "m1",
    name: "蜜汁叉燒",
    specText: "",
    specs: {},
    qty: 1,
    unitPrice: 100,
    memberPrice: null,
    discountRate: null,
    snapshotAt: "2026-11-06T02:00:00.000Z",
    ...over,
  };
}

describe("預點菜計價", () => {
  it("單品會員價優先於全店折扣", () => {
    assert.equal(itemNetPrice({ unitPrice: 100, memberPrice: 79, discountRate: 90 }), 79);
  });

  it("沒有會員價時用折扣率", () => {
    assert.equal(itemNetPrice({ unitPrice: 88, memberPrice: null, discountRate: 90 }), 79.2);
  });

  it("無折扣時回原價", () => {
    assert.equal(itemNetPrice({ unitPrice: 88, memberPrice: null, discountRate: null }), 88);
  });

  it("折扣率 100 視為無折扣", () => {
    assert.equal(itemNetPrice({ unitPrice: 88, memberPrice: null, discountRate: 100 }), 88);
  });

  it("合計：原價、折扣、應付", () => {
    const totals = computeReservationTotals([
      makeItem({ unitPrice: 88, qty: 1, discountRate: 90 }),
      makeItem({ unitPrice: 98, qty: 1, discountRate: 90 }),
      makeItem({ unitPrice: 118, qty: 1, discountRate: 90 }),
    ]);
    assert.equal(totals.subtotal, 304);
    assert.equal(totals.payable, 273.6);
    assert.equal(totals.discount, 30.4);
    assert.equal(totals.qty, 3);
  });

  it("數量為 0 或負數的項目被忽略", () => {
    const totals = computeReservationTotals([makeItem({ qty: 0 }), makeItem({ qty: -2 })]);
    assert.equal(totals.qty, 0);
    assert.equal(totals.payable, 0);
  });
});

describe("入座映射（按當日菜牌重算）", () => {
  const items: ReservationItem[] = [
    makeItem({ menuItemId: "bbq", name: "蜜汁叉燒", unitPrice: 88, qty: 1, discountRate: 90 }),
    makeItem({ menuItemId: "fish", name: "椒鹽九肚魚", unitPrice: 98, qty: 1, discountRate: 90 }),
    makeItem({ menuItemId: "gone", name: "已下架菜", unitPrice: 60, qty: 1 }),
    makeItem({ menuItemId: "sold", name: "沽清菜", unitPrice: 70, qty: 1 }),
  ];

  const lookup = (id: string) => {
    if (id === "bbq") return { name: "蜜汁叉燒（例）", price: 92 }; // 今日加價
    if (id === "fish") return { name: "椒鹽九肚魚", price: 98 };
    if (id === "sold") return { name: "沽清菜", price: 70, soldOut: true };
    return null;
  };

  it("按今日價重算，並列出不可帶入的菜", () => {
    const plan = mapItemsForSeat({ items, discountRate: 90, lookup, paidAmount: 273 });
    assert.equal(plan.lines.length, 2);
    assert.equal(plan.lines[0]?.netPrice, 82.8); // 92 × 0.9
    assert.equal(plan.subtotal, 190); // 92 + 98
    assert.equal(plan.unavailable.length, 2);
    assert.equal(plan.unavailable.find((u) => u.menuItemId === "gone")?.reason, "gone");
    assert.equal(plan.unavailable.find((u) => u.menuItemId === "sold")?.reason, "soldout");
  });

  it("差額 = 當日應付 − 已預付（正數代表要補收）", () => {
    const plan = mapItemsForSeat({
      items: [makeItem({ menuItemId: "bbq", unitPrice: 88, qty: 1, discountRate: 90 })],
      discountRate: 90,
      lookup,
      paidAmount: 50,
    });
    assert.equal(plan.payable, 82.8);
    assert.equal(plan.delta, 32.8);
  });

  it("沒有預付時差額等於全額", () => {
    const plan = mapItemsForSeat({
      items: [makeItem({ menuItemId: "bbq", unitPrice: 88, qty: 1, discountRate: 90 })],
      discountRate: 90,
      lookup,
      paidAmount: 0,
    });
    assert.equal(plan.delta, 82.8);
  });
});

describe("外來輸入收斂", () => {
  it("剝走價格欄位，只保留 id / qty / specs", () => {
    const out = sanitizeReservationItems([
      { menuItemId: "m1", qty: 2, unitPrice: 0.01, name: "黑客價", specs: { ice: ["less"] } },
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
      menuItemId: "m1",
      qty: 2,
      specs: { ice: ["less"] },
      specText: "",
    });
    assert.equal("unitPrice" in (out[0] ?? {}), false);
  });

  it("無效項目被丟棄", () => {
    const out = sanitizeReservationItems([
      { menuItemId: "", qty: 1 },
      { menuItemId: "m2", qty: 0 },
      null,
      "x",
      { menuItemId: "m3", qty: 1 },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.menuItemId, "m3");
  });

  it("數量上限 99", () => {
    const out = sanitizeReservationItems([{ menuItemId: "m1", qty: 1000 }]);
    assert.equal(out[0]?.qty, 99);
  });
});
