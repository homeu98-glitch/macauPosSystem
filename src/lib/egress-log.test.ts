import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isEgressLogEnabled, serializeWithEgressLog } from "./egress-log.ts";

/**
 * Egress 審計日誌（2026-09-21）。
 *
 * 呢個模組係「量度工具」，出錯唔應該影響業務，但**兩個位一定要鎖**：
 *   ① `bytes` 要真係 UTF-8 位元組數（唔係字元數）——中文／emoji 會差 3~4 倍，計錯就冇意義；
 *   ② `.body` 一定要同 `JSON.stringify(payload)` 完全一致（因為 route 會直接用它做 response，
 *      一旦呢度加咗嘢或者改咗 key 順序，就係改咗 API 回應）。
 * 同埋靜音開關唔可以誤判（唔想生產環境無聲無息印爆 log）。
 */
describe("egress-log", () => {
  it("bytes 係 UTF-8 位元組數（中文唔可以當 1 byte）", () => {
    const payload = { note: "凍檸茶" };
    const { body, bytes } = serializeWithEgressLog("test", payload);
    const expected = new TextEncoder().encode(JSON.stringify(payload)).length;
    assert.equal(bytes, expected);
    // 3 個中文字 = 9 bytes，加 JSON 殼；一定大過「字元數」
    assert.ok(bytes > body.length, `bytes(${bytes}) 應該大過字元數(${body.length})`);
  });

  it("回傳嘅 body 必須同 JSON.stringify 逐位元一致（route 會直接用它）", () => {
    const payload = {
      ok: true,
      orders: [{ id: "order-1", total: 167.2, items: [{ name: "豬扒包", qty: 2 }] }],
      queue: [] as unknown[],
      note: "備註：走冰 🧊",
    };
    const { body } = serializeWithEgressLog("pos/state", payload);
    assert.equal(body, JSON.stringify(payload));
    assert.deepEqual(JSON.parse(body), payload);
  });

  it("extra 維度唔會洩漏落 body（只入 log）", () => {
    const payload = { ok: true };
    const { body } = serializeWithEgressLog("pos/state", payload, {
      orders: 200,
      queue: 0,
      ordersOnly: 1,
      range: "2026-09-21T00:00:00.000Z~",
    });
    assert.equal(body, JSON.stringify(payload));
  });

  it("undefined 維度唔會印成 'undefined'", () => {
    // 只驗行為（唔 capture console），確保唔會 throw 亦唔會改變 body
    const { body, bytes } = serializeWithEgressLog("x", { a: 1 }, { limit: undefined, offset: null });
    assert.equal(body, '{"a":1}');
    assert.ok(bytes > 0);
  });

  it("靜音開關：預設開；只有 0/false/off/空字串 先關", () => {
    assert.equal(isEgressLogEnabled(undefined), true);
    assert.equal(isEgressLogEnabled("1"), true);
    assert.equal(isEgressLogEnabled("true"), true);
    assert.equal(isEgressLogEnabled("yes"), true);
    assert.equal(isEgressLogEnabled("0"), false);
    assert.equal(isEgressLogEnabled("false"), false);
    assert.equal(isEgressLogEnabled("OFF"), false);
    assert.equal(isEgressLogEnabled(" off "), false);
    assert.equal(isEgressLogEnabled(""), false);
  });

  it("空／極簡 payload 都唔會 throw（`undefined` 兜成 `null`）", () => {
    assert.equal(serializeWithEgressLog("x", null).body, "null");
    // JSON.stringify(undefined) 本身回 undefined（唔係字串）→ 內部兜成 "null"
    assert.equal(serializeWithEgressLog("x", undefined).body, "null");
    assert.equal(serializeWithEgressLog("x", []).body, "[]");
  });
});
