#!/usr/bin/env node
/**
 * 驗證「PrintJob 一定要自己講清楚係咩單（`kind`）」呢條紅線。
 *
 * 背景 —— 同一個病**中過兩次**：
 *   1. 2026-09-10：杯標籤（label）冇 `kind` → 被當 kitchen 出單，
 *      標籤頂硬印「＊＊＊ 廚房 ＊＊＊」，版面錯晒；
 *   2. 2026-09-13：交班單（shift）冇 `kind` → 打印中心「查看」回退廚房兜底，
 *      印錯抬頭 **＋** 完全讀唔到 `job.content`（交班數字全部喺嗰度）
 *      → 商家見到嘅係「一張空白單」。
 *
 * 兩次根因一模一樣：**任務冇講清楚自己係咩單，下游只能猜**。
 * 呢個檢查把「猜」嘅機會封死 —— 任何 builder 漏寫 `kind` 都會即刻現形。
 *
 * 用法：node tools/verify-print-job-kind.cjs
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? "  <- " + detail : ""}`);
  }
}

console.log("[verify-print-job-kind] PrintJob.kind 紅線檢查\n");

// ── 1. 型別層：PrintJob 帶 kind，PrintKind 認得 shift ──
const types = read("src/lib/types.ts");
const printJobStart = types.indexOf("export interface PrintJob");
const printKindStart = types.indexOf("export type PrintKind");
check(
  "types.ts: PrintJob 有 kind?: PrintKind",
  printJobStart >= 0 && printKindStart > printJobStart && /kind\?:\s*PrintKind/.test(types.slice(printJobStart, printKindStart)),
);
check('types.ts: PrintKind 有 "shift" 成員', /export type PrintKind\s*=[^;]*"shift"/.test(types));

// ── 2. 每個 builder 都要帶 kind ──
const printJobs = read("src/lib/print-jobs.ts");
for (const kind of ["shift", "receipt", "kitchen", "label"]) {
  check(`print-jobs.ts: 有 builder 帶 kind: "${kind}"`, new RegExp(`kind:\\s*"${kind}"`).test(printJobs));
}

// ── 3. 冇模板快照時嘅兜底：一定要按 kind 分流，唔可以無腦套廚房模板 ──
const preview = read("src/components/kitchen-ticket-preview.tsx");
check("kitchen-ticket-preview.tsx: 交班單有獨立分流", /isShiftJob\(job\)/.test(preview));
check(
  "kitchen-ticket-preview.tsx: 交班分支用預設交班模板（讀得到 content）",
  /DEFAULT_SHIFT_TEMPLATE/.test(preview),
);

// ── 4. 派發層：job.kind 排最前，唔好靠 printer.role 猜 ──
const dispatch = read("src/lib/print-bridge/dispatch.ts");
check(
  "dispatch.ts: job.kind ?? 排喺 job.template?.kind 之前",
  /kind:\s*PrintKind\s*=[\s\S]{0,40}job\.kind\s*\?\?/.test(dispatch),
);

// ── 5. 交班單落本機必須行統一入口（去重 + tombstone + 通知 UI）──
const shift = read("src/components/shift-page.tsx");
check("shift-page.tsx: 用 persistMergedPrintJobs()", /persistMergedPrintJobs\(/.test(shift));
check(
  "shift-page.tsx: 冇再 [job, ...loadPrintJobs()] + savePrintJobs() 直寫",
  !/savePrintJobs\(nextPrintJobs\)/.test(shift),
);

if (failures.length > 0) {
  console.error(`\n[verify-print-job-kind] ${failures.length} 項失敗`);
  process.exit(1);
}
console.log("\n[verify-print-job-kind] 全部通過");
