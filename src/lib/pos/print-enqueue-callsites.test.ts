import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * 《`appendPrintJobs` 呼叫端》守衛（2026-09-22）—— 防同一個 bug 第三次發生。
 *
 * ## 為何要守（血淚）
 *
 * `appendPrintJobs()` 喺 2026-09-11（commit `1e08343`）被**同名反轉語義**：
 *
 * | 版本 | 行為 |
 * |---|---|
 * | 舊（≤ 2026-09-10） | 落本機 ＋ 推 `PRINT_JOB_CREATED` 上雲 ⇒ **會出紙** |
 * | 新（2026-09-11 起） | **只寫本機**（同步版改名 `appendPrintJobsWithSync`） |
 *
 * 因為**同名、同簽名、同回傳**，TypeScript、ESLint、所有單測**全部唔會出聲**，
 * 5 個呼叫端就咁由「印得出」靜默變成「永遠印唔出」——打印中心顯示乾淨綠色「已發送」、
 * 冇紅標、**連「未上雲」徽章都冇**（因為連事件都冇入過 queue），足足潛伏 11 日。
 *
 * 店內實體出紙通道係「雲端 `pos_print_jobs` → 中繼 APK claim 出紙」，而雲端嗰行
 * **只有** `PRINT_JOB_CREATED` 事件會寫（`RelayTransport.send()` 係 no-op）——
 * 所以「只寫本機」≠「慢」，係「**一張紙都唔會出**」。
 *
 * ## 唯一合法用法
 *
 * `src/lib/print-jobs.ts` 嘅 `printKioskReceiptForOrder()`：Kiosk 顧客小票係
 * **刻意本機限定**（docs/87 §3.1 —— 推上雲會令收銀端 merge 落本機再印多一次）。
 *
 * ⚠️ 呢個測試用 `node:test` 直接跑（唔經 bundler）⇒ 只可以用 node 內建模組，
 * 唔可以 import `@/` 別名、亦唔可以係 `.tsx`。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `src/` 根（呢個檔喺 `src/lib/pos/`）。 */
const SRC_ROOT = path.resolve(HERE, "..", "..");

/** 白名單（相對 `src/`，一律用 `/`）：函數定義本身 ＋ 刻意本機限定嘅 Kiosk 小票。 */
const ALLOWED = new Map<string, number>([["lib/print-jobs.ts", 2]]);

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build"]);

/**
 * 🔴 刻意用**字串拼接**砌 needle，唔可以寫成完整 regex literal（例如 ``/appendPrintJobs\(/``）——
 * 呢個檔本身要提及嗰個函數名，寫成 literal 就會出現一次「看似呼叫」嘅匹配，
 * **掃描器會捉到自己**（2026-09-22 實測踩過：白名單外多出 `print-enqueue-callsites.test.ts`）。
 * 拼接之後原始碼唔會包含 `函數名 ＋ (` 呢個連續字串。
 */
const CALL_NEEDLE = new RegExp(`${"append" + "PrintJobs"}\\s*\\(`);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** 去掉註解行之後嘅 `appendPrintJobs(` 呼叫（行號由 1 起）。 */
function findCalls(file: string): number[] {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const hits: number[] = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    // 跳過單行／區塊註解行（例如 kiosk-order.ts 文件註解入面提到 `appendPrintJobs()`）。
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    // ⚠️ 唔可以連 `appendPrintJobsWithSync(` 一齊數（佢係正確做法）。
    if (CALL_NEEDLE.test(line)) hits.push(idx + 1);
  });
  return hits;
}

describe("出紙路徑守衛 ── `appendPrintJobs` 唔可以再用於自動路徑", () => {
  const files = walk(SRC_ROOT);
  const found = new Map<string, number[]>();
  for (const file of files) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
    const hits = findCalls(file);
    if (hits.length > 0) found.set(rel, hits);
  }

  it("掃描範圍健全（唔可以因為掃唔到檔案而假綠）", () => {
    assert.ok(files.length > 300, `只掃到 ${files.length} 個檔案，路徑應該錯咗`);
    assert.ok(
      found.has("lib/print-jobs.ts"),
      "連 `lib/print-jobs.ts` 都掃唔到呼叫 ⇒ 呢個測試嘅偵測方法失效（唔可以當綠燈）",
    );
  });

  it("🔴 自動出紙路徑一律唔准用 `appendPrintJobs`（只可 `appendPrintJobsWithSync`）", () => {
    const violations: string[] = [];
    for (const [rel, lines] of found) {
      const allowedCount = ALLOWED.get(rel);
      if (allowedCount === undefined) {
        violations.push(`${rel}:${lines.join(",")}`);
        continue;
      }
      if (lines.length !== allowedCount) {
        violations.push(`${rel}:${lines.join(",")}（白名單預期 ${allowedCount} 處）`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      "以下位置用咗「只寫本機」嘅 `appendPrintJobs` ⇒ 打印中心會顯示綠色「已發送」但永遠唔出紙、零紅標、零症狀。\n" +
        "請改用 `appendPrintJobsWithSync()`（`@/lib/pos/print-job-enqueue`）；" +
        "確實需要本機限定（例如 Kiosk 小票）就先加白名單並寫明理由：\n" +
        violations.join("\n"),
    );
  });
});
