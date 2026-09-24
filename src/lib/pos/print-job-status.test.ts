// 2026-09-24 商家實案：「打印中心一排『空白單號 + kitchen + 狀態欄位異常 + 失敗』，
// 但其實冇一張真係印唔到」——雲端 `printing` 過渡態唔在本機狀態詞彙表內，
// 落到本機被 `normalizePrintJobStatus()` 一律標成失敗。
//
// 跑法：node --test src/lib/pos/print-job-status.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLOUD_PRINT_JOB_STATUSES,
  PRINT_JOB_STATUSES,
  PRINT_JOB_STATUS_LABELS,
  PRINT_JOB_STATUS_TONES,
  TERMINAL_PRINT_JOB_STATUSES,
  cloudRowToPrintJobStatus,
  isPrintJobStatus,
  isTerminalPrintJobStatus,
  toPrintJobStatus,
} from "./print-job-status.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..", "..");
const read = (rel: string) => readFileSync(path.join(SRC_ROOT, rel), "utf8");
const flat = (s: string) => s.replace(/[ \t\r\n]+/g, " ");

test("🔴 雲端過渡態 printing 一定要合法（唔可以再被當成「狀態欄位異常」）", () => {
  assert.equal(isPrintJobStatus("printing"), true);
  assert.equal(toPrintJobStatus("printing"), "printing");
  assert.equal(cloudRowToPrintJobStatus("printing"), "printing");
  assert.equal(isTerminalPrintJobStatus("printing"), false);
});

test("法定值全部原樣透傳（唔可以中途改寫）", () => {
  for (const s of PRINT_JOB_STATUSES) assert.equal(toPrintJobStatus(s), s);
});

test("未知值／壞值 → pending（唔可以當 failed：假紅標會蓋住真失敗單）", () => {
  for (const bad of [undefined, null, "", "claimed", "PRINTED", "ok", 0, {}, []]) {
    assert.equal(toPrintJobStatus(bad), "pending");
    assert.equal(cloudRowToPrintJobStatus(bad), "pending");
  }
});

test("雲端 row 只認雲端會出嘅值（sent 係本機側，雲端 row 有 sent → 當 pending）", () => {
  assert.deepEqual([...CLOUD_PRINT_JOB_STATUSES], ["pending", "printing", "printed", "failed"]);
  assert.equal(cloudRowToPrintJobStatus("sent"), "pending");
  assert.equal(cloudRowToPrintJobStatus("printed"), "printed");
  assert.equal(cloudRowToPrintJobStatus("failed"), "failed");
});

test("終態只有 printed / failed", () => {
  assert.deepEqual([...TERMINAL_PRINT_JOB_STATUSES], ["printed", "failed"]);
  for (const s of PRINT_JOB_STATUSES) {
    assert.equal(isTerminalPrintJobStatus(s), s === "printed" || s === "failed");
  }
});

test("每個狀態都要有標籤同顏色（唔可以漏，否則 UI 顯示 undefined）", () => {
  for (const s of PRINT_JOB_STATUSES) {
    assert.ok(PRINT_JOB_STATUS_LABELS[s], `缺 ${s} 嘅中文標籤`);
    assert.ok(PRINT_JOB_STATUS_TONES[s], `缺 ${s} 嘅顏色 key`);
  }
  assert.equal(PRINT_JOB_STATUS_LABELS.printing, "出紙中");
  assert.notEqual(PRINT_JOB_STATUS_TONES.printing, "red"); // 過渡態唔算失敗
  assert.equal(PRINT_JOB_STATUS_TONES.failed, "red");
});

// ── 原始碼守衛：呢三條修復唔可以被無聲改返 ───────────────────────────────

test("守衛①：`types.ts` 嘅 PrintJob.status 一定要包含 printing", () => {
  const src = flat(read("lib/types.ts"));
  assert.ok(
    src.includes('status: "pending" | "printing" | "sent" | "failed" | "printed"'),
    "PrintJob.status 少咗 printing ⇒ 雲端過渡態又會被 normalizePrintJobStatus() 標成失敗",
  );
});

test("守衛②：兩個 mapper 都要經 toPrintJobStatus 白名單（唔可以再裸 cast）", () => {
  const mapper = read("lib/pos/pos-order-mapper.ts");
  assert.ok(
    /cloudRowToPrintJobStatus\(row\.status\)/.test(mapper),
    "mapPosPrintJobRow 唔再經白名單 ⇒ 未知狀態會直入本機",
  );
  const state = read("app/api/pos/state/route.ts");
  assert.ok(
    /cloudRowToPrintJobStatus\(job\.status\)/.test(state),
    "/api/pos/state 唔再經白名單 ⇒ backfill 落本機嘅未知狀態會被當成壞資料",
  );
});

test("🔴 守衛③：`/api/pos/sync` 寫 DB 嘅 once_key 一定要含訂單身分（printOnceDbKey）", () => {
  const src = read("app/api/pos/sync/route.ts");
  assert.ok(
    src.includes("printOnceDbKey("),
    "sync route 唔再砌 composed 鍵 ⇒ 自動收據 `receipt:0` 又會全店撞鍵被靜默吞掉",
  );
  assert.ok(
    !/once_key: onceKeyScope/.test(src),
    "唔可以直接寫原始 onceKey 落 once_key（咁就係 2026-09-24 事故嘅原貌）",
  );
});

test("🔴 守衛④：三條「正常廚房單」入隊路徑一定要帶 onceKey（否則 DB 兩行、廚房兩張紙）", () => {
  for (const rel of ["components/pos-app.tsx", "lib/pos-orders.ts"]) {
    const src = read(rel);
    const hits = (src.match(/onceKey:\s*`kitchen:normal:\$\{/g) ?? []).length;
    assert.ok(
      hits > 0,
      `${rel} 冇任何 normal 廚房單帶 onceKey ⇒ 同線上單接單嗰條路會各出一張紙`,
    );
  }
  // pos-app 有兩處（backfill ＋ realtime 首見自助單）
  assert.ok(
    (read("components/pos-app.tsx").match(/onceKey:\s*`kitchen:normal:\$\{/g) ?? []).length >= 2,
    "pos-app.tsx 應該有兩處（backfill ＋ realtime）",
  );
});
