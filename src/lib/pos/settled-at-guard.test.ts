import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * 《`settled_at` 不可變業務時間》接線守衛（0057，2026-09-24 跨日漂移根治）。
 *
 * ## 要守嘅四條鐵律（做錯一條等於冇做）
 *
 * 1. **裝置喺結帳嗰刻寫一次**（重開再結先再寫）—— pos-app 四個結帳點 ＋
 *    quick-order-fulfillment ＋ ledger-pos-bridge（補建）都要有寫入。
 * 2. **sync route 永不覆蓋／永不自己落章** —— 只接受 client 值（「有值才寫」），
 *    並禁止出現 `settled_at: new Date(...)`（server 蓋章 = 漂移病源）。
 * 3. **消費者統一經 `orderEventInstant()` 讀，`settledAt` 排最前** ——
 *    四條讀取路徑（pos-order-row ／ pos-order-mapper ／ /api/pos/orders 內聯 ／ sync baseRecord）
 *    要齊（返結四鐵律同款漏抄病，中過三次：discount_note、reopen_*、platform_fees）。
 * 4. **SQL 超集 ⊇ client 口徑** —— 區間查詢要有第四條 `settled_at` 腿
 *    （降級四腿 ＋ migration 嘅 RPC），migration 檔要齊料（加欄＋索引＋backfill＋RPC 換新）。
 *
 * ⚠️ `node --test` 直接跑 ⇒ 只可以 import node 內建模組 ⇒ 用**源碼掃描**斷言接線
 *    （專案慣例，見 `backfill-guard.test.ts`）。
 * 🔴 needle 一律用字串拼接砌 —— 寫成完整字面量會令掃描器捉到自己／被格式化改寫時誤中。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..", "..");
const REPO_ROOT = path.resolve(SRC_ROOT, "..");

function read(rel: string): string {
  return readFileSync(path.join(SRC_ROOT, rel), "utf8");
}

function readRepo(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/** 去註解 —— 否則「解釋點解要咁做」嘅註釋本身會令斷言誤中。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

const SNAKE = `${"settled"}_at`; // settled_at
const CAMEL = `${"settled"}At`; // settledAt

const ORDER_EVENT_TIME = "lib/pos/order-event-time.ts";
const TYPES = "lib/types.ts";
const ORDER_ROW = "lib/pos-order-row.ts";
const ORDER_MAPPER = "lib/pos/pos-order-mapper.ts";
const ORDERS_API = "app/api/pos/orders/route.ts";
const SYNC = "app/api/pos/sync/route.ts";
const RANGE = "lib/pos-orders-range.ts";
const POS_APP = "components/pos-app.tsx";
const QUICK = "lib/quick-order-fulfillment.ts";
const BRIDGE = "lib/ledger/ledger-pos-bridge.ts";
const MIGRATION = "supabase/migrations/0057_pos_orders_settled_at.sql";

describe("鐵律 ③：`orderEventInstant()` 鏈以 settledAt 為首選", () => {
  it("鏈內 order.settledAt 排喺 order.reopenedAt 之前", () => {
    const src = stripComments(read(ORDER_EVENT_TIME));
    const settledIdx = src.indexOf(`order.${CAMEL}`);
    const reopenedIdx = src.indexOf(`order.${"reopened" + "At"}`);
    assert.ok(settledIdx > 0, "order-event-time.ts 搵唔到 order.settledAt ⇒ 鏈冇接");
    assert.ok(reopenedIdx > 0, "order-event-time.ts 搵唔到 order.reopenedAt ⇒ 掃描方法失效");
    assert.ok(
      settledIdx < reopenedIdx,
      "settledAt 必須排最前（鏈序錯＝日歸屬照舊靠 server 蓋章，漂移病冇医）",
    );
  });

  it("PosOrder 型別有 settledAt 欄（client 寫入／讀取嘅載體）", () => {
    assert.ok(read(TYPES).includes(`${CAMEL}?: string;`), "types.ts 嘅 PosOrder 缺 settledAt");
  });
});

describe("鐵律 ③：四條讀取路徑齊 map（漏一條＝漂移保護喺嗰條路失效）", () => {
  it("pos-order-row.ts（state／admin／range 共用）：清單＋mapper 都有", () => {
    const src = stripComments(read(ORDER_ROW));
    assert.ok(src.includes(`"${SNAKE}",`), "POS_ORDER_DB_COLUMNS 缺 settled_at（投影唔會 select 佢）");
    assert.ok(
      src.includes(`${CAMEL}: order.${SNAKE} ?? undefined`),
      "mapOrderRow() 冇 map settledAt",
    );
  });

  it("pos-order-mapper.ts（Realtime 訂閱）：row 型別＋mapper 都有", () => {
    const src = stripComments(read(ORDER_MAPPER));
    assert.ok(src.includes(`${SNAKE}?: string | null;`), "PosOrderRow 缺 settled_at");
    assert.ok(src.includes(`${CAMEL}: row.${SNAKE} ?? undefined`), "mapPosOrderRow() 冇 map settledAt");
  });

  it("/api/pos/orders 內聯 mapper 有", () => {
    const src = stripComments(read(ORDERS_API));
    assert.ok(src.includes(`${CAMEL}: order.${SNAKE} ?? undefined`), "orders route 內聯 mapper 冇 map settledAt");
  });

  it("sync baseRecord（寫入路徑）用「有值才寫」", () => {
    const src = stripComments(read(SYNC));
    assert.ok(
      src.includes(`order.${CAMEL} !== undefined`),
      "sync baseRecord 冇「有值才寫」判斷 ⇒ 舊 client 重推會用 NULL 抹走 settled_at",
    );
    assert.ok(src.includes(`${SNAKE}: isoOrNull(order.${CAMEL})`), "baseRecord 冇將 settledAt 寫落 settled_at");
  });
});

describe("鐵律 ②：server 永不覆蓋／永不自己落章", () => {
  it("🔴 sync route 禁止 `settled_at: new Date(`（server 蓋章＝漂移病源）", () => {
    const src = stripComments(read(SYNC));
    const ban = new RegExp(`${SNAKE}:\\s*new Date`);
    assert.ok(!ban.test(src), "sync route 用 server 時鐘落章 settled_at —— 同 updated_at 嘅病一模一樣，必須拔走");
  });

  it("兩個 42703 降級都識拔 settled_at（未跑 migration 唔可以拖冧主流程）", () => {
    const src = stripComments(read(SYNC));
    assert.ok(src.includes(`delete legacyRecord.${SNAKE};`), "baseRecord 42703 降級冇拔 settled_at");
    assert.ok(src.includes(`delete legacyPatch.${SNAKE};`), "ORDER_SETTLED 42703 降級冇拔 settled_at");
  });

  it("ORDER_SETTLED 只接受字串值（null／缺 key 當冇帶，唔可以抹走已有值）", () => {
    const src = stripComments(read(SYNC));
    assert.ok(
      src.includes(`typeof ${"settledAt" + "Input"} === "string"`),
      "ORDER_SETTLED 冇用 typeof string 閘 ⇒ null 會被寫入、抹走雲端已有 settled_at",
    );
  });
});

describe("鐵律 ①：client 結帳寫入點齊（裝置鐘，唔係 server 鐘）", () => {
  it("pos-app.tsx 至少有 7 個 settledAt 寫入（4 張訂單構造＋3 個 ORDER_SETTLED payload）", () => {
    const src = stripComments(read(POS_APP));
    const hits = src.match(new RegExp(`[^a-zA-Z]${CAMEL}:`, "g")) ?? [];
    assert.ok(
      hits.length >= 7,
      `pos-app.tsx 得 ${hits.length} 個 settledAt 寫入（期望 ≥7：confirmPayment／免單／線上已支付／標記完成 ＋ 3 個 payload）`,
    );
  });

  it("快餐標記完成唔可以覆寫（收錢嗰刻先係 settledAt）", () => {
    assert.ok(
      stripComments(read(QUICK)).includes(`${CAMEL}: target.${CAMEL} ?? updatedAt`),
      "quick-order-fulfillment 冇保留原有 settledAt ⇒ 快餐單歸屬會由收錢日漂去完成日",
    );
  });

  it("補建（forceSettled）用 Ledger 事件時間寫 settledAt ⇒ 補昨日單永遠歸昨日", () => {
    const src = stripComments(read(BRIDGE));
    assert.ok(src.includes(`${CAMEL}: stamp`), "ledger-pos-bridge 補建冇寫 settledAt ⇒ 補建單重推照漂");
  });
});

describe("鐵律 ④：SQL 超集 ⊇ client 口徑（settled_at 腿）＋ migration 齊料", () => {
  it("降級路（pos-orders-range.ts）有第四條 settled_at 腿", () => {
    const src = stripComments(read(RANGE));
    assert.ok(
      src.includes(`applyRange(base(), "${SNAKE}"`),
      "runTimeLegs 缺 settled_at 腿 ⇒ 「昨日結帳、今日重推」嘅單會喺昨日報表消失",
    );
  });

  it("migration 0057：加欄＋索引＋backfill＋RPC 第四腿", () => {
    const sql = readRepo(MIGRATION);
    assert.ok(sql.includes(`add column if not exists ${SNAKE}`), "migration 冇加欄");
    assert.ok(sql.includes(`${"pos_orders_store_settled"}_idx`), "migration 冇 (store_id, settled_at) 索引");
    assert.ok(
      sql.includes(`set ${SNAKE} = coalesce(${"reopened"}_at, ${"updated"}_at)`),
      "migration 冇舊單 backfill（freeze 現行口徑）",
    );
    assert.ok(
      new RegExp(`o\\.${SNAKE}\\s+>= p_start`).test(sql),
      "RPC pos_orders_page 冇第四條 settled_at 腿",
    );
  });

  it("🔴 migration 禁止 transaction（商家會將 commit 理解成 git commit ⇒ rollback 靜默冇改）", () => {
    const sql = readRepo(MIGRATION);
    assert.ok(!/^\s*begin\s*;/im.test(sql), "migration 唔可以用 begin;（2026-09-24 教訓）");
    assert.ok(!/^\s*commit\s*;/im.test(sql), "migration 唔可以用 commit;（SQL Editor 自動提交）");
  });
});

describe("掃描範圍健全（唔可以因為讀錯路徑而假綠）", () => {
  it("所有目標檔都真係讀到嘢", () => {
    for (const rel of [ORDER_EVENT_TIME, TYPES, ORDER_ROW, ORDER_MAPPER, ORDERS_API, SYNC, RANGE, POS_APP, QUICK, BRIDGE]) {
      assert.ok(read(rel).length > 1000, `${rel} 內容太短，可能讀錯檔`);
    }
    assert.ok(readRepo(MIGRATION).length > 500, "migration 0057 內容太短，可能讀錯檔");
  });
});
