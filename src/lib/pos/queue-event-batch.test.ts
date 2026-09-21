import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chunkRows, flushQueueEventRows, uniqueRowsById } from "./queue-event-batch.ts";

/**
 * `/api/pos/sync` 嘅 `pos_queue_events` 批次寫入邏輯（2026-09-21 egress 優化）。
 *
 * 兩個函式都係為咗修「N 個事件 ＝ N 個 PostgREST POST」（實測 26 分鐘 150 次，
 * 全專案請求數第一位）而加。呢度鎖死兩個**靜默**失效模式：
 *   ① 同一批內重複 id → Postgres 21000 → **整批審計行一齊寫唔入**（只記 warning，唔會 throw）；
 *   ② 分批邊界處理錯 → 漏行／無限迴圈。
 */
describe("uniqueRowsById — 去重（後者勝，同「逐個 upsert」語義一致）", () => {
  it("同一 id 出現兩次 → 只保留最後一條", () => {
    const rows = [
      { id: "a", status: "pending", v: 1 },
      { id: "b", status: "pending", v: 1 },
      { id: "a", status: "synced", v: 2 },
    ];
    const out = uniqueRowsById(rows);
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((r) => r.id),
      ["a", "b"],
      "第一次出現嘅次序要保留（Map 保插入序）",
    );
    assert.equal(out.find((r) => r.id === "a")!.v, 2, "重複 id 必須後者覆蓋前者");
  });

  it("冇重複 → 原樣回（次序不變）", () => {
    const rows = [{ id: "x" }, { id: "y" }, { id: "z" }];
    assert.deepEqual(uniqueRowsById(rows), rows);
  });

  it("空陣列 / 空輸入唔會爆", () => {
    assert.deepEqual(uniqueRowsById([]), []);
    assert.deepEqual(uniqueRowsById([] as { id: string }[]), []);
  });

  it("冇 id / 空 id / 非字串 id 一律丟棄（主鍵寫唔入，會令整批失敗）", () => {
    const rows = [
      { id: "ok" },
      { id: "" } as { id: string },
      { id: undefined } as unknown as { id: string },
      { id: 123 } as unknown as { id: string },
      null as unknown as { id: string },
      undefined as unknown as { id: string },
    ];
    const out = uniqueRowsById(rows);
    assert.deepEqual(
      out.map((r) => r.id),
      ["ok"],
    );
  });

  it("大量重複只回唯一集合（＝可安全餵 array upsert）", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `evt-${i % 7}`, i }));
    const out = uniqueRowsById(rows);
    assert.equal(out.length, 7);
    assert.equal(new Set(out.map((r) => r.id)).size, 7, "唯一性係 array upsert 嘅前提");
  });
});

describe("chunkRows — 分批（控制每個請求 body 大小）", () => {
  it("200 行、每批 100 → 剛好 2 批", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}` }));
    const batches = chunkRows(rows, 100);
    assert.equal(batches.length, 2);
    assert.equal(batches[0].length, 100);
    assert.equal(batches[1].length, 100);
    assert.equal(batches[0][0].id, "e0");
    assert.equal(batches[1][99].id, "e199");
  });

  it("25 行、每批 100 → **1 批**（＝常見情況 N→1 嘅關鍵）", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `e${i}` }));
    const batches = chunkRows(rows, 100);
    assert.equal(batches.length, 1, "日常 flush 幾個事件應該只發一個請求");
    assert.equal(batches[0].length, 25);
  });

  it("除唔盡 → 最後一批係餘數", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `e${i}` }));
    const batches = chunkRows(rows, 3);
    assert.deepEqual(
      batches.map((b) => b.length),
      [3, 3, 1],
    );
  });

  it("唔可以漏行／重複行（切片總和 = 原本）", () => {
    const rows = Array.from({ length: 137 }, (_, i) => ({ id: `e${i}` }));
    const flat = chunkRows(rows, 10).flat();
    assert.equal(flat.length, rows.length);
    assert.deepEqual(flat, rows);
  });

  it("空輸入 → 0 批（caller 唔應該發空 upsert）", () => {
    assert.deepEqual(chunkRows([], 100), []);
  });

  it("非法 size（0 / 負 / NaN / 小數）唔會無限迴圈或漏行", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    for (const size of [0, -5, NaN, Number.POSITIVE_INFINITY]) {
      const batches = chunkRows(rows, size);
      assert.equal(batches.flat().length, 2, `size=${size} 時唔可以漏行`);
    }
    // 小數 → 向下取整（1.9 → 1）
    assert.deepEqual(
      chunkRows(rows, 1.9).map((b) => b.length),
      [1, 1],
    );
  });
});

describe("組合：去重 → 分批（實際 write path 嘅次序）", () => {
  it("先去重再分批 ⇒ 每批都冇重複 id（21000 防線）", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: `evt-${i % 6}`, i }));
    const batches = chunkRows(uniqueRowsById(rows), 4);
    assert.equal(batches.flat().length, 6);
    for (const batch of batches) {
      assert.equal(new Set(batch.map((r) => r.id)).size, batch.length, "同批內唔可以有重複 id");
    }
    // 後者勝：evt-0 最後一次出現係 i=54
    const evt0 = batches.flat().find((r) => r.id === "evt-0") as { i: number };
    assert.equal(evt0.i, 54);
  });
});

// ─────────────────────────────────────────────────────────────
// flushQueueEventRows：N → 1（今次優化嘅核心承諾）
// ─────────────────────────────────────────────────────────────

/** 假 supabase client：只記錄有幾多個 upsert 請求、每批幾多行。 */
function makeFakeClient(options: { failOnBatch?: number } = {}) {
  const calls: { table: string; rowCount: number; firstId: string | undefined; onConflict: string }[] = [];
  let batchIndex = 0;
  const client = {
    from(table: string) {
      return {
        upsert(rows: { id: string }[], opts: { onConflict: string }) {
          batchIndex += 1;
          calls.push({
            table,
            rowCount: rows.length,
            firstId: rows[0]?.id,
            onConflict: opts.onConflict,
          });
          if (options.failOnBatch === batchIndex) {
            return Promise.resolve({ error: { message: "mock failure" } });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, calls };
}

describe("flushQueueEventRows — 由 N 個請求變 1 個", () => {
  const row = (i: number) => ({ id: `evt-${i}` });

  it("🔴 日常情況：25 個事件 → **只發 1 個** upsert 請求（舊版係 25 個）", async () => {
    const { client, calls } = makeFakeClient();
    const rows = Array.from({ length: 25 }, (_, i) => row(i));
    const out = await flushQueueEventRows({ client, rows, chunkSize: 100 });

    assert.equal(calls.length, 1, "核心承諾：一次 flush 只應該發一個 PostgREST 請求");
    assert.equal(calls[0].rowCount, 25);
    assert.equal(calls[0].table, "pos_queue_events");
    assert.equal(calls[0].onConflict, "id", "一定要帶 onConflict，否則會撞主鍵");
    assert.deepEqual(out, { requested: 25, written: 25, batches: 1, error: null });
  });

  it("大量事件：200 行、每批 100 → 2 個請求（唔係 200 個）", async () => {
    const { client, calls } = makeFakeClient();
    const rows = Array.from({ length: 200 }, (_, i) => row(i));
    const out = await flushQueueEventRows({ client, rows, chunkSize: 100 });

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((c) => c.rowCount),
      [100, 100],
    );
    assert.equal(out.batches, 2);
    assert.equal(out.written, 200);
  });

  it("重複 id 喺寫入之前就去掉（否則會 21000、整批失敗）", async () => {
    const { client, calls } = makeFakeClient();
    const rows = [
      { id: "a", v: 1 },
      { id: "b", v: 1 },
      { id: "a", v: 2 },
      { id: "a", v: 3 },
    ];
    const out = await flushQueueEventRows({ client, rows, chunkSize: 100 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].rowCount, 2, "4 行入、只有 2 個唯一 id");
    assert.deepEqual(out, { requested: 2, written: 2, batches: 1, error: null });
  });

  it("空輸入 → 一個請求都唔發（唔可以發空 upsert）", async () => {
    const { client, calls } = makeFakeClient();
    const out = await flushQueueEventRows({ client, rows: [], chunkSize: 100 });
    assert.equal(calls.length, 0);
    assert.deepEqual(out, { requested: 0, written: 0, batches: 0, error: null });
  });

  it("中途失敗 → 即刻停（唔試其餘批次）、回報已寫入行數、**唔會 throw**", async () => {
    const { client, calls } = makeFakeClient({ failOnBatch: 2 });
    const rows = Array.from({ length: 250 }, (_, i) => row(i));
    const errors: { message: string; batchSize: number }[] = [];

    const out = await flushQueueEventRows({
      client,
      rows,
      chunkSize: 100,
      onError: (info) => errors.push(info),
    });

    assert.equal(calls.length, 2, "第 3 批唔應該再試");
    assert.deepEqual(out, { requested: 250, written: 100, batches: 2, error: "mock failure" });
    assert.deepEqual(errors, [{ message: "mock failure", batchSize: 100 }], "onError 只叫一次");
  });

  it("失敗唔會影響業務：函式唔 throw（審計表唔係真源，唔可以令成批回 500）", async () => {
    const { client } = makeFakeClient({ failOnBatch: 1 });
    await assert.doesNotReject(async () => {
      await flushQueueEventRows({ client, rows: [row(1)], chunkSize: 100 });
    });
  });

  it("冇 onError 都可以安全失敗（caller 可以唔提供）", async () => {
    const { client } = makeFakeClient({ failOnBatch: 1 });
    const out = await flushQueueEventRows({ client, rows: [row(1)], chunkSize: 100 });
    assert.equal(out.error, "mock failure");
    assert.equal(out.written, 0);
  });

  it("錯誤冇 message 都唔會爆（String(undefined) 有兜底）", async () => {
    const client = {
      from() {
        return { upsert: () => Promise.resolve({ error: {} }) };
      },
    };
    const out = await flushQueueEventRows({ client, rows: [row(1)], chunkSize: 100 });
    assert.equal(out.error, "unknown error");
  });
});
