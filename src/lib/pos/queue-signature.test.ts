import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { queueSignature } from "./queue-signature.ts";

/**
 * 《同步隊列內容簽名》單測（2026-09-21 全量拉取自激迴圈修復）。
 *
 * 呢支函式係「唔換 array 身分」嘅唯一判準；一旦佢寫鬆咗，
 * 就會出現兩個相反方向嘅事故：
 *   · **太鬆**（唔同內容當成一樣）⇒ 真嘅隊列變更唔會 `setQueue`
 *     ⇒ `failedSyncCount`／待同步提示**唔更新**（UI 靜默落後）。
 *   · **太緊**（一樣內容當成唔同）⇒ 又變返每次重讀都換身分 ⇒ 424 KB 全量拉取循環。
 */
describe("queueSignature", () => {
  it("空隊列 / null / undefined 一律回空字串", () => {
    assert.equal(queueSignature([]), "");
    assert.equal(queueSignature(null), "");
    assert.equal(queueSignature(undefined), "");
  });

  it("單筆：JSON 編碼 `[id,status]`", () => {
    assert.equal(queueSignature([{ id: "evt-1", status: "pending" }]), '["evt-1","pending"]');
  });

  it("🔴 次序唔同、內容一樣 → 同一個簽名（隊列次序唔應該觸發全量拉取）", () => {
    const a = [
      { id: "evt-1", status: "pending" },
      { id: "evt-2", status: "synced" },
    ];
    const b = [
      { id: "evt-2", status: "synced" },
      { id: "evt-1", status: "pending" },
    ];
    assert.equal(queueSignature(a), queueSignature(b));
  });

  it("🔴 狀態變咗 → 簽名一定要變（否則 UI 唔會更新待同步提示）", () => {
    const before = [{ id: "evt-1", status: "pending" }];
    const after = [{ id: "evt-1", status: "synced" }];
    assert.notEqual(queueSignature(before), queueSignature(after));
  });

  it("🔴 多／少一筆 → 簽名一定要變", () => {
    const one = [{ id: "evt-1", status: "pending" }];
    const two = [
      { id: "evt-1", status: "pending" },
      { id: "evt-2", status: "pending" },
    ];
    assert.notEqual(queueSignature(one), queueSignature(two));
  });

  it("id 唔同 → 簽名唔同", () => {
    assert.notEqual(
      queueSignature([{ id: "evt-1", status: "pending" }]),
      queueSignature([{ id: "evt-2", status: "pending" }]),
    );
  });

  it("🔴 分隔符唔可以撞簽名（`a:b`+`c` vs `a`+`b:c` 一定要分辨得出）", () => {
    const left = [
      { id: "a:b", status: "c" },
      { id: "", status: "" },
    ];
    const right = [
      { id: "a", status: "b:c" },
      { id: "", status: "" },
    ];
    assert.notEqual(queueSignature(left), queueSignature(right));
  });

  it("相同內容重覆計算 → 穩定（純函式、冇隱藏狀態）", () => {
    const rows = [
      { id: "evt-2", status: "failed" },
      { id: "evt-1", status: "synced" },
    ];
    assert.equal(queueSignature(rows), queueSignature(rows));
    assert.equal(queueSignature(rows.slice()), queueSignature(rows));
  });

  it("唔會改動輸入陣列（簽名過程只讀）", () => {
    const rows = [
      { id: "evt-2", status: "failed" },
      { id: "evt-1", status: "synced" },
    ];
    const snapshot = JSON.stringify(rows);
    queueSignature(rows);
    assert.equal(JSON.stringify(rows), snapshot);
  });

  it("接受額外欄位（真實 QueueEvent 有 payload / createdAt）", () => {
    const rich = [
      { id: "evt-1", status: "pending", payload: { big: "x".repeat(500) }, createdAt: "2026-09-21" },
    ];
    assert.equal(queueSignature(rich), '["evt-1","pending"]');
  });
});
