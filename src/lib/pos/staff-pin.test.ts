import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { POS_STAFF_PIN_ALGO, hashPosStaffPin, verifyPosStaffPin } from "./staff-pin.ts";

describe("pos staff pin", () => {
  it("雜湊／驗證 roundtrip", () => {
    const record = hashPosStaffPin("1358");
    assert.equal(record.pinAlgo, POS_STAFF_PIN_ALGO);
    assert.equal(/^[0-9a-f]{64}$/.test(record.pinHash), true);
    assert.equal(/^[0-9a-f]{32}$/.test(record.pinSalt), true);
    assert.equal(verifyPosStaffPin({ pin: "1358", ...record }), true);
  });

  it("錯 PIN 一律 false", () => {
    const record = hashPosStaffPin("1358");
    assert.equal(verifyPosStaffPin({ pin: "1359", ...record }), false);
    assert.equal(verifyPosStaffPin({ pin: "0000", ...record }), false);
    assert.equal(verifyPosStaffPin({ pin: "", ...record }), false);
  });

  it("同一 PIN 兩次雜湊：salt 不同 ⇒ hash 不同，但兩者都驗得過", () => {
    const a = hashPosStaffPin("1358");
    const b = hashPosStaffPin("1358");
    assert.notEqual(a.pinSalt, b.pinSalt);
    assert.notEqual(a.pinHash, b.pinHash);
    assert.equal(verifyPosStaffPin({ pin: "1358", ...a }), true);
    assert.equal(verifyPosStaffPin({ pin: "1358", ...b }), true);
  });

  it("未知演算法 / 壞資料 fail closed（唔會猜一個預設去驗）", () => {
    const record = hashPosStaffPin("1358");
    assert.equal(verifyPosStaffPin({ pin: "1358", ...record, pinAlgo: "md5" }), false);
    assert.equal(verifyPosStaffPin({ pin: "1358", ...record, pinHash: "" }), false);
    assert.equal(verifyPosStaffPin({ pin: "1358", ...record, pinSalt: "" }), false);
    assert.equal(verifyPosStaffPin({ pin: "1358", ...record, pinHash: "abc" }), false);
    assert.equal(verifyPosStaffPin({ pin: "1358", pinHash: "zz", pinSalt: "00" }), false);
  });
});
