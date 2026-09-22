import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearPosSessionRevoked,
  getPosSessionRevokedReason,
  isPosSessionRevoked,
  markPosSessionRevoked,
  resetPosSessionRevokedForTest,
  subscribePosSessionRevoked,
} from "./session-revoked.ts";

/**
 * 《已被管理員關閉》旗標單測（2026-09-22）。
 *
 * 呢個旗標一開，收銀台就會**停止輪詢**（＝原本要止血嘅事）同時出橫幅。
 * 兩個方向都要守：
 *   · 收到訊號但冇開（＝繼續燒流量，功能等於冇做）；
 *   · 冇訊號但開咗（＝健康收銀機被誤當已關閉，商家會以為部機壞咗）。
 */

describe("撤銷旗標", () => {
  it("初始係 false", () => {
    resetPosSessionRevokedForTest();
    assert.equal(isPosSessionRevoked(), false);
    assert.equal(getPosSessionRevokedReason(), null);
  });

  it("標記之後係 true，並記住原因", () => {
    resetPosSessionRevokedForTest();
    markPosSessionRevoked("疑似開啟了多個分頁");
    assert.equal(isPosSessionRevoked(), true);
    assert.equal(getPosSessionRevokedReason(), "疑似開啟了多個分頁");
  });

  it("冇原因都算已關閉（原因係選填）", () => {
    resetPosSessionRevokedForTest();
    markPosSessionRevoked();
    assert.equal(isPosSessionRevoked(), true);
    assert.equal(getPosSessionRevokedReason(), null);
  });

  it("重新登入之後清得返（唔會一路顯示橫幅）", () => {
    resetPosSessionRevokedForTest();
    markPosSessionRevoked("x");
    clearPosSessionRevoked();
    assert.equal(isPosSessionRevoked(), false);
    assert.equal(getPosSessionRevokedReason(), null);
  });

  it("訂閱者收到通知；同值重複標記唔會再嘈", () => {
    resetPosSessionRevokedForTest();
    let hits = 0;
    const off = subscribePosSessionRevoked(() => {
      hits += 1;
    });
    markPosSessionRevoked("a");
    assert.equal(hits, 1);
    markPosSessionRevoked("a");
    assert.equal(hits, 1, "同值唔應該再通知（避免無謂 re-render）");
    markPosSessionRevoked("b");
    assert.equal(hits, 2, "原因變咗要通知");
    clearPosSessionRevoked();
    assert.equal(hits, 3);
    off();
    markPosSessionRevoked("c");
    assert.equal(hits, 3, "unsubscribe 之後唔應該再收到");
  });
});
