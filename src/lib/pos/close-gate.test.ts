import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCloseGateResult,
  decideOnlineClose,
  decideStoreClose,
  describeCloseGate,
  isCloseGateClean,
  isCloseGateTotalFailure,
  type CloseGateResult,
} from "./close-gate.ts";

/**
 * 「關店總掣」決策測試（2026-09-18）。
 *
 * 🔴 呢批測試鎖死兩條唔可以退讓嘅紀律：
 *
 * 1. **`null`（未讀到）＝ skip，唔係 close，亦唔係 failed。**
 *    交班時如果 `pos_store_status` 未讀到就走去做樂觀寫入，會製造一個假狀態
 *    （UI 顯示已關、DB 其實冇）；當 `failed` 又會令收銀見到一個唔存在嘅問題。
 *    兩個方向都係講大話。
 *
 * 2. **`false`（已經關咗）＝ skip。** 已經關咗唔應該再發一次寫入請求
 *    （多餘寫入會推 `updated_at`，令其他機嘅 Realtime 收一次無意思嘅事件）。
 */
test("decideStoreClose：true = 真正要關", () => {
  assert.equal(decideStoreClose(true), "close");
});

test("decideStoreClose：false = 已關，skip（唔可以再寫一次）", () => {
  assert.equal(decideStoreClose(false), "skip");
});

test("decideStoreClose：null = 未讀到，skip（唔准樂觀寫）", () => {
  assert.equal(decideStoreClose(null), "skip");
});

test("decideOnlineClose：true = 真正要關", () => {
  assert.equal(decideOnlineClose(true), "close");
});

test("decideOnlineClose：false = 已暫停，skip", () => {
  assert.equal(decideOnlineClose(false), "skip");
});

test("decideOnlineClose：null = 未讀到，skip（applyMerchantEnabled 本身都會拒絕）", () => {
  assert.equal(decideOnlineClose(null), "skip");
});

test("buildCloseGateResult：原樣保留兩個通道結果", () => {
  const result = buildCloseGateResult("closed", "failed");
  assert.deepEqual(result, { store: "closed", online: "failed" });
});

test("isCloseGateClean：全部非 failed 為 true", () => {
  const clean: CloseGateResult[] = [
    buildCloseGateResult("closed", "closed"),
    buildCloseGateResult("closed", "skipped"),
    buildCloseGateResult("skipped", "skipped"),
    buildCloseGateResult("skipped", "closed"),
  ];
  for (const one of clean) assert.equal(isCloseGateClean(one), true, JSON.stringify(one));
});

test("isCloseGateClean：任何一邊 failed 為 false", () => {
  assert.equal(isCloseGateClean(buildCloseGateResult("failed", "closed")), false);
  assert.equal(isCloseGateClean(buildCloseGateResult("closed", "failed")), false);
  assert.equal(isCloseGateClean(buildCloseGateResult("failed", "failed")), false);
});

test("isCloseGateTotalFailure：只有兩邊都 failed 才 true", () => {
  assert.equal(isCloseGateTotalFailure(buildCloseGateResult("failed", "failed")), true);
  assert.equal(isCloseGateTotalFailure(buildCloseGateResult("failed", "closed")), false);
  assert.equal(isCloseGateTotalFailure(buildCloseGateResult("closed", "failed")), false);
  assert.equal(isCloseGateTotalFailure(buildCloseGateResult("skipped", "skipped")), false);
});

test("describeCloseGate：全成功／全 skip → 空字串（呼叫端唔使加括號）", () => {
  assert.equal(describeCloseGate(buildCloseGateResult("closed", "closed")), "");
  assert.equal(describeCloseGate(buildCloseGateResult("skipped", "skipped")), "");
  assert.equal(describeCloseGate(buildCloseGateResult("closed", "skipped")), "");
});

test("describeCloseGate：只有線下失敗 → 講明係掃碼／自助機", () => {
  const text = describeCloseGate(buildCloseGateResult("failed", "closed"));
  assert.match(text, /店內接單/);
  assert.match(text, /掃碼/);
  assert.match(text, /側欄/);
});

test("describeCloseGate：只有線上失敗 → 講明係線上接單", () => {
  const text = describeCloseGate(buildCloseGateResult("closed", "failed"));
  assert.match(text, /線上接單/);
  assert.doesNotMatch(text, /店內接單/);
});

test("describeCloseGate：兩邊都失敗 → 兩項都要出現（唔可以只講部分失敗）", () => {
  const text = describeCloseGate(buildCloseGateResult("failed", "failed"));
  assert.match(text, /店內接單/);
  assert.match(text, /線上接單/);
  assert.match(text, /側欄/);
});
