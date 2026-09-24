import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { orderEventInstant } from "./order-event-time.ts";

/**
 * 《Ledger 線上單時間口徑》守衛（2026-09-24）—— 防「過濾鍵 ≠ 排序鍵」再靜默食單。
 *
 * ## 事故（表嫂美食 · 取餐碼 001 · MOP 43 · 餘額扣點）
 *
 * 客人**昨日落單、預約今日取餐** ⇒ Ledger `created_at` = 昨日、`updated_at` = 今日。
 * 報表／交班讀 Ledger 線上單時：
 *
 * | 環節 | 用邊個欄位 |
 * |---|---|
 * | RPC `list_merchant_orders` 排序 | **`updated_at` DESC** |
 * | 前端「係唔係已過區間起點」判斷 | **`created_at ?? updated_at`** ❌ |
 *
 * 兩者唔一致 ⇒ 遇到嗰張預約單（`createdAt` 早於今日起點）就觸發
 * `break outer` **提早中止整個翻頁** ⇒ **之後所有線上單一齊消失**。
 * 因為報表同交班用同一套邏輯，兩邊同時靜默漏單（商家只見到「明細冇呢張單」）。
 *
 * ✅ 修法：一律用 `orderEventInstant()`（`updatedAt` 優先，全站唯一口徑）
 *    令「過濾鍵」＝「排序鍵」，`break` 語義先至成立。
 *
 * ⚠️ 呢個測試用 `node:test` 直接跑（唔經 bundler）⇒ 只可以 import node 內建 +
 *    相對路徑 `.ts`，唔可以 import `@/` 別名。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `src/` 根（呢個檔喺 `src/lib/pos/`）。 */
const SRC_ROOT = path.resolve(HERE, "..", "..");

/** 澳門 2026-09-24 00:00 (+08:00)。 */
const DAY_START = Date.parse("2026-09-24T00:00:00+08:00");
/** 澳門 2026-09-24 23:59:59.999 (+08:00)。 */
const DAY_END = Date.parse("2026-09-24T23:59:59.999+08:00");

type Row = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  /** RPC 係按 `updated_at` DESC 回傳 —— 模擬真實排序。 */
};

/**
 * 模擬報表／交班嘅翻頁掃描（RPC 按 `updated_at` DESC）。
 *
 * @param pick 要測嘅時間口徑：`event`＝修正後（`orderEventInstant`）、
 *             `createdFirst`＝事故前（`createdAt ?? updatedAt`）。
 */
function scan(rows: Row[], pick: "event" | "createdFirst"): string[] {
  const kept: string[] = [];
  for (const o of rows) {
    const t =
      pick === "event"
        ? orderEventInstant(o)
        : (() => {
            const raw = o.createdAt ?? o.updatedAt;
            if (!raw) return 0;
            const parsed = Date.parse(raw);
            return Number.isFinite(parsed) ? parsed : 0;
          })();
    if (t <= 0) continue;
    // 一過區間起點就當「之後全部更舊」→ 收工（因為 RPC 係 updated_at DESC）。
    if (t < DAY_START) break;
    if (t > DAY_END) continue;
    kept.push(o.id);
  }
  return kept;
}

/** RPC 回傳順序：`updated_at` DESC。 */
const ROWS: Row[] = [
  // ① 今日完成、今日落單 —— 正常單
  { id: "007", createdAt: "2026-09-24T18:31:42+08:00", updatedAt: "2026-09-24T18:55:43+08:00" },
  // ② 🔴 事故單：昨日落單、預約今日取餐 ⇒ createdAt 唔喺今日
  { id: "001", createdAt: "2026-09-23T10:25:37+08:00", updatedAt: "2026-09-24T13:11:00+08:00" },
  // ③④ 排序上喺 001 之後（updated_at 更舊）—— 舊寫法會連佢哋一齊食咗
  { id: "002", createdAt: "2026-09-24T10:57:21+08:00", updatedAt: "2026-09-24T11:26:35+08:00" },
  { id: "003", createdAt: "2026-09-24T11:15:40+08:00", updatedAt: "2026-09-24T13:39:22+08:00" },
];

describe("Ledger 線上單時間口徑 ── 過濾鍵必須等於排序鍵", () => {
  it("修正後：『昨日落單、今日完成』嘅預約單唔會令之後嘅單被丟棄", () => {
    const kept = scan(ROWS, "event");
    assert.deepEqual(
      kept.slice().sort(),
      ["001", "002", "003", "007"],
      "全部今日『歸屬』嘅線上單都應該保留（包含早落單嘅 001）",
    );
  });

  it("🔴 事故重現：用 `createdAt ?? updatedAt` 判斷 ⇒ 001 觸發 break，之後嘅單全部消失", () => {
    const kept = scan(ROWS, "createdFirst");
    assert.deepEqual(kept, ["007"], "只有排喺事故單之前嘅 007 生還 —— 呢個就係 2026-09-24 實案");
    assert.ok(!kept.includes("001"), "001 本身被當『越界』剔走");
    assert.ok(!kept.includes("002"), "002 被 break 誤殺");
    assert.ok(!kept.includes("003"), "003 被 break 誤殺");
  });

  it("`orderEventInstant` 對 Ledger 單（只有 createdAt / updatedAt）＝用 updatedAt", () => {
    const order = { createdAt: "2026-09-23T10:25:37+08:00", updatedAt: "2026-09-24T13:11:00+08:00" };
    assert.equal(orderEventInstant(order), Date.parse(order.updatedAt));
    assert.ok(orderEventInstant(order) >= DAY_START && orderEventInstant(order) <= DAY_END);
  });

  it("冇時間嘅單唔會被當成某日嘅生意（維持 skip 語義）", () => {
    assert.equal(orderEventInstant({}), 0);
    assert.deepEqual(scan([{ id: "x" }], "event"), []);
  });
});

/* ───────────────────────── 源碼掃描守衛 ───────────────────────── */

/**
 * 受監管嘅三個檔案 —— 任何一個改返舊寫法，商家就會再次靜默漏單。
 * 相對 `src/`，一律用 `/`。
 */
const GUARDED = [
  "components/restaurant-daily-report.tsx",
  "lib/ledger/paid-orders.ts",
  "app/api/admin/ledger/orders/route.ts",
] as const;

/**
 * 🔴 刻意用**字串拼接**砌 needle：呢個檔本身要提及舊寫法，
 * 寫成完整字面量就會出現一次「看似命中」嘅匹配（同 `print-enqueue-callsites.test.ts` 同一個坑）。
 */
const OLD_CREATED_FIRST = new RegExp(`${"created" + "At"}\\s*\\?\\s*\\?\\s*${"updated" + "At"}`);
const OLD_SQL_CREATED = new RegExp(`"${"created" + "_at"}"\\s*,\\s*start`);
const NEW_EVENT_INSTANT = new RegExp(`${"orderEvent" + "Instant"}\\s*\\(`);

/** 去註解（區塊 + 行）—— 否則「解釋點解唔可以咁寫」嘅註釋本身會令斷言誤中。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

describe("源碼掃描守衛 ── 唔准再用 `createdAt ?? updatedAt` 過濾 Ledger 線上單", () => {
  it("三個受監管檔案一律用 `orderEventInstant()` / `updated_at`", () => {
    const violations: string[] = [];
    for (const rel of GUARDED) {
      const src = stripComments(readFileSync(path.join(SRC_ROOT, rel), "utf8"));
      if (OLD_CREATED_FIRST.test(src)) {
        violations.push(`${rel}：仍用 \`createdAt ?? updatedAt\` 做區間過濾`);
      }
      if (OLD_SQL_CREATED.test(src)) {
        violations.push(`${rel}：SQL 仍用 \`created_at\` 篩區間`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      "RPC `list_merchant_orders` 係按 `updated_at` DESC 排序，過濾鍵必須一致；\n" +
        "否則「昨日落單、今日完成」嘅預約單會令翻頁提早中止，之後嘅線上單一齊消失" +
        "（2026-09-24 取餐碼 001 實案）。請改用 `orderEventInstant()`:\n" +
        violations.join("\n"),
    );
  });

  it("掃描範圍健全（唔可以因為讀錯路徑而假綠）", () => {
    for (const rel of GUARDED) {
      const src = readFileSync(path.join(SRC_ROOT, rel), "utf8");
      assert.ok(src.length > 500, `${rel} 內容太短，可能讀錯檔`);
    }
    const report = stripComments(
      readFileSync(path.join(SRC_ROOT, "components/restaurant-daily-report.tsx"), "utf8"),
    );
    assert.ok(
      NEW_EVENT_INSTANT.test(report),
      "`restaurant-daily-report.tsx` 完全搵唔到 `orderEventInstant(` ⇒ 偵測方法失效，唔可以當綠燈",
    );
  });
});
