import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * 庫存四項改動 —— 第 1 批（P1）合約守衛（2026-10-07）。
 *
 * 釘死三件事，防止將來重構時靜靜改走：
 *   項目 3：收據時間顯示「年/月/日 時:分:秒」
 *   項目 1 第 1 層：庫存表預設收合（但低庫存永不被收埋）
 *   項目 4A：品類必填（前端擋＋server 擋；但 PATCH 唔可以擋）
 *
 * 🔴 `node --test` 唔認 `@/` alias、唔支援 render `.tsx`
 *    ⇒ 同 `i18n-layer-guard.test.ts` 一樣讀**原始碼**做字串斷言。
 * 🔴 必須先 `stripComments()`：本檔同被掃嘅檔都寫滿解釋陷阱嘅註解，
 *    註解入面出現同一段字串會令測試報**假 failure**（2026-10-07 實測）。
 */

const SRC = new URL("../../", import.meta.url);

function readSrc(rel: string): string {
  return readFileSync(new URL(rel, SRC), "utf8");
}

/** 剝走註解（換成等長空白，保留字元位置）。 */
function stripComments(code: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return code
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + " ".repeat(200));
}

const VIEW = "src/components/inventory/inventory-view.tsx";
const TABLE = "src/components/inventory/inventory-table.tsx";
const RECEIPTS_API = "src/app/api/inventory/receipts/route.ts";

// ─────────────────────────────────────────────────────────────
// 項目 3：收據時間「年/月/日 時:分:秒」
// ─────────────────────────────────────────────────────────────

test("項目3：receipt-timestamp 模組存在且匯出必要函式", () => {
  const src = readSrc("src/lib/receipt-timestamp.ts");
  for (const fn of [
    "export function slashDate",
    "export function macauTimeOfDay",
    "export function formatReceiptStamp",
    "export function isBackdatedReceipt",
    "export function receiptStampLabel",
  ]) {
    assert.ok(src.includes(fn), `receipt-timestamp.ts 缺少 ${fn}`);
  }
});

test("項目3：🔴 一定要用 Asia/Macau，唔可以用 getHours/toISOString", () => {
  const src = stripComments(readSrc("src/lib/receipt-timestamp.ts"));
  assert.ok(src.includes("Asia/Macau"), "必須以 Asia/Macau 做時區");
  // 呢兩個係歷史上反覆出錯嘅根源（Vercel 係 UTC ⇒ 必然差 8 小時）
  assert.ok(!/\.getHours\s*\(/.test(src), "唔可以用 getHours()（受執行環境時區影響）");
  assert.ok(
    !/\.toISOString\s*\(\s*\)\s*\.(slice|substring|split)/.test(src),
    "唔可以用 toISOString() 去取日期／時間（永遠係 UTC）",
  );
});

test("項目3：收據卡片改用 formatReceiptStamp／receiptStampLabel，唔再直接印 receipt_date", () => {
  const src = stripComments(readSrc(VIEW));
  assert.ok(src.includes("receiptStampLabel"), "inventory-view 應該用 receiptStampLabel 砌顯示");
  // 舊寫法：{r.receipt_date} 直接 render
  assert.ok(
    !/\{r\.receipt_date\}/.test(src),
    "唔應該再直接 render {r.receipt_date} —— 要用 receiptStampLabel() 出年月日時分秒",
  );
});

test("項目3：Receipt 型別有 created_at，且係 nullable（舊資料要降級）", () => {
  const src = stripComments(readSrc(VIEW));
  assert.ok(
    /created_at\?:\s*string\s*\|\s*null/.test(src),
    "Receipt.created_at 必須係 optional + nullable —— 舊資料 / 未部署 API 時冇值",
  );
});

test("項目3：API enriched 帶出 created_at（唔可以再漏）", () => {
  const src = stripComments(readSrc(RECEIPTS_API));
  assert.ok(
    /created_at:\s*typeof\s+src\?\.created_at/.test(src),
    "enriched 必須把 created_at 傳出；否則前端攞唔到時分秒",
  );
});

// ─────────────────────────────────────────────────────────────
// 項目 1 第 1 層：庫存表預設收合
// ─────────────────────────────────────────────────────────────

test("項目1：庫存表有 showAll 開關，預設 false", () => {
  const src = stripComments(readSrc(TABLE));
  assert.ok(
    /useState\(\s*false\s*\)/.test(src),
    "showAll 應該係 useState(false) —— 預設收合",
  );
  assert.ok(src.includes("showAll"), "應該有 showAll 開關");
});

test("項目1：🔴 低庫存嘅一定要顯示 —— 唔可以被收合邏輯排除", () => {
  const src = stripComments(readSrc(TABLE));
  // 收合後嘅清單必須係「低庫存 ∪ 部分常用」；關鍵係 lowList 一定要在內
  assert.ok(
    /visibleProducts\s*=\s*showAll\s*\?\s*products\s*:\s*\[\s*\.\.\.lowList/.test(src),
    "visibleProducts 必須包含 ...lowList（低庫存永遠顯示）",
  );
});

test("項目1：有展開／收合按鈕，且條件 render（唔留空殼）", () => {
  const src = stripComments(readSrc(TABLE));
  assert.ok(src.includes("顯示全部"), "應該有「顯示全部（+N）」按鈕");
  assert.ok(src.includes("hiddenCount"), "應該有 hiddenCount 去算收埋幾多個");
  // 條件式 UI 要整塊條件 render（memory §6）
  assert.ok(
    /hiddenCount\s*>\s*0\s*\|\|\s*showAll/.test(src),
    "收合橫幅應該條件 render（hiddenCount > 0 || showAll），冇嘢收埋時唔應該出",
  );
});

test("項目1：展開按鈕觸控高度 ≥ 40px", () => {
  const src = readSrc(TABLE);
  // 觸控規範：min-h-[40px]。
  // ⚠️ 呢個跑**原始碼**（唔剝註解）：`顯示全部` 呢個字串喺上方註解都出現過，
  //    而 className 喺 button 嘅 children 之前 ⇒ 用最後一次出現、向前搵。
  const idx = src.lastIndexOf("顯示全部");
  assert.ok(idx > 0, "找不到顯示全部按鈕");
  const near = src.slice(Math.max(0, idx - 400), idx);
  assert.ok(near.includes("min-h-[40px]"), "展開／收起按鈕要 min-h-[40px]（觸屏）");
  assert.ok(near.includes("<button"), "min-h-[40px] 要喺 button 上面");
});

// ─────────────────────────────────────────────────────────────
// 項目 4A：品類必填
// ─────────────────────────────────────────────────────────────

test("項目4A：前端 save() 有品類必填驗證", () => {
  const src = stripComments(readSrc(VIEW));
  assert.ok(
    /if\s*\(\s*!form\.category\.trim\(\)\s*\)\s*return\s+setErr\(/.test(src),
    "save() 必須擋空白品類",
  );
});

test("項目4A：🔴 「不指定」chip 已移除（品類必填）", () => {
  const src = stripComments(readSrc(VIEW));
  assert.ok(
    !src.includes("不指定"),
    "「不指定」chip 應該已移除 —— 品類改必填，唔可以有『留空』嘅選項",
  );
});

test("項目4A：品類 label 有必填星號", () => {
  const src = readSrc(VIEW);
  const idx = src.indexOf("品類 <span");
  assert.ok(idx > 0, "品類 label 應該有必填星號標記");
  const near = src.slice(idx, idx + 120);
  assert.ok(near.includes("text-red-500"), "必填星號應該係紅色");
});

test("項目4A：server POST 有品類必填驗證（唔可以只靠前端）", () => {
  const src = stripComments(readSrc(RECEIPTS_API));
  assert.ok(
    /String\(body\.category\)\.trim\(\)/.test(src),
    "POST 應該驗證 body.category 非空 —— API 係公開端點，前端驗證擋唔到直接呼叫",
  );
  assert.ok(
    /請選擇品類（必填）/.test(readSrc(RECEIPTS_API)),
    "應該回有意義嘅中文錯誤訊息",
  );
});

test("項目4A：🔴 PATCH 唔可以擋空品類（否則舊收據改金額都做唔到）", () => {
  const src = stripComments(readSrc(RECEIPTS_API));
  // 只掃 POST 函式體：由 `export async function POST` 到下一個 `export async function`
  const postStart = src.indexOf("export async function POST");
  assert.ok(postStart > 0, "找不到 POST");
  const nextExport = src.indexOf("export async function", postStart + 10);
  const postBody = src.slice(postStart, nextExport > 0 ? nextExport : undefined);
  assert.ok(
    postBody.includes("請選擇品類（必填）"),
    "驗證應該在 POST 內",
  );
  // 確認 PATCH 區間冇同一個驗證
  const patchStart = src.indexOf("export async function PATCH");
  if (patchStart > 0) {
    const patchBody = src.slice(patchStart);
    assert.ok(
      !patchBody.includes("請選擇品類（必填）"),
      "PATCH 唔應該要求品類非空 —— 舊收據冇品類，硬擋會令商家連改金額都做唔到",
    );
  }
});

test("項目4A：API 寫入時 category 已 trim 且非 null", () => {
  const src = stripComments(readSrc(RECEIPTS_API));
  assert.ok(
    /category:\s*String\(body\.category\)\.trim\(\)/.test(src),
    "receiptPayload.category 應該係 trim 後嘅字串（唔再係 `|| null`）",
  );
});
