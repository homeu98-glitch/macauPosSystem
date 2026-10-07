import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * P2 合約守衛（2026-10-07）：優化 A ＋ 進頁面自動同步。
 *
 * 釘死四件事，防止將來重構時靜靜改走：
 *   ① `syncFromReceipts` 只寫有變嘅行（否則「每次進頁面同步」成本會爆）
 *   ② 自動同步用 ref 擋，deps **唔可以**包 `runSync`／`loadProducts`（否則無限迴圈）
 *   ③ 靜默原則：自動同步冇變化唔提示、失敗唔彈紅字
 *   ④ 收據寫入後嘅同步係 fire-and-forget（唔可以 await／throw）
 *
 * 🔴 `node --test` 唔認 `@/`、唔支援 render `.tsx` ⇒ 讀原始碼做字串斷言。
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

/**
 * 抽出「含有 `marker` 嘅那個 `useEffect`」嘅 deps 陣列文字。
 *
 * 🔴 為何唔可以只 `indexOf("didAutoSync.current = true")` 再切 500 字：
 *    `stripComments()` 會把 `//` 註解換成 **200 個空白**，
 *    於是後面嘅 `]` 好可能落在被清空嘅註解區內 ⇒ 抓到錯誤嘅 deps 邊界，
 *    報一個**完全唔存在嘅假 failure**（2026-10-07 實測中過）。
 *
 * ✅ 做法：由 marker 開始，追蹤括號深度搵返對應嘅 `useEffect(` 呼叫邊界，
 *    再喺入面搵最尾嘅 `, [ ... ]` —— 咁就唔受空白填塞影響。
 */
function effectDepsAfter(src: string, marker: string): string | null {
  const idx = src.indexOf(marker);
  if (idx < 0) return null;
  const tail = src.slice(idx);
  // 由 marker 之後搵第一個 `}, [` 或 `]);`（effect 結尾）
  const m = /\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(tail);
  if (m) return `[${m[1]}]`;
  // 冇 deps 陣列 = `});` 形式
  if (/\}\s*\)\s*;/.test(tail)) return "[]";
  return null;
}

const PRODUCTS = "src/lib/inventory-products.ts";
const DIFF = "src/lib/inventory-sync-diff.ts";
const TABLE = "src/components/inventory/inventory-table.tsx";
const ANALYSIS = "src/components/inventory/item-analysis-view.tsx";
const VIEW = "src/components/inventory/inventory-view.tsx";
const SYNC_API = "src/app/api/inventory/products/sync-from-receipts/route.ts";

// ─────────────────────────────────────────────────────────────
// ① 優化 A：只寫有變嘅行
// ─────────────────────────────────────────────────────────────

test("優化A：inventory-sync-diff 模組存在且匯出必要函式", () => {
  const src = readSrc(DIFF);
  for (const fn of [
    "export function hasMaterialChange",
    "export function shouldWriteBaseline",
    "export function syncSummaryText",
    "export const COST_EPSILON",
  ]) {
    assert.ok(src.includes(fn), `inventory-sync-diff.ts 缺少 ${fn}`);
  }
});

test("優化A：syncFromReceipts 有「冇變化就 continue」嘅短路", () => {
  const src = stripComments(readSrc(PRODUCTS));
  assert.ok(src.includes("hasMaterialChange"), "必須呼叫 hasMaterialChange 做差異判斷");
  assert.ok(
    /skippedUnchanged\s*\+=\s*1;\s*continue;/.test(src),
    "冇變化時必須 skippedUnchanged += 1 然後 continue（唔寫入）",
  );
});

test("優化A：SyncSummary 有 skipped_unchanged", () => {
  const src = stripComments(readSrc(PRODUCTS));
  assert.ok(
    /skipped_unchanged:\s*number/.test(src),
    "SyncSummary 必須有 skipped_unchanged 欄位",
  );
});

test("優化A：🔴 目標值同實際寫入 payload 對齊（唔可以各寫各）", () => {
  const src = stripComments(readSrc(PRODUCTS));
  // nextLastDate / nextLastSupplier / nextCategory 要同時出現喺
  // hasMaterialChange 嘅 target 同 update payload
  for (const v of ["nextLastDate", "nextLastSupplier", "nextCategory"]) {
    const count = (src.match(new RegExp(v, "g")) || []).length;
    assert.ok(count >= 3, `${v} 應該至少出現 3 次（宣告 + 差異判斷 + 寫入），實際 ${count}`);
  }
});

test("優化A：🔴 基準價判斷統一走 shouldWriteBaseline（唔可以再用 Number(x) > 0）", () => {
  const src = stripComments(readSrc(PRODUCTS));
  assert.ok(!/Number\([^)]*baseline_unit_cost[^)]*\)\s*>\s*0/.test(src),
    "唔可以再用 Number(x) > 0 判斷基準價 —— 0 係合法基準價（免費贈品）");
  const count = (src.match(/shouldWriteBaseline/g) || []).length;
  assert.ok(count >= 2, `兩條路徑（正常 + duplicate fallback）都要用，實際 ${count} 次`);
});

// ─────────────────────────────────────────────────────────────
// ② 自動同步：ref 擋 + deps 唔可以包 runSync
// ─────────────────────────────────────────────────────────────

for (const [file, label] of [
  [TABLE, "庫存表"],
  [ANALYSIS, "品項分析"],
] as const) {
  test(`自動同步（${label}）：有 didAutoSync ref 擋重複`, () => {
    const src = stripComments(readSrc(file));
    assert.ok(
      /const didAutoSync = useRef\(false\)/.test(src),
      "必須有 didAutoSync ref（保證同一 mount 只同步一次）",
    );
    assert.ok(
      /if \(didAutoSync\.current\) return;/.test(src),
      "必須檢查 didAutoSync.current 後 return",
    );
  });

  test(`自動同步（${label}）：🔴 deps 唔可以包 runSync／loadProducts（否則無限迴圈）`, () => {
    const src = stripComments(readSrc(file));
    const deps = effectDepsAfter(src, "didAutoSync.current = true");
    assert.ok(deps !== null, "找不到自動同步 effect 嘅 deps 陣列");
    // deps 應該只有 merchantId / account（或者空）
    assert.ok(
      !deps.includes("runSync") && !deps.includes("loadProducts"),
      `deps 唔可以包含 runSync／loadProducts —— 佢哋身份隨 render 改變 ⇒ 每次 render 都同步（實際 deps: ${deps}）`,
    );
    assert.ok(
      deps === "[]" || (deps.includes("merchantId") && deps.includes("account")),
      `deps 應該係 [merchantId, account] 或 []，實際 ${deps}`,
    );
  });

  test(`自動同步（${label}）：呼叫時用 silent: true`, () => {
    const src = stripComments(readSrc(file));
    assert.ok(
      /mode: "auto",\s*silent: true/.test(src),
      "自動同步必須 silent: true",
    );
  });
}

// ─────────────────────────────────────────────────────────────
// ③ 靜默原則
// ─────────────────────────────────────────────────────────────

test("靜默原則：共用 syncSummaryText（唔可以各自砌提示）", () => {
  for (const f of [TABLE, ANALYSIS]) {
    const src = stripComments(readSrc(f));
    assert.ok(src.includes("syncSummaryText"), `${f} 應該用共用嘅 syncSummaryText`);
  }
});

test("靜默原則：自動同步失敗時唔彈紅字（唔可以 setErr）", () => {
  const src = stripComments(readSrc(TABLE));
  // silent 分支嘅 catch 要包 if (!silent)
  assert.ok(
    /catch\s*\([^)]*\)\s*\{[^}]*if \(!silent\)/.test(src),
    "catch 內必須用 `if (!silent)` 包住 setErr —— 離線時唔應該彈紅字擋住 UI",
  );
});

test("靜默原則：手動同步仍然有明確回饋（唔可以一律靜默）", () => {
  const src = stripComments(readSrc(TABLE));
  assert.ok(src.includes('mode: "manual", silent: false'), "手動同步必須 silent: false");
  assert.ok(src.includes("同步完成：新增"), "手動同步要有完整回饋文案");
});

// ─────────────────────────────────────────────────────────────
// ④ 收據寫入後 fire-and-forget
// ─────────────────────────────────────────────────────────────

test("收據寫入後同步：inventory-view 有 syncProductsAfterReceiptWrite", () => {
  const src = stripComments(readSrc(VIEW));
  assert.ok(
    src.includes("syncProductsAfterReceiptWrite"),
    "必須有收據寫入後嘅同步觸發函式",
  );
  // ⚠️ 唔可以收窄窗口：stripComments 會把 onSaved 內嘅註解換成 200 個空白，
  //    真實呼叫會落在窗口之後 ⇒ 用「之後 1200 字內有出現」而唔係緊貼。
  const onSavedCount = (src.match(/onSaved=\{\(\) => \{/g) || []).length;
  assert.ok(onSavedCount > 0, "找不到 ReceiptFormModal 嘅 onSaved");
  const lastOnSaved = src.lastIndexOf("onSaved={() => {");
  const body = src.slice(lastOnSaved, lastOnSaved + 1200);
  assert.ok(
    body.includes("syncProductsAfterReceiptWrite()"),
    "ReceiptFormModal 嘅 onSaved 要呼叫 syncProductsAfterReceiptWrite",
  );
});

test("🔴 收據寫入後同步係 fire-and-forget（唔可以 await／throw）", () => {
  const src = stripComments(readSrc(VIEW));
  const idx = src.indexOf("const syncProductsAfterReceiptWrite");
  assert.ok(idx > 0, "找不到 syncProductsAfterReceiptWrite");
  const body = src.slice(idx, idx + 900);
  assert.ok(body.includes("void fetch"), "必須用 `void fetch`（fire-and-forget）");
  assert.ok(body.includes(".catch("), "必須有 .catch() 吞掉錯誤 —— 收據已存好，同步失敗唔應該影響流程");
  assert.ok(!/await fetch/.test(body), "唔可以 await —— 會令商家白等");
});

// ─────────────────────────────────────────────────────────────
// API：mode 只係標籤
// ─────────────────────────────────────────────────────────────

test("API：接 mode 參數且只有 auto/manual 兩種值", () => {
  const src = stripComments(readSrc(SYNC_API));
  assert.ok(src.includes('body?.mode === "auto" ? "auto" : "manual"'), "mode 要收斂做 auto/manual");
});

test("🔴 API：mode 唔可以做行為分支（手動同自動結果必須一致）", () => {
  const src = stripComments(readSrc(SYNC_API));
  const idx = src.indexOf("const mode =");
  const body = src.slice(idx);
  // syncFromReceipts 嘅呼叫唔可以因為 mode 而分岔
  const call = /syncFromReceipts\(macau, store, expense, resolved\.userId\)/.exec(body);
  assert.ok(call, "syncFromReceipts 呼叫唔應該帶 mode（行為必須一致）");
});
