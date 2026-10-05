/**
 * 「返結帳」清單邏輯守衛（2026-10-05，跨機返結失聯修復）。
 *
 * 對應 bug：商家喺 A 機撳返結，B 機桌台總覽冇任何重結入口
 * （temp 枱唔上雲 → B 機 `floors` 冇對應枱 → 枱 grid 對唔上任何卡）。
 *
 * 呢個 test 守住「區塊由 `reopened` 單砌出嚟」嘅口徑，唔會隨時光退化成空殼。
 */

import { test as it, describe } from "node:test";
import assert from "node:assert/strict";

import {
  reopenAccountRows,
  reopenAccountCount,
  excludeRowsWithLocalTempTable,
  type ReopenListOrder,
} from "./reopen-account-rows.ts";

/** 常用 fixture 快捷方式。 */
function order(over: Partial<ReopenListOrder> = {}): ReopenListOrder {
  return {
    id: "o1",
    localOrderNo: "訂單1",
    tableId: "temp-reopen-o1",
    tableName: "返結 A01",
    status: "reopened",
    total: 101,
    reopenCount: 1,
    reopenedAt: "2026-10-05T11:46:00.000Z",
    reopenReason: "加錯菜",
    ...over,
  };
}

describe("reopenAccountRows", () => {
  it("只認 status === 'reopened'：其他狀態一律唔入清單", () => {
    const rows = reopenAccountRows([
      order({ id: "a", status: "reopened" }),
      order({ id: "b", status: "settled" }),
      order({ id: "c", status: "paid" }),
      order({ id: "d", status: "sent_to_kitchen" }),
      order({ id: "e", status: "draft" }),
      order({ id: "f", status: "cancelled" }),
      order({ id: "g", status: "refunded" }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "a");
  });

  it("🔴 核心樣式：跨機（冇原枱欄位）時原枱 id 為空 → 只靠 tableName 兜底", () => {
    // 0063 未跑 migration，或者返結時冇 temp 枱（降級路徑）。
    const [row] = reopenAccountRows([order()]);
    assert.equal(row.tableLabel, "返結 A01");
    assert.equal(row.hasOriginalTable, false, "冇原枱欄位就唔可以話有原枱");
  });

  it("0063 有值 → 顯示原枱名（A01）而唔係 temp 枱名（返結 A01）", () => {
    const [row] = reopenAccountRows([
      order({ reopenOriginalTableId: "A01", reopenOriginalTableName: "A01" }),
    ]);
    assert.equal(row.tableLabel, "A01");
    assert.equal(row.hasOriginalTable, true);
  });

  it("原枱名缺席但有原枱 id → 顯示 id，hasOriginalTable 仍然 true", () => {
    const [row] = reopenAccountRows([order({ reopenOriginalTableId: "B07" })]);
    assert.equal(row.tableLabel, "B07");
    assert.equal(row.hasOriginalTable, true);
  });

  it("原枱欄位有值 → 優先過 temp 枱名（跨機重結靠原枱，UI 應該講原枱）", () => {
    const [row] = reopenAccountRows([
      order({
        tableId: "temp-reopen-o1",
        tableName: "返結 A01",
        reopenOriginalTableId: "A01",
        reopenOriginalTableName: "A01",
      }),
    ]);
    assert.equal(row.tableLabel, "A01", "原枱名一定要贏過 temp 枱名");
  });

  it("🔴 排序：最近返結嘅排前面（唔係單號、唔係 createdAt）", () => {
    const rows = reopenAccountRows([
      order({ id: "old", localOrderNo: "A", reopenedAt: "2026-10-01T10:00:00.000Z" }),
      order({ id: "new", localOrderNo: "Z", reopenedAt: "2026-10-05T11:46:00.000Z" }),
      order({ id: "mid", localOrderNo: "M", reopenedAt: "2026-10-03T10:00:00.000Z" }),
    ]);
    assert.deepEqual(rows.map((r) => r.id), ["new", "mid", "old"]);
  });

  it("排序穩定：冇時間嘅單唔會令每次 render 順序跳動", () => {
    const build = () => [
      order({ id: "x", localOrderNo: "X", reopenedAt: "" }),
      order({ id: "y", localOrderNo: "Y", reopenedAt: "" }),
      order({ id: "z", localOrderNo: "Z", reopenedAt: "" }),
    ];
    const first = reopenAccountRows(build()).map((r) => r.id);
    const second = reopenAccountRows(build().reverse()).map((r) => r.id);
    assert.deepEqual(first, second, "同 timestamp（0）時要靠單號做全序");
    assert.deepEqual(first, ["x", "y", "z"]);
  });

  it("單號缺失 → 退回 id（唔可以顯示空白令店员以為壞咗）", () => {
    const [row] = reopenAccountRows([order({ id: "uuid-1", localOrderNo: "" })]);
    assert.equal(row.orderNo, "uuid-1");
  });

  it("枱名全部缺失 → 顯示「—」而唔係空字串", () => {
    const [row] = reopenAccountRows([
      order({ tableId: "", tableName: "", reopenOriginalTableId: "", reopenOriginalTableName: "" }),
    ]);
    assert.equal(row.tableLabel, "—");
  });

  it("金額：字串／null／負數都唔會令顯示 NaN 或 undefined", () => {
    const rows = reopenAccountRows([
      order({ id: "s", total: "35.11" as unknown as number }),
      order({ id: "n", total: null }),
      order({ id: "u", total: undefined }),
      order({ id: "f", total: 10.005 }),
    ]);
    assert.equal(rows.find((r) => r.id === "s")!.total, 35.11);
    assert.equal(rows.find((r) => r.id === "n")!.total, 0);
    assert.equal(rows.find((r) => r.id === "u")!.total, 0);
    // 四捨五入到分（避免 10.005 顯示成 10.005000000000001）
    assert.equal(rows.find((r) => r.id === "f")!.total, 10.01);
    for (const r of rows) assert.ok(Number.isFinite(r.total));
  });

  it("reopenCount：0／負數／NaN → undefined（唔會出現「已返結 ×0」）", () => {
    const rows = reopenAccountRows([
      order({ id: "z", reopenCount: 0 }),
      order({ id: "n", reopenCount: -3 }),
      order({ id: "nan", reopenCount: Number.NaN }),
      order({ id: "u", reopenCount: undefined }),
      order({ id: "ok", reopenCount: 2 }),
    ]);
    assert.equal(rows.find((r) => r.id === "z")!.reopenCount, undefined);
    assert.equal(rows.find((r) => r.id === "n")!.reopenCount, undefined);
    assert.equal(rows.find((r) => r.id === "nan")!.reopenCount, undefined);
    assert.equal(rows.find((r) => r.id === "u")!.reopenCount, undefined);
    assert.equal(rows.find((r) => r.id === "ok")!.reopenCount, 2);
  });

  it("原因 / 時間缺失 → 空字串（由 UI 決定隱藏，唔可以係 undefined 触发 crash）", () => {
    const [row] = reopenAccountRows([order({ reopenReason: undefined, reopenedAt: undefined })]);
    assert.equal(row.reopenReason, "");
    assert.equal(row.reopenedAt, "");
  });

  it("邊欄位都 trim：避免空白字串令枱名格撐爆", () => {
    const [row] = reopenAccountRows([
      order({ reopenOriginalTableName: "   A01   ", tableName: "  返結 A01  " }),
    ]);
    assert.equal(row.tableLabel, "A01");
  });

  it("壞資料唔會令整個區塊爆：null / undefined / 陣列含 null", () => {
    const rows = reopenAccountRows([
      null as unknown as ReopenListOrder,
      order({ id: "real" }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "real");
    assert.deepEqual(reopenAccountRows(null), []);
    assert.deepEqual(reopenAccountRows(undefined), []);
    assert.deepEqual(reopenAccountRows([]), []);
  });
});

describe("reopenAccountCount", () => {
  it("同 rows 長度一致（標題數字唔可以同實際行數對唔上）", () => {
    const orders = [
      order({ id: "a" }),
      order({ id: "b", status: "settled" }),
      order({ id: "c" }),
    ];
    assert.equal(reopenAccountCount(orders), 2);
    assert.equal(reopenAccountCount(orders), reopenAccountRows(orders).length);
  });

  it("冇返結單 → 0（嗰陣 UI 應該整卡唔 render，唔係 render 空卡）", () => {
    assert.equal(reopenAccountCount([order({ status: "settled" })]), 0);
    assert.equal(reopenAccountCount(null), 0);
  });
});

/**
 * 🔴 方案 C 守衛（2026-10-05）：返結卡同枱格共用同一個 grid ⇒ 唔排除「本機已有
 * temp 枱」嘅單，就會同一個 grid 出現兩張指向同一 order.id 嘅卡（似兩張未結單）。
 */
describe("excludeRowsWithLocalTempTable（方案 C：避免同一單喺 grid 出現兩次）", () => {
  it("本機有 temp 枱嘅單 → 排除（下單機用 temp 枱做入口，既有行為）", () => {
    const rows = reopenAccountRows([order({ id: "a" }), order({ id: "b" })]);
    const out = excludeRowsWithLocalTempTable(rows, ["a"]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "b");
  });

  it("跨機（冇任何 temp 枱）→ 全部保留（呢個正正係修復目標，唔可以過度排除）", () => {
    const rows = reopenAccountRows([order({ id: "a" }), order({ id: "b" })]);
    assert.equal(excludeRowsWithLocalTempTable(rows, []).length, 2);
    assert.equal(excludeRowsWithLocalTempTable(rows, null).length, 2);
    assert.equal(excludeRowsWithLocalTempTable(rows, undefined).length, 2);
  });

  it("temp 枱全部對應到 → 清單變空（UI 靠 length=0 整段唔 render）", () => {
    const rows = reopenAccountRows([order({ id: "a" })]);
    assert.equal(excludeRowsWithLocalTempTable(rows, ["a"]).length, 0);
  });

  it("唔可以改動原陣列（caller 可能重用）", () => {
    const rows = reopenAccountRows([order({ id: "a" }), order({ id: "b" })]);
    const out = excludeRowsWithLocalTempTable(rows, ["a"]);
    assert.equal(rows.length, 2);
    assert.notEqual(out, rows);
  });

  it("temp 單 id 有空白／空字串 → 忽略，唔可以因為空白而誤排除", () => {
    const rows = reopenAccountRows([order({ id: "a" })]);
    assert.equal(excludeRowsWithLocalTempTable(rows, ["", "   "]).length, 1);
  });

  it("rows 係 null／undefined → 回空陣列（唔可以 crash）", () => {
    assert.deepEqual(excludeRowsWithLocalTempTable(null, ["a"]), []);
    assert.deepEqual(excludeRowsWithLocalTempTable(undefined, ["a"]), []);
  });

  it("排除係按 order.id 精準配對，唔可以掃到其他單", () => {
    const rows = reopenAccountRows([order({ id: "a" }), order({ id: "ab" })]);
    const out = excludeRowsWithLocalTempTable(rows, ["a"]);
    assert.deepEqual(out.map((r) => r.id), ["ab"]);
  });
});
