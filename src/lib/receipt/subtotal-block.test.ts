import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSubtotalBlock, resolveExtraFee, roundMoney, splitPlatformFees } from "./subtotal-block.ts";

/**
 * 收據「原價合計」區塊 ＋ 殘差嘅不變式測試。
 *
 * 🔴 呢個測試係 2026-09-24 補嘅。之前呢兩個函式住喺 `escpos-template.ts`
 *    （有 `@/lib/...` runtime import）→ `node --test` 載唔到 → **零覆蓋**。
 *    結果係「外賣平台單嘅費用被印兩次」呢個 bug 一直冇被發現，
 *    直到加咗隨機假單先撞出來（兩張真實樣本啱啱好避開）。
 *
 * 不變式（收據上逐行加返必須等於「總計」）：
 *   原價合計 ＋ Σ計入營業額嘅費用 − 優惠合計 === 總計
 *
 * ⚠️ 只有平台單可以用 `assertAddsUp()`：平台單嘅服務費／稅／抹零／優惠合計
 *    全部係 0 → 嗰幾個模板區塊唔會印 → 「呢個區塊」就係收據上嘅全部金額行。
 *    店內單嘅服務費／稅／優惠／總計係**另外嘅區塊**，唔喺呢個區塊內。
 */

const f = (n: number) => String(n);

function render(
  parts: {
    subtotalBefore: number;
    serviceCharge?: number;
    tax?: number;
    rounding?: number;
    totalDiscount?: number;
    orderTotal: number;
  },
  fees?: Array<{ label: string; amount: number; excluded?: boolean }>,
): string[] {
  return buildSubtotalBlock(
    {
      subtotalBefore: parts.subtotalBefore,
      serviceCharge: parts.serviceCharge ?? 0,
      tax: parts.tax ?? 0,
      rounding: parts.rounding ?? 0,
      totalDiscount: parts.totalDiscount ?? 0,
      orderTotal: parts.orderTotal,
    },
    f,
    fees,
  ).split("\n");
}

/** 把「計入營業額」嘅行加返（略過「（以下不計入營業額）」之後嘅資訊行）。 */
function assertAddsUp(lines: string[], orderTotal: number, label: string) {
  assert.match(lines[0], /^原價合計: /, `${label}: 第一行唔係原價合計 → ${lines[0]}`);
  let sum = Number(lines[0].slice("原價合計: ".length));
  assert.ok(Number.isFinite(sum), `${label}: 原價合計唔係數字`);

  let excluded = false;
  for (const line of lines.slice(1)) {
    if (line === "（以下不計入營業額）") {
      excluded = true;
      continue;
    }
    if (excluded) continue;
    const idx = line.lastIndexOf(": ");
    assert.ok(idx > 0, `${label}: 認唔到嘅行 → ${line}`);
    sum += Number(line.slice(idx + 2));
  }
  assert.equal(
    Math.round(sum * 100) / 100,
    orderTotal,
    `${label}: 逐行加總(${sum}) ≠ 總計(${orderTotal})\n${lines.join("\n")}`,
  );
}

const fallbackOf = (lines: string[]) => lines.filter((l) => l.startsWith("外送費／餐盒費"));

// ── roundMoney ───────────────────────────────────────────────

test("roundMoney：負數 / NaN / Infinity / 0 一律回 0，其餘四捨五入 2 位", () => {
  assert.equal(roundMoney(-1), 0);
  assert.equal(roundMoney(0), 0);
  assert.equal(roundMoney(NaN), 0);
  assert.equal(roundMoney(Infinity), 0);
  assert.equal(roundMoney(12.3456), 12.35);
  assert.equal(roundMoney(12.344), 12.34);
});

test("resolveExtraFee：保留原有公開行為 —— 負數 / 0 回 0（店內單唔會多行）", () => {
  const base = { subtotalBefore: 100, serviceCharge: 0, tax: 0, rounding: 0, totalDiscount: 0 };
  assert.equal(resolveExtraFee({ ...base, orderTotal: 103 }), 3);
  assert.equal(resolveExtraFee({ ...base, orderTotal: 98 }), 0);
});

// ── 店內單：輸出必須同以前一模一樣 ───────────────────────────

test("店內單（冇 platformFees）：永遠只有「原價合計」一行", () => {
  // 服務費／稅／優惠／總計係另外嘅模板區塊，唔關呢個函式事。
  const lines = render({
    subtotalBefore: 200,
    serviceCharge: 20,
    tax: 12,
    totalDiscount: 30,
    orderTotal: 202,
  });
  assert.deepEqual(lines, ["原價合計: 200"]);
});

test("店內單有附加費（冇費用行可列）：照舊補一行兜底", () => {
  const lines = render({ subtotalBefore: 67, orderTotal: 126 });
  assert.deepEqual(lines, ["原價合計: 67", "外送費／餐盒費: 59"]);
});

test("店內單抹零（總額細過原價合計）：唔會出現負數行", () => {
  const lines = render({ subtotalBefore: 100, rounding: 2, orderTotal: 98 });
  assert.deepEqual(lines, ["原價合計: 100"]);
});

// ── 平台單：逐項費用（以下全部可用 assertAddsUp）───────────────

test("平台單只有正費用（餐盒費）：唔會再補兜底行，加總對得上", () => {
  const lines = render({ subtotalBefore: 100, orderTotal: 103 }, [{ label: "餐盒費", amount: 3 }]);
  assert.deepEqual(lines, ["原價合計: 100", "餐盒費: 3"]);
  assert.equal(fallbackOf(lines).length, 0, "費用已經列咗，唔可以再補一行（會被計兩次）");
  assertAddsUp(lines, 103, "只有正費用");
});

test("平台單有商家優惠（負數費用）：唔會補兜底行，加總對得上", () => {
  const lines = render({ subtotalBefore: 250, orderTotal: 248 }, [
    { label: "餐盒費", amount: 4 },
    { label: "膠袋費", amount: 3 },
    { label: "商家活動支出", amount: -9 },
  ]);
  assert.equal(fallbackOf(lines).length, 0, JSON.stringify(lines));
  assertAddsUp(lines, 248, "商家優惠");
});

test("平台單正負混合但仍為正：唔會補兜底行", () => {
  const lines = render({ subtotalBefore: 100, orderTotal: 103 }, [
    { label: "餐盒費", amount: 5 },
    { label: "商家滿減", amount: -2 },
  ]);
  assert.equal(fallbackOf(lines).length, 0, JSON.stringify(lines));
  assertAddsUp(lines, 103, "正負混合");
});

test("平台單費用完全抵消（Σ=0）：唔會補兜底行", () => {
  const lines = render({ subtotalBefore: 100, orderTotal: 100 }, [
    { label: "餐盒費", amount: 3 },
    { label: "膠袋費", amount: 1 },
    { label: "商家滿減", amount: -4 },
  ]);
  assert.equal(fallbackOf(lines).length, 0, JSON.stringify(lines));
  assertAddsUp(lines, 100, "抵消");
});

test("平台新增未識別費用：補一行兜底，金額正確，加總仍然對得上", () => {
  // 已知費用 3，總計比原價合計多 8 ⇒ 未識別 5
  const lines = render({ subtotalBefore: 100, orderTotal: 108 }, [{ label: "餐盒費", amount: 3 }]);
  assert.deepEqual(fallbackOf(lines), ["外送費／餐盒費: 5"]);
  assertAddsUp(lines, 108, "未識別費用");
});

/**
 * 🔴 回歸：呢個 case 就係「唔可以用夾咗負數嘅中間值去減」嘅證據。
 *
 * 已知費用 = 餐盒 4 − 商家活動 6 = −2；總計比原價合計多 3 ⇒ 未識別費用 = 3 − (−2) = 5。
 * 若寫成 `resolveExtraFee(parts) − max(0, printedFeeSum)`：
 *   max(0, 3) − max(0, −2) = 3 → 補 3 → 加總 101 ≠ 103 ✗
 */
test("平台單「有優惠 ＋ 未識別費用」：唔可以用夾 0 嘅中間值去減（回歸）", () => {
  const lines = render({ subtotalBefore: 100, orderTotal: 103 }, [
    { label: "餐盒費", amount: 4 },
    { label: "商家活動支出", amount: -6 },
  ]);
  assert.deepEqual(
    fallbackOf(lines),
    ["外送費／餐盒費: 5"],
    "應該補 5（= 3 − (−2)），唔係 3\n" + lines.join("\n"),
  );
  assertAddsUp(lines, 103, "有優惠 + 未識別費用");
});

// ── 唔計入營業額嘅資訊行 ─────────────────────────────────────

test("配送費（excluded）：另開一組顯示，但唔參與加總", () => {
  const lines = render({ subtotalBefore: 100, orderTotal: 103 }, [
    { label: "餐盒費", amount: 3 },
    { label: "配送費", amount: 12, excluded: true },
    { label: "商家配送費減免", amount: -12, excluded: true },
  ]);
  assert.deepEqual(lines, [
    "原價合計: 100",
    "餐盒費: 3",
    "（以下不計入營業額）",
    "配送費: 12",
    "商家配送費減免: -12",
  ]);
  assert.equal(fallbackOf(lines).length, 0);
  assertAddsUp(lines, 103, "配送費 excluded");
});

test("金額 0 / 空白標籤嘅費用一律略過（唔會出現空行）", () => {
  const lines = render({ subtotalBefore: 100, orderTotal: 102 }, [
    { label: "餐盒費", amount: 0 },
    { label: "", amount: 5 },
    { label: "  ", amount: 5 },
    { label: "膠袋費", amount: 2 },
  ]);
  assert.deepEqual(lines, ["原價合計: 100", "膠袋費: 2"]);
  assertAddsUp(lines, 102, "略過零值");
});

test("真實澳覓樣本：250 + 4 + 3 + 0 − 9 = 248（收據逐行加返等於總計）", () => {
  const lines = render({ subtotalBefore: 250, orderTotal: 248 }, [
    { label: "餐盒費", amount: 4 },
    { label: "膠袋費", amount: 3 },
    { label: "商家活動支出", amount: -9 },
    { label: "配送費", amount: 7, excluded: true },
  ]);
  assertAddsUp(lines, 248, "澳覓真實樣本");
  assert.equal(fallbackOf(lines).length, 0);
});

// ── splitPlatformFees：收據同訂單詳情共用嘅唯一分組來源 ────────

/**
 * 🔴 呢支函式嘅存在理由：收據（`buildSubtotalBlock`）同 POS 訂單詳情
 *    （`PlatformFeeBreakdown` 元件）**一定要用同一支**去分組／過濾。
 *    2026-09-24 實案：費用行只喺收據出現，訂單詳情完全冇 → 使用者以為功能失效。
 *    如果兩邊各自寫一套過濾，之後一定會走樣。
 */
test("splitPlatformFees：分成「計入營業額」同「唔計入」兩組，順序保持不變", () => {
  const r = splitPlatformFees([
    { label: "餐盒費", amount: 4 },
    { label: "配送費", amount: 12, excluded: true },
    { label: "商家活動支出", amount: -9 },
    { label: "商家配送費減免", amount: -12, excluded: true },
    { label: "膠袋費", amount: 3 },
  ]);
  assert.deepEqual(r.included, [
    { label: "餐盒費", amount: 4 },
    { label: "商家活動支出", amount: -9 },
    { label: "膠袋費", amount: 3 },
  ]);
  assert.deepEqual(r.excluded, [
    { label: "配送費", amount: 12, excluded: true },
    { label: "商家配送費減免", amount: -12, excluded: true },
  ]);
});

test("splitPlatformFees：0 / NaN / 空白標籤一律略過；undefined / null 安全", () => {
  const r = splitPlatformFees([
    { label: "餐盒費", amount: 0 },
    { label: "", amount: 5 },
    { label: "   ", amount: 5 },
    { label: "膠袋費", amount: Number.NaN },
    { label: "服務費", amount: 2 },
    null as unknown as { label: string; amount: number },
  ]);
  assert.deepEqual(r.included, [{ label: "服務費", amount: 2 }]);
  assert.deepEqual(r.excluded, []);

  assert.deepEqual(splitPlatformFees(undefined), { included: [], excluded: [] });
  assert.deepEqual(splitPlatformFees(null), { included: [], excluded: [] });
  assert.deepEqual(splitPlatformFees([]), { included: [], excluded: [] });
});

test("splitPlatformFees：標籤會 trim（唔會出現「 餐盒費 」呢種前後空白）", () => {
  const r = splitPlatformFees([{ label: "  餐盒費  ", amount: 4 }]);
  assert.deepEqual(r.included, [{ label: "餐盒費", amount: 4 }]);
});
