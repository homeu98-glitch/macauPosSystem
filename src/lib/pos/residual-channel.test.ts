import assert from "node:assert/strict";
import test from "node:test";

import {
  onlineResidualState,
  storeResidualState,
} from "./residual-channel.ts";

/**
 * 「殘留接單通道」偵測測試（2026-09-18）。
 *
 * 🔴 呢批測試鎖死兩條紀律：
 *
 * 1. **`null`（未讀到）永遠唔觸發警示。** 未讀到係「唔知」，唔係「仲開住」。
 *    用 `null` 觸發 = 每次斷網都出假警報 → 收銀學識無視佢 → 真警示都冇人理。
 *
 * 2. **只有「一邊已關、另一邊仍然開」才警示。** 兩邊一致（都開 / 都關）
 *    唔應該出點 —— 出咗就變成噪音。
 */

/** 全部 `boolean | null` 組合（3 × 3 = 9 種）。 */
const VALUES: (boolean | null)[] = [true, false, null];

test("storeResidualState：線下已關 + 線上仍開 → residual", () => {
  assert.equal(storeResidualState(false, true), "residual");
});

test("storeResidualState：兩邊一致 → none", () => {
  assert.equal(storeResidualState(false, false), "none", "兩邊都關");
  assert.equal(storeResidualState(true, true), "none", "兩邊都開");
});

test("storeResidualState：線下仍然開（不論線上）→ none", () => {
  assert.equal(storeResidualState(true, false), "none");
  assert.equal(storeResidualState(true, null), "none");
});

test("storeResidualState：未讀到一律唔觸發（唔可以出假警報）", () => {
  assert.equal(storeResidualState(null, true), "none");
  assert.equal(storeResidualState(null, false), "none");
  assert.equal(storeResidualState(null, null), "none");
  assert.equal(storeResidualState(false, null), "none", "線上未讀到 = 唔知，唔算殘留");
});

test("onlineResidualState：線上已關 + 線下仍開 → residual", () => {
  assert.equal(onlineResidualState(true, false), "residual");
});

test("onlineResidualState：兩邊一致 → none", () => {
  assert.equal(onlineResidualState(false, false), "none");
  assert.equal(onlineResidualState(true, true), "none");
});

test("onlineResidualState：線上仍然開（不論線下）→ none", () => {
  assert.equal(onlineResidualState(false, true), "none");
  assert.equal(onlineResidualState(null, true), "none");
});

test("onlineResidualState：未讀到一律唔觸發", () => {
  assert.equal(onlineResidualState(true, null), "none");
  assert.equal(onlineResidualState(false, null), "none");
  assert.equal(onlineResidualState(null, null), "none");
  assert.equal(onlineResidualState(null, false), "none", "線下未讀到 = 唔知，唔算殘留");
});

test("兩個方向：永遠唔會同時為 residual（互相排斥）", () => {
  for (const isOpen of VALUES) {
    for (const merchantEnabled of VALUES) {
      const store = storeResidualState(isOpen, merchantEnabled);
      const online = onlineResidualState(isOpen, merchantEnabled);
      assert.equal(
        store === "residual" && online === "residual",
        false,
        `兩邊同時警示：isOpen=${isOpen} merchantEnabled=${merchantEnabled}`,
      );
    }
  }
});

test("任何組合都唔會 throw（防禦式）", () => {
  for (const isOpen of VALUES) {
    for (const merchantEnabled of VALUES) {
      assert.doesNotThrow(() => storeResidualState(isOpen, merchantEnabled));
      assert.doesNotThrow(() => onlineResidualState(isOpen, merchantEnabled));
    }
  }
});
