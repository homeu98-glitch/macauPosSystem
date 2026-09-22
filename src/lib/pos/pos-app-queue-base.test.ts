import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * 《收銀端兩個「靜默漏單」來源》守衛（2026-09-22）。
 *
 * 呢兩個 bug 有同一種性質：**唔 throw、唔報錯、測試全綠**，只有生產數據對唔上
 * 才會發現。所以用「讀原始碼做契約」嘅方式鎖住（同 `print-enqueue-callsites.test.ts`、
 * `state-incremental-contract.test.ts` 同一套路）。
 *
 * ## 契約一：`pos-app.tsx` `pushEvents()` 嘅 base 一定要係 `loadQueue()`
 *
 * 結帳 handler 同一個 tick 內會呼叫 `pushEvents()` 兩次：
 *   ① `pushEvents([paymentEvent])`（ORDER_SETTLED）
 *   ② `printReceipt()` → `enqueuePrintJobs()` → `pushEvents([...PRINT_JOB_CREATED])`
 * 兩次都讀同一個 **render 嘅 `queue` state 快照**（`setQueue` 要等 handler 完結先 flush）。
 * 第 ② 次以舊快照重建整條隊列再 `saveQueue()` ⇒ **第 ① 次啱啱入隊嘅 `ORDER_SETTLED`
 * 被靜默冚走** ⇒ 雲端 `pos_orders` 永遠停留 `sent_to_kitchen` ⇒ 報表／交班（純雲端）
 * 搵唔到嗰張單（實案：訂單19 A01 MOP 99）。
 *
 * 同 3602 行 `syncNow()` 嘅註釋係同一個病根（當年已修過一次，呢度係漏咗嘅第二處）。
 *
 * ## 契約二：`enqueuePrintJobs()` 一定要委派 `appendPrintJobsWithSync()`
 *
 * 收據走自製路徑、廚房單走標準路徑 ⇒ 生產實測 **kitchen 35/35 上雲、receipt 只有 3 張
 * 且 `once_key` 全 NULL（＝全部人手補打）**。自製路徑 = 第二套「落本機 + 上雲」語義，
 * 係 `appendPrintJobs` 同名反轉事故嘅翻版（見 `print-enqueue-callsites.test.ts`）。
 *
 * ～ 呢個檔用 `node:test` 直接跑（唔經 bundler）⇒ 只可以 import node 內建模組，
 *   所以檔案路徑一律用相對路徑。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 去掉註解（否則本檔／原始碼嘅說明文字會被當成「呼叫」）→ 掃描器唔會捉到自己。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 由 `function NAME(` 起，取約 `span` 個字元嘅函式體（足夠覆蓋整個小函式）。 */
function bodyOf(source: string, name: string, span = 1000): string {
  const at = source.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `搵唔到 function ${name}()`);
  return source.slice(at, at + span);
}

describe("pos-app.tsx：pushEvents / enqueuePrintJobs 契約（2026-09-22）", () => {
  const raw = readFileSync(path.resolve(HERE, "..", "..", "components", "pos-app.tsx"), "utf8");
  const src = stripComments(raw);

  it("pushEvents() 嘅 base 係 loadQueue()，唔可以係 React state queue", () => {
    const body = bodyOf(src, "pushEvents", 1400);
    assert.match(body, /enqueueEvents\(\s*loadQueue\(\)/, "pushEvents 必須以 loadQueue() 做 base");
    assert.doesNotMatch(
      body,
      /enqueueEvents\(\s*queue\s*,/,
      "唔可以用 React state `queue` 做 base（同一個 tick 第二次呼叫會冚走第一次入隊嘅事件）",
    );
  });

  it("enqueuePrintJobs() 委派 appendPrintJobsWithSync()，唔准自己再砌 PRINT_JOB_CREATED", () => {
    const body = bodyOf(src, "enqueuePrintJobs", 1200);
    assert.match(body, /appendPrintJobsWithSync\(/, "必須行唯一一條「落本機 + 上雲」路徑");
    assert.doesNotMatch(
      body,
      /PRINT_JOB_CREATED/,
      "唔可以自己砌事件（否則會再次出現「本機已發送、雲端零 job」）",
    );
  });

  it("結帳收據唔可以再靜默 no-op（要出得聲）", () => {
    const body = bodyOf(src, "printReceipt", 2000);
    assert.match(body, /describeNoReceiptPrinterError\(/, "冇收據機時要出診斷文案");
    assert.match(body, /isPrintContentEnabled\("receipt"\)[\s\S]{0,400}?setToast\(/, "總開關關咗要講出聲");
  });
});

describe("state/route.ts：增量之下必須兜底未結帳單（2026-09-22）", () => {
  const raw = readFileSync(
    path.resolve(HERE, "..", "..", "app", "api", "pos", "state", "route.ts"),
    "utf8",
  );
  const src = stripComments(raw);

  it("有未結帳狀態集合，並且真係查落去", () => {
    assert.match(src, /const OPEN_ORDER_STATUSES = \[[^\]]*"sent_to_kitchen"/, "缺 OPEN_ORDER_STATUSES");
    assert.match(src, /\.in\(\s*"status"\s*,\s*\[\.\.\.OPEN_ORDER_STATUSES\]\s*\)/, "未見 open 腿查詢");
    assert.match(src, /mergeRowsById\(/, "未見按 id 去重合併");
  });

  it("truncated 判準一定要用「未合併兜底腿之前」嘅行數", () => {
    assert.match(src, /incrementalRawOrderCount/, "缺 incrementalRawOrderCount");
    assert.doesNotMatch(
      src,
      /isIncrementalTruncated\(orders\.length,\s*limit\)/,
      "唔可以用合併後 orders.length —— 兜底腿刻意多回，會誤判撞 limit 令 client 每次走全量",
    );
  });
});
