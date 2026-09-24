import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { canVoidPlatformOrder, isPlatformOrder } from "./platform-order.ts";

/**
 * 平台單「取消（覆寫）」嘅**接線守衛**（源碼掃描）。
 *
 * ── 為什麼係源碼掃描而唔係 render 測試 ────────────────────────────────
 * `node --test` 用 Node 內建 type-stripping，**唔支援 `.tsx`**（`ERR_UNKNOWN_FILE_EXTENSION`，
 * 冇 JSX transform），而呢幾個檔案係 React 元件。本專案既有慣例就係
 * 「`.tsx` 用 source 掃描測試」（見 `pos-app-queue-base.test.ts`）。
 *
 * ── 要守咩 ──────────────────────────────────────────────────────────
 * 使用者 2026-09-24 要求：外賣平台單嘅「取消」要係 **override**，
 * **唔可以由狀態流程推導** —— `paid` / `settled`（已完結）都要出。
 * 所以呢度把「UI 有冇正確接線」焊死；規則本體另有 `platform-order.test.ts` 驗。
 */

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
/** `src/lib`（本檔上一層）。 */
const LIB_DIR = path.resolve(HERE, "..");
/** `src`。 */
const SRC_DIR = path.resolve(HERE, "..", "..");

function readFrom(base: string, ...parts: string[]): string {
  return readFileSync(path.join(base, ...parts), "utf8");
}
/** 相對 `src/`。 */
const read = (...parts: string[]) => readFrom(SRC_DIR, ...parts);
/** 相對 `src/lib/`。 */
const readLib = (...parts: string[]) => readFrom(LIB_DIR, ...parts);

/** 去掉註釋 —— 否則「解釋點解唔可以咁寫」嘅註釋本身會誤中斷言。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const strip = stripComments(read("components", "quick-local-orders-strip.tsx"));
const app = stripComments(read("components", "pos-app.tsx"));
const panel = stripComments(read("components", "local-orders-panel.tsx"));
const lib = stripComments(readLib("pos-orders.ts"));

describe("快餐卡片（quick-local-orders-strip.tsx）", () => {
  it("有「取消」掣，守衛係 `canVoidPlatformOrder(order)`（唔係睇 status）", () => {
    assert.match(
      strip,
      /canVoidPlatformOrder\(order\)[\s\S]{0,40}&&[\s\S]{0,40}onVoidPlatformOrder/,
      "卡片嘅取消掣守衛要係 canVoidPlatformOrder(order) && onVoidPlatformOrder",
    );
  });

  it("🔴 守衛表達式**唔可以**包含任何 status 比較（否則就係「由狀態流程推導」）", () => {
    const idx = strip.indexOf("canVoidPlatformOrder(order)");
    assert.ok(idx > 0, "搵唔到平台單取消掣嘅守衛");
    // 掣嘅 JSX 區塊內唔可以有 order.status ===
    const block = strip.slice(idx, idx + 900);
    assert.ok(
      !/order\.status\s*[!=]==/.test(block),
      "平台單取消掣唔可以再夾 status 條件（`paid` / `settled` 都要出）",
    );
  });

  it("按下時呼叫 `onVoidPlatformOrder(order)`（交畀上層開原因彈窗）", () => {
    assert.match(strip, /onClick=\{\(\) => onVoidPlatformOrder\(order\)\}/);
  });

  it("兩個 props 型別（Props + OrderCard）都有 `onVoidPlatformOrder`", () => {
    const n = (strip.match(/onVoidPlatformOrder\?/g) ?? []).length;
    assert.ok(n >= 2, `onVoidPlatformOrder 應該喺兩處型別出現，實際 ${n}`);
  });
});

describe("pos-app.tsx（訂單詳情彈窗 + 快餐卡接線）", () => {
  it("有 `platformVoidBtn`，守衛係 `canVoidPlatformOrder(v)`", () => {
    assert.match(app, /const platformVoidBtn = canVoidPlatformOrder\(v\) \?/);
  });

  it("🔴 快餐分支嘅 cancelButton 平台單一定出（唔會因為 isPaid 而冇）", () => {
    assert.match(
      app,
      /const cancelButton = canVoidPlatformOrder\(v\) \? \(\s*platformVoidBtn\s*\) : isPaid \? null/,
      "cancelButton 要先判平台單，再判 isPaid",
    );
  });

  it("通用分支（已結帳／已完成嘅單會落到呢度）都有 `{platformVoidBtn}`", () => {
    // ⚠️ 唔可以用註釋做錨點（上面 stripComments 已經刪走註釋）
    // → 用通用分支獨有嘅「去結帳」條件做錨點。
    const anchor = "(v.prepaidAmount ?? 0) < v.total";
    const i = app.indexOf(anchor);
    assert.ok(i > 0, "搵唔到通用分支（去結帳條件）");
    const block = app.slice(i, i + 900);
    assert.match(block, /\{platformVoidBtn\}/, "通用分支缺 platformVoidBtn（已結帳平台單會冇掣）");
  });

  it("原因彈窗用 `void_platform_order` 型別，而且有提示影響報表", () => {
    assert.match(app, /type: "void_platform_order", orderId: order\.id/);
    assert.match(app, /"void_platform_order"/, "request 型別未加入 void_platform_order");
    assert.match(app, /即刻唔計入營業額／報表/, "彈窗欠「會影響報表」嘅提示");
  });

  it("快餐卡接線：onVoidPlatformOrder → 開 void_platform_order 彈窗", () => {
    assert.match(
      app,
      /onVoidPlatformOrder=\{\(order\) => \{[\s\S]{0,160}void_platform_order/,
      "QuickModeOrdersBar 未接 onVoidPlatformOrder",
    );
  });

  it("平台單冇填原因時用可辨識嘅預設文字（唔會同本地單撈埋）", () => {
    assert.match(app, /isPlatformOrder\(targetOrder\)[\s\S]{0,120}PLATFORM_VOID_DEFAULT_REASON/);
  });
});

describe("local-orders-panel.tsx（/orders 頁）", () => {
  it("canCancelSettle 先判平台單（任何階段都可以）", () => {
    assert.match(
      panel,
      /if \(canVoidPlatformOrder\(order\)\) return true;/,
      "canCancelSettle 未加入平台單分支",
    );
  });

  it("handleCancelSettle 平台單走 voidPlatformOrder、本地單走 cancelLocalOrder", () => {
    assert.match(
      panel,
      /isPlatformOrder\(cancelTarget\)\s*\?\s*voidPlatformOrder\(cancelTarget\.id, reason\)\s*:\s*cancelLocalOrder\(cancelTarget\.id, reason\)/,
      "兩條路徑冇分開",
    );
  });

  it("取消原因彈窗喺平台單時改標題（同本地單分辨）", () => {
    assert.match(panel, /isPlatformOrder\(cancelTarget\) \? "取消平台單（覆寫）" : "取消結帳"/);
  });
});

describe("pos-orders.ts（lib 寫入層）", () => {
  it("voidPlatformOrder 存在，而且**一定要**先驗係平台單（防止繞過本地單保護）", () => {
    const i = lib.indexOf("export function voidPlatformOrder");
    assert.ok(i > 0, "搵唔到 voidPlatformOrder");
    const body = lib.slice(i, i + 1200);
    assert.match(body, /isPlatformOrder\(order\)/, "冇驗平台單 → 本地單會繞過 paid/settled 保護");
    assert.match(body, /platformVoidDenyReason\(order\)/, "冇用規則模組嘅拒絕原因");
    assert.match(body, /writeCancelledOrder\(/, "冇共用寫入路徑");
  });

  it("兩個入口共用同一條寫入路徑（唔可以各自寫事件）", () => {
    assert.match(lib, /return writeCancelledOrder\(orders, idx, reason \|\| "收銀取消結帳"\)/);
    assert.match(lib, /return writeCancelledOrder\(orders, idx, reason \|\| PLATFORM_VOID_DEFAULT_REASON\)/);
  });

  it("🔴 零影響：cancelLocalOrder **仍然**擋 paid / settled（本地單口徑完全冇變）", () => {
    const i = lib.indexOf("export function cancelLocalOrder");
    const body = lib.slice(i, lib.indexOf("export function voidPlatformOrder"));
    assert.match(body, /order\.status === "settled" \|\| order\.status === "paid"/);
    assert.match(body, /請用返結／退款處理/);
  });
});

describe("雲端同步：settled / paid → cancelled 唔會被守門拒收", () => {
  const sync = stripComments(read("app", "api", "pos", "sync", "route.ts"));

  it("TERMINAL_ORDER_STATUSES 同時包含 settled 同 cancelled（⇒ isDowngrade 為 false）", () => {
    const m = sync.match(
      /const TERMINAL_ORDER_STATUSES = new Set\(\[([^\]]+)\]\)/,
    );
    assert.ok(m, "搵唔到 TERMINAL_ORDER_STATUSES");
    assert.match(m[1], /"settled"/);
    assert.match(m[1], /"cancelled"/);
  });

  it("PAID / OPEN 兩個集合嘅定義令 isPaidDowngrade 唔會擋 cancelled", () => {
    const paid = sync.match(/const PAID_ORDER_STATUSES = new Set\(\[([^\]]+)\]\)/);
    const open = sync.match(/const OPEN_ORDER_STATUSES = new Set\(\[([^\]]+)\]\)/);
    assert.ok(paid && open);
    // isPaidDowngrade 要求 writeStatus ∈ OPEN；cancelled 唔喺 OPEN → 擋唔到
    assert.ok(!/"cancelled"/.test(open[1]), "cancelled 唔應該喺 OPEN_ORDER_STATUSES");
    assert.match(paid[1], /"settled"/, "settled 要喺 PAID（先會觸發 downgrade 檢查）");
  });
});

describe("規則模組同 UI 用嘅係同一支函式（防止兩邊走樣）", () => {
  it("UI 掃描搵到嘅判斷同 lib 一致", () => {
    // 用同一支真實函式驗幾個代表值，確保 UI 依賴嘅語意冇被改
    assert.equal(canVoidPlatformOrder({ source: "aomi", status: "settled" }), true);
    assert.equal(canVoidPlatformOrder({ source: "mfood", status: "paid" }), true);
    assert.equal(canVoidPlatformOrder({ source: "pos", status: "settled" }), false);
    assert.equal(isPlatformOrder({ source: "aomi", status: "cancelled" }), true);
    assert.equal(isPlatformOrder({ source: "pos", status: "cancelled" }), false);
  });
});
