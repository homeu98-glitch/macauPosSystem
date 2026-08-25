// 回歸測試：print job merge 契約（docs/37-printjobs-backfill-rootcause-plan.md P2-6）
// 用 Node built-in test runner，唔引入新依賴：node --test src/lib/pos/print-job-merge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergePrintJobs } from "./print-job-merge.ts";

type PJ = {
  id: string;
  status: "pending" | "sent" | "failed";
};

const job = (id: string, status: PJ["status"]): PJ => ({ id, status });

test("本地 sent 唔被後台落後 pending 覆寫（防重印）", () => {
  const local = [job("a", "sent")];
  const server = [job("a", "pending")]; // 後台仲係 pending（flush 成功後冇回寫 DB）
  const merged = mergePrintJobs(local as any, server as any);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "a");
  assert.equal(merged[0].status, "sent"); // 留本地
});

test("本地有、server 冇 → 原樣保留（離線新單唔被 backfill 清走）", () => {
  const local = [job("offline-1", "sent"), job("offline-2", "pending")];
  const server: PJ[] = []; // 重連時 server 未含呢批離線新單
  const merged = mergePrintJobs(local as any, server as any);
  const ids = merged.map((j) => j.id).sort();
  assert.deepEqual(ids, ["offline-1", "offline-2"]);
});

test("server 有、本地冇 → 補入（跨終端 / realtime 漏咗嘅單喺 backfill 見返）", () => {
  const local: PJ[] = [];
  const server = [job("other-terminal", "sent")];
  const merged = mergePrintJobs(local as any, server as any);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "other-terminal");
});

test("離線→重連模擬：本地 3 張離線新單 + server 已知舊單 → 唔減、唔重印、唔漏", () => {
  const local = [
    job("local-1", "sent"),
    job("local-2", "sent"),
    job("local-3", "pending"), // 離線建、未 sync
    job("old", "sent"), // 本地同 server 都有
  ];
  const server = [
    job("old", "pending"), // 後台落後
    job("peer", "sent"), // 其他終端
  ];
  const merged = mergePrintJobs(local as any, server as any);
  const byId = new Map(merged.map((j) => [j.id, j]));
  // 本地 3 張離線新單全部仲喺
  assert.ok(byId.has("local-1") && byId.has("local-2") && byId.has("local-3"));
  // 本地 sent 冇被 server pending 覆寫（唔重印）
  assert.equal(byId.get("local-1")!.status, "sent");
  assert.equal(byId.get("local-3")!.status, "pending"); // 本地狀態保留
  assert.equal(byId.get("old")!.status, "sent"); // 本地優先
  // 其他終端單補入
  assert.ok(byId.has("peer"));
  // 總數 = 本地 4 + server 獨有 1 (peer) = 5
  assert.equal(merged.length, 5);
});
