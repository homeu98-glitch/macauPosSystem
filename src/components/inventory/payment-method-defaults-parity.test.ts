import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * **跨 repo 對齊守衛**：POS 嘅內建支付方式預設 vs expenseRecorder（admin 主檔）嘅預設。
 *
 * ## 為何要呢個測試
 *
 * 支付方式主檔嘅真源喺 expenseRecorder（admin 喺 `/admin/payment-methods` 維護）。
 * 但 POS 一定要有一份**內建兜底** —— 讀唔到 expenseRecorder 時（未連線／未部署／
 * 網絡問題）庫存頁仍然要有付款方式可揀，唔可以因為對方讀唔到就落唔到單。
 *
 * 兩份清單分屬兩個唔同 repo，冇共用型別、冇 build 期檢查。一旦有人只改一邊
 * （例如 admin 加咗「月結」但 POS 兜底冇加，或者兩邊 label 唔一致），
 * 就會出現「admin 設定同 POS 顯示對唔上」嘅鬼故事，而且**唔會有人即刻發現**。
 *
 * ## 兩個 repo 唔一定同時存在
 *
 * 呢個測試喺本機（兩個 repo 係 sibling）會真正比對；若 CI 只 checkout 咗 POS，
 * 搵唔到對方檔案就**skip**，唔會令 pipeline 變紅
 * （跨 repo 硬依賴會令 CI 變脆，而呢個測試嘅價值主要喺本機開發時）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

/** POS 側真源。 */
const POS_FILE = path.join(ROOT, "src", "lib", "inventory-stats.ts");
/** expenseRecorder 側（sibling repo）。 */
const EXPENSE_FILE = path.resolve(ROOT, "..", "expenseRecorder", "lib", "account-settings.ts");

/** 抽出所有 `{ code: "...", label: "...", enabled: <bool>, scope: "..." }` 條目。 */
const ENTRY_RE =
  /\{\s*code:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*enabled:\s*(true|false),\s*scope:\s*"(both|purchase|checkout)"\s*\}/g;

function extractEntries(file: string): string[][] {
  const src = readFileSync(file, "utf8");
  return Array.from(src.matchAll(ENTRY_RE)).map((m) => [m[1], m[2], m[3], m[4]]);
}

describe("支付方式預設：POS 兜底 vs admin 主檔要逐字一致", () => {
  it("POS 側要抽到非空嘅內建預設", () => {
    const entries = extractEntries(POS_FILE);
    assert.ok(entries.length > 0, "抽唔到 DEFAULT_PAYMENT_METHODS 條目（格式改咗？）");
  });

  it("同 expenseRecorder 逐條一致（code / label / enabled / scope）", (t) => {
    if (!existsSync(EXPENSE_FILE)) {
      t.skip(`搵唔到 ${EXPENSE_FILE}（跨 repo，CI 上正常）→ 略過`);
      return;
    }
    const pos = extractEntries(POS_FILE);
    const expense = extractEntries(EXPENSE_FILE);
    assert.ok(expense.length > 0, "抽唔到 expenseRecorder 嘅預設（格式改咗？）");
    assert.deepEqual(
      pos,
      expense,
      "兩邊預設唔一致：POS 讀唔到 admin 主檔時會用兜底清單，唔一致就會出現「設定同顯示對唔上」",
    );
  });

  it("兜底清單一定要包含月結（monthly）", (t) => {
    const pos = extractEntries(POS_FILE);
    assert.ok(
      pos.some(([code]) => code === "monthly"),
      "月結係商家最常用嘅進貨結算方式，兜底清單冇佢 = 讀唔到主檔時就用唔到月結",
    );
    if (!existsSync(EXPENSE_FILE)) t.skip("（只檢查咗 POS 側）");
  });
});
