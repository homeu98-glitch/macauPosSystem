import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSingleFlight, createSingleFlightWithProbe } from "./single-flight.ts";

/**
 * Single-flight 去重（2026-09-21 請求數優化）。
 *
 * 為何要用測試鎖死：呢個係「POS 主畫面一開就爆 4~5 次重複請求」嘅修正點，
 * 而它有兩個**相反方向**嘅致命失效模式：
 *   · **去重失效**（例如無條件清 inflight）→ 請求照爆，改動白做。
 *   · **跨店共用**（唔比對 key）→ B 店拿到 A 店嘅值 ⇒ **餵錯店**（比多幾個請求嚴重得多）。
 * 兩邊都係靜默嘅，所以一定要有測試。
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createSingleFlight — 同 key 同時呼叫只做一次", () => {
  it("🔴 5 個同時呼叫（同 key）→ task 只跑 1 次，而且要回同一個 promise", async () => {
    const run = createSingleFlight<number>();
    let calls = 0;
    const task = async () => {
      calls += 1;
      await sleep(10);
      return 42;
    };

    const results = await Promise.all([
      run("store-A", task),
      run("store-A", task),
      run("store-A", task),
      run("store-A", task),
      run("store-A", task),
    ]);

    assert.equal(calls, 1, "5 個 mount 應該只發 1 個請求");
    assert.deepEqual(results, [42, 42, 42, 42, 42], "每個呼叫端都要拿到同一次讀取嘅結果");
  });

  it("同一個 key 但**唔同時**（前一個已完成）→ 會再跑（唔會永久快取）", async () => {
    const run = createSingleFlight<number>();
    let calls = 0;
    const task = async () => {
      calls += 1;
      return calls;
    };

    assert.equal(await run("store-A", task), 1);
    await sleep(1); // 等 .finally 清 flight
    assert.equal(await run("store-A", task), 2, "完成之後再叫應該重新讀（呢個唔係快取）");
    assert.equal(calls, 2);
  });
});

describe("createSingleFlight — 跨店唔可以共用（死穴①）", () => {
  it("🔴 兩個 key 同時呼叫 → 各自跑一次，唔會互相污染", async () => {
    const run = createSingleFlight<string>();
    const seen: string[] = [];
    const task = (value: string) => async () => {
      await sleep(10);
      seen.push(value);
      return value;
    };

    const [a, b] = await Promise.all([run("store-A", task("A")), run("store-B", task("B"))]);
    assert.equal(a, "A");
    assert.equal(b, "B");
    assert.deepEqual(seen.sort(), ["A", "B"], "兩個店各自讀一次");
  });

  it("🔴 key 唔匹配就開新 flight（切店場景）", async () => {
    const run = createSingleFlight<number>();
    let calls = 0;
    const task = async () => {
      calls += 1;
      await sleep(10);
      return calls;
    };

    const p1 = run("store-A", task); // in-flight
    const p2 = run("store-B", task); // key 唔同 → 應該另開一個
    await Promise.all([p1, p2]);
    assert.equal(calls, 2, "store-B 唔可以食 store-A 嘅 in-flight");
  });
});

describe("createSingleFlight — 失敗要清（死穴②）", () => {
  it("🔴 task reject 之後，下一次呼叫要可以再跑（唔可以永遠拿同一個失敗）", async () => {
    const run = createSingleFlight<number>();
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("boom");
    };
    const ok = async () => {
      calls += 1;
      return 7;
    };

    await assert.rejects(() => run("store-A", failing));
    await sleep(1); // 等 .finally 清 flight
    assert.equal(await run("store-A", ok), 7, "失敗之後應該可以重新讀");
    assert.equal(calls, 2);
  });

  it("同一刻多個呼叫一齊失敗 → 只跑一次 task，但全部都收到錯誤", async () => {
    const run = createSingleFlight<number>();
    let calls = 0;
    const failing = async () => {
      calls += 1;
      await sleep(5);
      throw new Error("boom");
    };

    const results = await Promise.allSettled([
      run("store-A", failing),
      run("store-A", failing),
      run("store-A", failing),
    ]);
    assert.equal(calls, 1);
    for (const r of results) {
      assert.equal(r.status, "rejected");
    }
  });

  it("task 同步 throw 唔會留低毒 flight", async () => {
    const probe = createSingleFlightWithProbe<number>();
    const thrower = (() => {
      throw new Error("sync boom");
    }) as () => Promise<number>;

    await assert.rejects(() => probe.run("store-A", thrower));
    assert.equal(probe.hasInflight(), false, "同步 throw 之後唔應該有 in-flight");
    assert.equal(await probe.run("store-A", async () => 1), 1);
  });
});

describe("createSingleFlight — inflight 生命週期", () => {
  it("完成之後 probe 見到冇 in-flight（證明唔係永久快取）", async () => {
    const probe = createSingleFlightWithProbe<number>();
    const p = probe.run("store-A", async () => {
      await sleep(5);
      return 1;
    });
    assert.equal(probe.inflightKey(), "store-A");
    await p;
    assert.equal(probe.hasInflight(), false);
    assert.equal(probe.inflightKey(), null);
  });

  it("🔴 慢 flight 完成時唔可以清走後來者嘅 flight", async () => {
    const probe = createSingleFlightWithProbe<string>();

    // A 慢（20ms）
    const slowA = probe.run("store-A", async () => {
      await sleep(20);
      return "A";
    });
    // A 未完成就切去 B（key 唔同 → 開新 flight，覆蓋 inflight 指向 B）
    await sleep(2);
    const fastB = probe.run("store-B", async () => {
      await sleep(5);
      return "B";
    });

    // 等 B 完成（B 嘅 finally 應該清走 B）
    assert.equal(await fastB, "B");
    assert.equal(probe.hasInflight(), false, "B 完成之後應該清走自己");

    // A 而家完成 —— 唔應該影響任何嘢（而且 A 期間嘅 key 已經被 B 取代）
    assert.equal(await slowA, "A");
    assert.equal(probe.hasInflight(), false);
  });

  it("合併之後嘅 promise 身分一致（真・共用，唔係各自包一層）", () => {
    const run = createSingleFlight<number>();
    const task = async () => 1;
    const p1 = run("store-A", task);
    const p2 = run("store-A", task);
    assert.equal(p1, p2, "同一次 flight 應該回同一個 promise 物件");
  });
});
