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

  /**
   * 🔴 自動隔離（`auto-full-pull`）會令枱面卡片即刻變「空閒」——
   *    如果冇可見提示，收銀只會見到「張單閃一下就走」，完全無從入手（2026-09-22 實案）。
   */
  it("🚫 唔准再自動隔離本機訂單（商家拍板：本機訂單一律保留到同步上雲）", () => {
    assert.doesNotMatch(src, /quarantineOrders\(/, "pos-app 唔應該再有任何自動隔離呼叫");
    assert.match(src, /restoreAllQuarantinedOrders\(/, "要一次性把舊隔離區還原返本機");
  });

  /**
   * 🔴 水位一旦被推過，之後只回差量 ⇒ 今次冇收到嘅訂單**永遠補唔返**。
   *    所以一定要等真係收到 `orders` 陣列才 commit 水位。
   */
  it("增量水位只可以在真係收到 orders 陣列時才推進", () => {
    assert.match(src, /const payloadHasOrders = Array\.isArray\(payload\.orders\)/, "缺 payloadHasOrders 守門");
    assert.match(src, /\} else if \(payloadHasOrders\) \{\s*\n\s*commitStateSince\(sinceTicket\);/, "commit 未綁住 payloadHasOrders");
    assert.doesNotMatch(
      src,
      /\} else \{\s*\n\s*commitStateSince\(sinceTicket\);\s*\n\s*\}/,
      "唔可以喺 else 分支無條件 commit 水位",
    );
  });
});

describe("storage.ts：orders store 有 id 命名空間守衛（2026-09-22）", () => {
  const src = stripComments(readFileSync(path.resolve(HERE, "..", "storage.ts"), "utf8"));

  it("loadOrders 一定要過 splitNonOrderRows，並自我修復寫返乾淨版本", () => {
    const at = src.indexOf("export function loadOrders(");
    assert.notEqual(at, -1, "搵唔到 loadOrders()");
    const body = src.slice(at, at + 1600);
    assert.match(body, /splitNonOrderRows\(/, "loadOrders 冇過 id 命名空間守衛");
    assert.match(body, /writeStoreJson\(STORE_SUFFIX\.orders, orders\)/, "發現垃圾後冇自我修復");
  });
});

describe("state/route.ts：唔可以回「雲端冇單」嘅假象（2026-09-22）", () => {
  const src = stripComments(
    readFileSync(path.resolve(HERE, "..", "..", "app", "api", "pos", "state", "route.ts"), "utf8"),
  );

  it("未結帳狀態集合只由 legacyThrottled 骨架使用（唯一需要兜底嘅路徑）", () => {
    assert.match(src, /const OPEN_ORDER_STATUSES = \[[^\]]*"sent_to_kitchen"/, "缺 OPEN_ORDER_STATUSES");
    assert.match(src, /\.in\(\s*"status"\s*,\s*\[\.\.\.OPEN_ORDER_STATUSES\]\s*\)/, "未見 open 查詢");
  });

  /**
   * 🔴 商家硬要求「唔可以增加任何流量」。增量拉取係**最頻繁**嘅一條路（每次開頁／
   *    水位差量），所以佢一定要保持**單腿零額外查詢**；任何「兜底腿」都唔准加返。
   */
  it("增量拉取唔准加任何額外查詢（零流量增長）", () => {
    assert.doesNotMatch(
      src,
      /openOrdersPromise|openFallbackRows|mergeRowsById/,
      "增量之下又加咗兜底查詢／合併 —— 每條拉取多一次 round trip，違反「唔增加流量」",
    );
    assert.match(
      src,
      /isIncrementalTruncated\(orders\.length,\s*limit\)/,
      "truncated 判準應該直接用實際回傳行數",
    );
  });

  /**
   * 🔴 舊 bundle 唔識 `incremental` 欄 ⇒ 空 `orders` 會被佢嘅孤兒對賬當成
   *    「雲端一張單都冇」⇒ 本機所有未結帳單一次過被隔離（枱面清空）。
   *    legacyThrottled 只會發生喺舊 bundle，所以呢條路**絕對唔可以**回 `orders: []`。
   */
  it("legacyThrottled 節流骨架一定要回未結帳單，唔可以回空 orders", () => {
    const at = src.indexOf("if (legacyThrottled && supabase) {");
    assert.notEqual(at, -1, "搵唔到 legacyThrottled 分支（或者漏咗 `&& supabase` 守門）");
    // ⚠️ 一定要**只切到呢個分支為止**：再落少少就係 mock 模式嘅 `orders: []`
    //    （`if (!supabase)`），會產生假失敗。
    const end = src.indexOf("if (!supabase)", at);
    assert.notEqual(end, -1, "搵唔到 legacyThrottled 分支嘅結尾（下一個 `if (!supabase)`）");
    const branch = src.slice(at, end);
    // 兩種形狀都接受：直查 `await supabase…`，或經 42703 降級包裝
    // `await runOrderQueryWithColumnFallback((columns) => supabase…)`（2026-09-24・0057 起）。
    // 重點係「有查未結帳單」同「唔可以回空」，唔係查詢寫喺邊一度。
    assert.match(
      branch,
      /const openRes = await (runOrderQueryWithColumnFallback|supabase)/,
      "節流骨架冇查未結帳單",
    );
    assert.match(branch, /throttleOrders/, "節流骨架冇用查返嚟嘅未結帳單");
    assert.doesNotMatch(branch, /orders:\s*\[\]/, "唔可以回空 orders（會被舊 client 當成雲端冇單）");
  });
});
