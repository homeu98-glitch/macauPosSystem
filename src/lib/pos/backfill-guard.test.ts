import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * 《補建漏帳單》安全守衛（2026-09-24 事故後加）。
 *
 * ## 事故（補完「更錯」）
 *
 * 商家撳「補建入 POS」，4 張之中有 2 張係**昨日（09-23）**嘅線上單（取餐碼 002／003）。
 * 佢哋本來**已經有 POS 單**，只因「唔喺今日 range」而被誤判成「未入 POS」⇒ 被補建 upsert
 * **覆蓋**。而 `/api/pos/sync` 嘅 `updated_at` 係 **server 蓋章**（Vercel 時鐘）⇒
 * 兩張單嘅日期被推成**今日**：
 *
 * - 09-23 報表少 2 張；09-24 多 2 張（28 張／1,778 → 37 張／2,423）；
 * - 同日出現兩個相同取餐碼（取餐碼每日重用）⇒ 商家以為「重複了」；
 * - 補建用 Ledger 明細重建 ⇒ 覆蓋店內加菜（002 由 MOP 69 變 59）。
 *
 * ## 兩道必要防線（缺一都會重演）
 *
 * 1. **補建函式內**：`adoptCompletedLedgerOrderToLocal()` 必須先查本機有冇
 *    `ledger-<id>` —— 有就 `return null`（零請求）。
 * 2. **呼叫端去重集合**：報表／交班嘅 `posOnlineIds` / `localOnlineIds` 唔可以只靠
 *    當前 range，必須**併入本機全量** `loadOrders()`（亦係零請求）。
 *
 * ⚠️ 呢個測試用 `node:test` 直接跑 ⇒ 只可以 import node 內建模組，
 *    所以用**源碼掃描**方式斷言接線（專案慣例，見 `print-enqueue-callsites.test.ts`）。
 * 🔴 needle 一律用字串拼接砌 —— 寫成完整字面量會令掃描器捉到自己。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..", "..");

function read(rel: string): string {
  return readFileSync(path.join(SRC_ROOT, rel), "utf8");
}

/** 去註解 —— 否則「解釋點解要咁做」嘅註釋本身會令斷言誤中。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

/** 抽出一個具名函式嘅本體（由函式簽名到下一個頂層 `}`）。粗略但足夠做掃描。 */
function functionBody(src: string, name: string): string {
  const idx = src.indexOf(`${name}(`);
  if (idx < 0) return "";
  const end = src.indexOf("\n}\n", idx);
  return src.slice(idx, end > 0 ? end : idx + 4000);
}

const BRIDGE = "lib/ledger/ledger-pos-bridge.ts";
const REPORT = "components/restaurant-daily-report.tsx";
const SHIFT = "components/shift-page.tsx";

const LOCAL_ORDERS_CALL = new RegExp(`${"load" + "Orders"}\\s*\\(\\s*\\)`);
const LEDGER_PREFIX = new RegExp(`\\\`${"ledger" + "-"}\\$\\{`);

describe("補建漏帳單守衛 ── 唔可以覆蓋已經有 POS 單嘅舊單", () => {
  it("🔴 `adoptCompletedLedgerOrderToLocal()` 必須先檢查本機已有 `ledger-<id>` ⇒ 有就唔補", () => {
    const body = stripComments(functionBody(read(BRIDGE), "adoptCompletedLedgerOrderToLocal"));
    assert.ok(body.length > 200, "搵唔到 `adoptCompletedLedgerOrderToLocal()` 函式本體（掃描方法失效）");
    assert.ok(
      LOCAL_ORDERS_CALL.test(body),
      "函式內冇 `loadOrders()` 檢查 ⇒ 舊單會被補建覆蓋（2026-09-24 事故會重演）",
    );
    assert.ok(
      LEDGER_PREFIX.test(body),
      "函式內冇砌 `ledger-${...}` 去比對本機單 id ⇒ 守衛無效",
    );
  });

  it("🔴 報表嘅去重集合必須併入本機全量（唔可以只用當前 range 嘅 `orders`）", () => {
    const src = stripComments(read(REPORT));
    // posOnlineIds 定義那段（由 `const posOnlineIds` 到下一個 `}, [`）。
    const start = src.indexOf(`${"posOnline" + "Ids"} = useMemo`);
    assert.ok(start > 0, "冇 `posOnlineIds` ⇒ 掃描方法失效");
    const seg = src.slice(start, start + 900);
    assert.ok(
      LOCAL_ORDERS_CALL.test(seg),
      "`posOnlineIds` 冇併入 `loadOrders()` ⇒ 較早日期嘅 POS 單唔會被去重 ⇒ " +
        "今日報表對同一張線上單雙計，而且會被誤判「未入 POS」再被補建覆蓋",
    );
  });

  it("🔴 交班嘅去重集合同樣要併入本機全量（否則線上實收雙計）", () => {
    const src = stripComments(read(SHIFT));
    const start = src.indexOf(`${"localOnline" + "Ids"} = useMemo`);
    assert.ok(start > 0, "冇 `localOnlineIds` ⇒ 掃描方法失效");
    const seg = src.slice(start, start + 900);
    assert.ok(
      LOCAL_ORDERS_CALL.test(seg),
      "`localOnlineIds` 冇併入 `loadOrders()` ⇒ 較早日期嘅線上投影單唔會被去重 ⇒ " +
        "Ledger 該單會被當「純線上單」加落**今日**線上實收（昨日已計 ⇒ 雙計）",
    );
  });

  it("掃描範圍健全（唔可以因為讀錯路徑而假綠）", () => {
    for (const rel of [BRIDGE, REPORT, SHIFT]) {
      assert.ok(read(rel).length > 2000, `${rel} 內容太短，可能讀錯檔`);
    }
    const bridge = stripComments(read(BRIDGE));
    assert.ok(
      bridge.includes(`${"adoptCompletedLedgerOrderToLocal"}`),
      "`ledger-pos-bridge.ts` 冇補建函式 ⇒ 掃描目標錯咗",
    );
  });
});
