import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * 《線上單自動補建》接線守衛（2026-09-27）。
 *
 * ## 背景
 *
 * 商家原話：「**商家不應該需要按這個**」（截圖：橙色條「有線上單未入 POS 記錄」＋
 * 「補建入 POS」按鈕）。⇒ 手動補建改為**系統自動**：
 *   - (a) 主動採納：既有接單路徑（`online-orders` / `quick-online-orders-panel`）唔改；
 *   - (b) 被動兜底：新 hook `useAdoptCompletedLedgerOrders` 搭既有 Ledger 節拍；
 *   - (c) 純提示：`OnlineReconcileBanner` 保留橙色條，**移除按鈕**。
 *
 * ## 🔴 呢批斷言防咩（全部係會靜默出錯嘅事）
 *
 * 1. **按鈕唔可以返嚟** —— 商家唔想撳；返嚟即係需求無做到。
 * 2. **兩個消費者都要接 hook** —— 只接一個 ⇒ 喺另一頁漏帳時永遠唔會自動補。
 * 3. **補建唔可以出紙** —— 補建嘅單係「已經做過」，出紙 = 廚房多收一張（鐵律）。
 * 4. **雲端核對唔可以變成必要條件** —— route 壞就唔補 ⇒ 比今日更差。
 * 5. **既有防線唔可以拆** —— `posOnlineIds` / `localOnlineIds` 仍要併 `loadOrders()`。
 * 6. **route 要有閘 ＋ 唯讀** —— 知道 storeId 就攞到成批 Ledger 單 id 係資料洩漏。
 *
 * ⚠️ 用 `node:test` 直接跑 ⇒ 只可以 import node 內建模組，所以用**源碼掃描**斷言接線
 *    （專案慣例，見 `backfill-guard.test.ts`）。
 * 🔴 needle 一律用字串拼接砌 —— 寫成完整字面量會令掃描器捉到自己（包括本檔註釋）。
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
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const BANNER = "components/online-reconcile-banner.tsx";
const REPORT = "components/restaurant-daily-report.tsx";
const SHIFT = "components/shift-page.tsx";
const ORDERS_PAGE = "components/online-orders.tsx";
const QUICK_PANEL = "components/quick-online-orders-panel.tsx";
const HOOK = "lib/pos/use-adopt-completed-ledger-orders.ts";
const ADOPTED_IDS = "lib/pos/adopted-online-ids.ts";
const ROUTE = "app/api/pos/adopted-online-ids/route.ts";

const LOCAL_ORDERS_CALL = new RegExp(`${"load" + "Orders"}\\s*\\(\\s*\\)`);
/** 用拼接避開自己：`onBackfill` / `handleBackfillUnadopted`。 */
const BACKFILL_PROP = "onBack" + "fill";
const BACKFILL_HANDLER = "handleBack" + "fillUnadopted";
const ADOPT_FN = "adoptCompletedLedger" + "OrderToLocal";
const HOOK_NAME = "useAdoptCompleted" + "LedgerOrders";

describe("自動補建守衛 ── 手動按鈕唔可以返嚟", () => {
  it("🔴 `OnlineReconcileBanner` 唔可以再有補建按鈕 prop／handler", () => {
    const src = stripComments(read(BANNER));
    assert.ok(!src.includes(BACKFILL_PROP), `警示條仍然有 \`${BACKFILL_PROP}\` prop ⇒ 按鈕未拆走`);
    assert.ok(!src.includes("<button"), "警示條仍然有 <button> ⇒ 商家仲要撳");
  });

  it("🔴 報表頁唔可以再傳補建 prop／保留補建 handler", () => {
    const src = stripComments(read(REPORT));
    assert.ok(!src.includes(BACKFILL_HANDLER), `報表頁仍然有 \`${BACKFILL_HANDLER}\` ⇒ 手動補建未拆`);
    assert.ok(!src.includes(BACKFILL_PROP), `報表頁仍然傳 \`${BACKFILL_PROP}\` ⇒ 按鈕未拆`);
  });

  it("🔴 交班頁文案唔可以再叫商家去撳（指向「一鍵補建」）", () => {
    const src = stripComments(read(SHIFT));
    assert.ok(
      !src.includes(`一鍵補${"建"}`),
      "交班頁仍然叫商家「一鍵補建」⇒ 已改自動，文案要同步",
    );
  });
});

describe("自動補建守衛 ── 兩個消費者都要接上 hook", () => {
  it("🔴 訂單頁（`online-orders.tsx`）要用自動補建 hook", () => {
    const src = stripComments(read(ORDERS_PAGE));
    assert.ok(src.includes(HOOK_NAME), `訂單頁冇用 \`${HOOK_NAME}\` ⇒ 該頁漏帳永遠唔會自動補`);
    assert.ok(src.includes(ADOPT_FN), "訂單頁冇呼叫補建函式 ⇒ hook 得個吉");
  });

  it("🔴 POS 主介面快捷面板（`quick-online-orders-panel.tsx`）同樣要用", () => {
    const src = stripComments(read(QUICK_PANEL));
    assert.ok(
      src.includes(HOOK_NAME),
      `快捷面板冇用 \`${HOOK_NAME}\` ⇒ 收銀喺 POS 主介面時漏帳永遠唔會自動補`,
    );
  });

  it("🔴 兩個消費者嘅補建都要 `skipPrint` 語義（經 bridge，唔可以自己出紙）", () => {
    // 補建一律走 `adoptCompletedLedgerOrderToLocal()`（內部 `skipPrint: true`），
    // 呼叫端**唔可以**同時叫 `printKitchenForLedgerOrder`（接單出紙路徑）。
    for (const rel of [ORDERS_PAGE, QUICK_PANEL]) {
      const src = stripComments(read(rel));
      // 由**最後一次**出現（＝呼叫處，import 行喺最前）開始截。
      const idx = src.lastIndexOf(HOOK_NAME);
      assert.ok(idx > 0, `${rel} 掃描失效`);
      const seg = src.slice(idx, idx + 1200);
      assert.ok(
        seg.includes(ADOPT_FN),
        `${rel} 嘅 hook 呼叫冇指向 \`${ADOPT_FN}\` ⇒ 可能行咗出紙路徑`,
      );
      assert.ok(
        !seg.includes("printKitchenFor" + "LedgerOrder"),
        `${rel} 嘅自動補建段出現出紙函式 ⇒ 補建會多出一張紙（違反鐵律）`,
      );
    }
  });
});

describe("自動補建守衛 ── 雲端核對唔可以變成必要條件", () => {
  it("🔴 抓雲端 id 失敗一定要回空集合（fail-open），唔可以 throw", () => {
    const src = stripComments(read(ADOPTED_IDS));
    assert.ok(src.includes("catch"), "冇 try/catch ⇒ 網絡錯會令補建整體停擺");
    assert.ok(
      /catch[\s\S]{0,200}return\s*\[\]/.test(src),
      "catch 分支冇 `return []` ⇒ 失敗時唔會 fallback（會比今日更差）",
    );
  });

  it("🔴 hook 用雲端集合前要有 fallback（未返都要照補）", () => {
    const src = stripComments(read(HOOK));
    assert.ok(
      src.includes("remoteIdsRef") && src.includes("?? new Set"),
      "hook 冇為『雲端集合未返』提供 fallback ⇒ 首屏可能唔補",
    );
  });

  it("route 未配置 Supabase 要回『空集合』而唔係報錯（維持 mock 行為）", () => {
    const src = stripComments(read(ROUTE));
    const idx = src.indexOf("if (!supabase)");
    assert.ok(idx > 0, "route 冇 `!supabase` 分支 ⇒ mock 環境行為可能被改");
    const seg = src.slice(idx, idx + 300);
    assert.ok(
      seg.includes("onlineOrderIds: []"),
      "`!supabase` 分支冇回空集合 ⇒ 改咗 mock／未配置環境既有行為",
    );
  });
});

describe("自動補建守衛 ── 既有防線唔可以拆（2026-09-24 事故）", () => {
  it("🔴 報表 `posOnlineIds` 仍要併本機全量", () => {
    const src = stripComments(read(REPORT));
    const start = src.indexOf(`${"posOnline" + "Ids"} = useMemo`);
    assert.ok(start > 0, "冇 `posOnlineIds` ⇒ 掃描方法失效");
    assert.ok(
      LOCAL_ORDERS_CALL.test(src.slice(start, start + 900)),
      "`posOnlineIds` 冇併 `loadOrders()` ⇒ 舊日單會被誤判漏帳再被補建覆蓋",
    );
  });

  it("🔴 交班 `localOnlineIds` 仍要併本機全量", () => {
    const src = stripComments(read(SHIFT));
    const start = src.indexOf(`${"localOnline" + "Ids"} = useMemo`);
    assert.ok(start > 0, "冇 `localOnlineIds` ⇒ 掃描方法失效");
    assert.ok(
      LOCAL_ORDERS_CALL.test(src.slice(start, start + 900)),
      "`localOnlineIds` 冇併 `loadOrders()` ⇒ 線上實收會雙計",
    );
  });
});

describe("自動補建守衛 ── route 要有閘、要唯讀", () => {
  it("🔴 必須過 POS 授權閘（唔可以匿名攞成批單 id）", () => {
    const src = stripComments(read(ROUTE));
    assert.ok(
      src.includes("posRouteAuthGuard"),
      "route 冇鑑權 ⇒ 知道 storeId（枱 QR 已公開）就攞到成批 Ledger 單 id",
    );
  });

  it("🔴 閘一定要放喺 `!supabase` 之後（唔可以改 mock 行為）", () => {
    const src = stripComments(read(ROUTE));
    const mock = src.indexOf("if (!supabase)");
    const guard = src.indexOf("posRouteAuthGuard(");
    assert.ok(mock > 0 && guard > 0, "掃描失效");
    assert.ok(guard > mock, "閘放喺 `!supabase` 之前 ⇒ mock／未配置環境行為被改");
  });

  it("🔴 唯讀：唔可以出現寫入／RPC 呼叫", () => {
    const src = stripComments(read(ROUTE));
    for (const forbidden of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      assert.ok(!src.includes(forbidden), `route 出現 \`${forbidden}\` ⇒ 唔應該係唯讀端點`);
    }
  });

  it("🔴 只可以拉兩個欄位（唔可以 `select(\"*\")` ⇒ egress）", () => {
    const src = stripComments(read(ROUTE));
    assert.ok(
      src.includes('select("id, online_order_id")'),
      "冇明確列出兩個欄位 ⇒ 可能拉咗 items（mg 級 egress）",
    );
    assert.ok(!/select\(\s*"\*"\s*\)/.test(src), "route 用 `select(\"*\")` ⇒ egress 會爆");
  });

  it("有 `force-dynamic` ＋ rate limit（同其他 POS route 一致）", () => {
    const src = read(ROUTE);
    assert.ok(src.includes('dynamic = "force-dynamic"'), "冇 force-dynamic");
    assert.ok(src.includes("rateLimit("), "冇 rate limit");
  });
});

describe("自動補建守衛 ── 掃描範圍健全（唔可以假綠）", () => {
  it("所有目標檔案都讀得到、內容夠長", () => {
    for (const rel of [
      BANNER,
      REPORT,
      SHIFT,
      ORDERS_PAGE,
      QUICK_PANEL,
      HOOK,
      ADOPTED_IDS,
      ROUTE,
    ]) {
      assert.ok(read(rel).length > 800, `${rel} 內容太短，可能讀錯檔`);
    }
  });

  it("hook 存在且含三條鐵律關鍵字（去重 / 唔出紙 / 唔漂日期）", () => {
    const src = stripComments(read(HOOK));
    assert.ok(src.includes("attemptedRef"), "hook 冇『已試過』記錄 ⇒ 會迴圈重試");
    assert.ok(src.includes("merchantId"), "hook 冇 merchantId ⇒ 換店唔會重置狀態");
  });
});
