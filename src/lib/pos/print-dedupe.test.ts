// 回歸測試（2026-09-21 商家實案）：訂單 001 一次過出 4 張收據。
// 核心契約：**同一張單 × 同一件事 × 同一部打印機 → 只可以出一張紙**，
// 但「手動補打 / 加菜 / 退菜 / 返結重結」呢啲**合法重複**一律唔可以被攔。
//
// 跑法：node --test src/lib/pos/print-dedupe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectOnceKeys,
  dedupeOnceJobs,
  mergeOnceKeys,
  printOnceContentSignature,
  printOnceDbKey,
  printOnceKey,
  printOnceScopeFromDbKey,
  seenKeysFromJobs,
} from "./print-dedupe.ts";

/** 同 `PrintJob` 結構相容嘅最小形狀（測試唔 import 型別，避免 node --test 要解別名）。 */
type Job = {
  orderId?: string;
  printerId?: string;
  printerName?: string;
  tableName?: string;
  onceKey?: string;
};

test("冇 onceKey → 唔參與去重（手動補打／加菜／退菜／返結）", () => {
  assert.equal(printOnceKey({ orderId: "o1", printerId: "p1" }), null);
  assert.equal(printOnceKey({ orderId: "o1", onceKey: "" , printerId: "p1" }), null);
  assert.equal(printOnceKey({ onceKey: "receipt:0", printerId: "p1" }), null); // 冇 orderId
  assert.equal(printOnceKey(null), null);
  assert.equal(printOnceKey(undefined), null);

  const manual: Job[] = [
    { orderId: "o1", printerId: "p1" }, // 撳第一次
    { orderId: "o1", printerId: "p1" }, // 撳第二次 —— 要照印
  ];
  const { kept, skipped } = dedupeOnceJobs(manual, ["o1|receipt:0|p1"]);
  assert.equal(kept.length, 2);
  assert.deepEqual(skipped, []);
});

test("🔴 核心迴歸：同一件事重複建 job（兩個視窗各自出一次）→ 只留一張", () => {
  // 商家實案：10:58:00.373 / 10:58:01.324 / 10:58:01.340 / 10:58:06.711
  // 4 張收據，同一個 order_id、同一部機、同一代結帳（reopenCount = 0）。
  const jobs: Job[] = [
    { orderId: "ledger-e26fa77b", printerId: "printer-22a790b1", tableName: "堂食", onceKey: "receipt:0" },
    { orderId: "ledger-e26fa77b", printerId: "printer-22a790b1", tableName: "A01", onceKey: "receipt:0" },
    { orderId: "ledger-e26fa77b", printerId: "printer-22a790b1", tableName: "堂食", onceKey: "receipt:0" },
    { orderId: "ledger-e26fa77b", printerId: "printer-22a790b1", tableName: "A01", onceKey: "receipt:0" },
  ];
  const { kept, skipped } = dedupeOnceJobs(jobs, []);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.tableName, "堂食"); // 第一張贏（後到嘅一律略過）
  assert.equal(skipped.length, 3);

  // 交叉驗證：快照唔同（堂食 / A01）都算**同一件事** —— 呢個就係唔可以用內容 hash 嘅原因。
  assert.equal(
    printOnceKey(jobs[0]!),
    printOnceKey(jobs[1]!),
  );
});

test("唔同打印機 → 各自一張（每部機都要有紙）", () => {
  const jobs: Job[] = [
    { orderId: "o1", printerId: "p-receipt-1", onceKey: "receipt:0" },
    { orderId: "o1", printerId: "p-receipt-2", onceKey: "receipt:0" },
  ];
  const { kept } = dedupeOnceJobs(jobs, []);
  assert.equal(kept.length, 2);
});

test("🔴 返結重結 = 第二次合法結帳 → 世代唔同，唔可以被攔", () => {
  const first = { orderId: "o1", printerId: "p1", onceKey: "receipt:0" };
  const afterReopen = { orderId: "o1", printerId: "p1", onceKey: "receipt:1" };
  const { kept, skipped } = dedupeOnceJobs([afterReopen], [printOnceKey(first)!]);
  assert.equal(kept.length, 1);
  assert.deepEqual(skipped, []);
});

test("跨視窗：帳本已有嗰條鍵 → 第二個 realm 唔會再出（localStorage 係共用）", () => {
  const seen = mergeOnceKeys([], collectOnceKeys([{ orderId: "o1", printerId: "p1", onceKey: "kitchen:normal:0" }]));
  const { kept } = dedupeOnceJobs([{ orderId: "o1", printerId: "p1", onceKey: "kitchen:normal:0" }], seen);
  assert.equal(kept.length, 0);
});

test("廚房單：落單（normal）vs 加菜（addon）vs 返結（void）互不干擾", () => {
  // 落單同加菜係唔同 onceKey ⇒ 唔會互相攔；加菜每次係新一輪，本來就唔寫 onceKey。
  const normal = { orderId: "o1", printerId: "p-zone", onceKey: "kitchen:normal:0" };
  assert.notEqual(printOnceKey(normal), printOnceKey({ ...normal, onceKey: "kitchen:void:ledger_cancel" }));
  // 加菜／退菜／返結（冇 onceKey）永遠保留
  const { kept } = dedupeOnceJobs(
    [
      { orderId: "o1", printerId: "p-zone" }, // 加菜第 1 輪
      { orderId: "o1", printerId: "p-zone" }, // 加菜第 2 輪（同一道菜再加）
      { orderId: "o1", printerId: "p-zone" }, // 退菜
      { orderId: "o1", printerId: "p-zone" }, // 返結
    ],
    [printOnceKey(normal)!],
  );
  assert.equal(kept.length, 4);
});

test("打印機冇 id → 退回 printerName 做鍵（同一部機唔會當成兩部）", () => {
  assert.equal(
    printOnceKey({ orderId: "o1", printerName: "小票機 · 通用 80mm", onceKey: "receipt:0" }),
    "o1|receipt:0|小票機 · 通用 80mm",
  );
  assert.equal(printOnceKey({ orderId: "o1", onceKey: "receipt:0" }), "o1|receipt:0|");
});

test("由現存 job 推導鍵（雲端 backfill 返落本機嘅別台機 job）", () => {
  const local = [
    { orderId: "o1", printerId: "p1", onceKey: "receipt:0" },
    { orderId: "o1", printerId: "p1" }, // 手動補打，冇鍵
  ];
  assert.deepEqual(seenKeysFromJobs(local), ["o1|receipt:0|p1"]);
});

test("帳本：去重、保留插入順序、由最舊開始掉", () => {
  const merged = mergeOnceKeys(["a", "b"], ["b", "c", "a", "d"]);
  assert.deepEqual(merged, ["a", "b", "c", "d"]);
  const capped = mergeOnceKeys(["a", "b", "c"], ["d"], 3);
  assert.deepEqual(capped, ["b", "c", "d"]); // 「a」係最舊 → 掉
  assert.deepEqual(mergeOnceKeys([], [], 0), []); // 非法上限 → 回預設（唔會爆）
});

test("兩個視窗同時落單：同一批入面出現同鍵 → 只留第一張", () => {
  const batch: Job[] = [
    { orderId: "o1", printerId: "p1", onceKey: "receipt:0" },
    { orderId: "o1", printerId: "p1", onceKey: "receipt:0" },
  ];
  const { kept } = dedupeOnceJobs(batch, []);
  assert.equal(kept.length, 1);
});

test("廚房單內容簽名：內容一樣 → 一樣（兩個視窗嘅補印兜底收成一張）", () => {
  const a = printOnceContentSignature([
    { name: "凍檸茶", quantity: 2, specs: ["飲料:湯", "熱定凍:熱"] },
    { name: "沙姜炒猪颈肉饭", quantity: 1 },
  ]);
  const b = printOnceContentSignature([
    { name: "凍檸茶", quantity: 2, specs: ["飲料:湯", "熱定凍:熱"] },
    { name: "沙姜炒猪颈肉饭", quantity: 1 },
  ]);
  assert.equal(a, b);
  assert.notEqual(a, "0");
});

test("🔴 廚房單內容簽名：客人改單 → 簽名必須唔同（否則廚房永遠收唔到新內容）", () => {
  const before = printOnceContentSignature([{ name: "沙姜炒猪颈肉饭", quantity: 1 }]);
  const afterQty = printOnceContentSignature([{ name: "沙姜炒猪颈肉饭", quantity: 2 }]);
  const afterSpec = printOnceContentSignature([
    { name: "沙姜炒猪颈肉饭", quantity: 1, specs: ["少油"] },
  ]);
  const afterNote = printOnceContentSignature([
    { name: "沙姜炒猪颈肉饭", quantity: 1, note: "唔要蔥" },
  ]);
  assert.notEqual(before, afterQty);
  assert.notEqual(before, afterSpec);
  assert.notEqual(before, afterNote);
});

test("冇 items（純文字單）→ 簽名固定為 0（唔會因空陣列而變）", () => {
  assert.equal(printOnceContentSignature([]), "0");
  assert.equal(printOnceContentSignature(undefined), "0");
  assert.equal(printOnceContentSignature(null), "0");
});

test("廚房單：同一次事件（同 scope＋同內容）→ 同一鍵，只出一張", () => {
  const sig = printOnceContentSignature([{ name: "沙姜炒猪颈肉饭", quantity: 1, price: 44 }]);
  const job: Job = { orderId: "ledger-x", printerId: "p-zone", onceKey: `kitchen:normal:0:${sig}` };
  const { kept, skipped } = dedupeOnceJobs([job, { ...job }], []);
  assert.equal(kept.length, 1);
  assert.equal(skipped.length, 1);
  // 返結後重結（世代 +1）→ 新鍵，唔會被攔。
  const nextGen: Job = { ...job, onceKey: `kitchen:normal:1:${sig}` };
  assert.equal(dedupeOnceJobs([nextGen], [printOnceKey(job)!]).kept.length, 1);
});

// ── 2026-09-24 DB 側鍵（`pos_print_jobs.once_key`）──────────────────────────
// 病根：DB 唯一索引係 (store_id, once_key)，而舊寫法只寫**原始 onceKey**
// ⇒ 自動收據 `receipt:0` 全店共用一條鍵 ⇒ 第二張起全部 23505 被靜默吞掉。

test("🔴 DB 鍵必須含訂單身分：兩張唔同單嘅自動收據唔可以撞同一條鍵", () => {
  const a = printOnceDbKey({ orderId: "order-aaa", onceKey: "receipt:0", printerId: "p-rec" });
  const b = printOnceDbKey({ orderId: "order-bbb", onceKey: "receipt:0", printerId: "p-rec" });
  assert.ok(a && b);
  assert.notEqual(a, b); // 舊寫法兩者都係 "receipt:0" → 必撞
  // 同一張單同一代 → 一定要一樣（呢個係去重成立嘅前提）
  assert.equal(
    a,
    printOnceDbKey({ orderId: " order-aaa ", onceKey: " receipt:0 ", printerId: "p-rec" }),
  );
});

test("DB 鍵：冇 printerId 時退回 printerName；兩者都冇仍然成鍵（尾巴留空）", () => {
  assert.equal(
    printOnceDbKey({ orderId: "o1", onceKey: "receipt:0", printerName: "小票機" }),
    "o1|receipt:0|小票機",
  );
  assert.equal(printOnceDbKey({ orderId: "o1", onceKey: "receipt:0" }), "o1|receipt:0|");
});

test("🔴 DB 鍵：冇 orderId → null（寧可唔去重，都唔可以幾張單共用一條鍵）", () => {
  assert.equal(printOnceDbKey({ onceKey: "receipt:0", printerId: "p1" }), null);
  assert.equal(printOnceDbKey({ orderId: "o1", onceKey: "", printerId: "p1" }), null);
  assert.equal(printOnceDbKey({ orderId: "o1", printerId: "p1" }), null);
  assert.equal(printOnceDbKey({ orderId: null, onceKey: null }), null);
});

test("DB 鍵超長 → null（唔可以截斷：截斷會令兩條唔同嘅鍵撞埋）", () => {
  const long = "x".repeat(600);
  assert.equal(printOnceDbKey({ orderId: "o1", onceKey: long, printerId: "p1" }), null);
  const okLen = "y".repeat(400);
  assert.equal(typeof printOnceDbKey({ orderId: "o1", onceKey: okLen, printerId: "p1" }), "string");
});

test("DB 鍵 → 原始 onceKey 還原（state backfill 要用返原始值，否則 compose 兩次對唔上）", () => {
  const composed = printOnceDbKey({ orderId: "order-aaa", onceKey: "kitchen:normal:0:abc", printerId: "p1" });
  assert.ok(composed);
  assert.equal(printOnceScopeFromDbKey(composed, "order-aaa", "p1"), "kitchen:normal:0:abc");
  // state payload 冇 printer_id → 剪最後一段都一樣還原得到
  assert.equal(printOnceScopeFromDbKey(composed, "order-aaa", null), "kitchen:normal:0:abc");
  assert.equal(printOnceScopeFromDbKey(composed, "order-aaa", undefined), "kitchen:normal:0:abc");
});

test("還原：舊格式（raw）／空值／唔匹配訂單 → 原樣返回（行為同以前一樣）", () => {
  assert.equal(printOnceScopeFromDbKey("receipt:0", "order-aaa", "p1"), "receipt:0");
  assert.equal(printOnceScopeFromDbKey("kitchen:normal:0:abc", null, null), "kitchen:normal:0:abc");
  assert.equal(printOnceScopeFromDbKey("", "o1", "p1"), undefined);
  assert.equal(printOnceScopeFromDbKey(null, "o1", "p1"), undefined);
  assert.equal(printOnceScopeFromDbKey(undefined, "o1", "p1"), undefined);
});

test("還原 → 再 compose = 原鍵（round-trip 唔會走樣）", () => {
  const dbKey = printOnceDbKey({ orderId: "order-aaa", onceKey: "receipt:0", printerId: "p-rec" });
  assert.ok(dbKey);
  const scope = printOnceScopeFromDbKey(dbKey, "order-aaa", "p-rec");
  assert.equal(printOnceDbKey({ orderId: "order-aaa", onceKey: scope, printerId: "p-rec" }), dbKey);
});
