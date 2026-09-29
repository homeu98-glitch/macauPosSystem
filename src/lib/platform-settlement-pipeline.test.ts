import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { mapOrderRow, POS_ORDER_DB_COLUMNS, type PosOrderDbRow } from "./pos-order-row.ts";
import {
  actualPayout,
  computeMfoodTotals,
  computeSettlementTotals,
  groupSettlementByOrder,
  normalizePeriodAmounts,
  settlementForOrder,
  type PlatformSettlementTxn,
} from "./pos/platform-settlement.ts";

/**
 * 平台實收（結算）金額嘅**出庫**端到端測試：平台 payload → DB row → mapper → 報表三格。
 *
 * ── 為什麼要專門一支（2026-09-26）──────────────────────────────────
 * `platform_fees`（2026-09-24）嘅教訓：**「寫得入」唔等於「讀得出」。**
 * 當時入庫一直正確，但 `POS_ORDER_DB_COLUMNS` / `PosOrderDbRow` / `mapOrderRow()`
 * 三個地方都漏抄 ⇒ 收銀台拎到嘅 `PosOrder` 冇資料 ⇒ 靜默唔出，白查一輪。
 *
 * 實收金額**一模一樣有兩個 mapper**（長期記憶嘅坑）：
 *   · `pos-order-row.ts`  → 主 POS 同步（/api/pos/state、admin、lookup…）
 *   · `pos/pos-order-mapper.ts` → KDS / Realtime
 * ⇒ 呢支測試**兩個都要驗**，任何一個漏抄就紅。
 *
 * ⚠️ 第二個 mapper **唔可以 import**（佢有 `@/lib/types` 別名 import，`node --test`
 *    解析唔到）。所以採用同 `pos-order-row.test.ts` 一致嘅做法：**讀 source 解析**。
 *    呢個係刻意嘅 —— 唔想為咗測試而拆散型別鏈。
 *
 * ── 資料流（四段，全部要通）────────────────────────────────────────
 *   ① 平台 payload（mfood 原始欄位名）
 *        `tradeNo` / `storeReceiveAmtn` / `subsidyStoreReceiveAmtn`
 *   ② `readTxns()` 改名 → insert 落 `pos_orders`（snake_case numeric）
 *   ③ `mapOrderRow()` 出庫 → `PosOrder.platformNetAmount`（camelCase number|undefined）
 *   ④ `computeMfoodTotals()` → 報表「應收／實收／差額率」三格
 */

// ---------------------------------------------------------------- 工具

/** 讀第二個 mapper 嘅 source（唔可以 import，見檔頭說明）。 */
function readMapperSource(): string {
  return readFileSync(new URL("./pos/pos-order-mapper.ts", import.meta.url), "utf8");
}

/** 呢三欄喺兩個 mapper 都一定要出現（欄位名 ↔ 出庫鍵）。 */
const SETTLEMENT_COLUMNS = [
  "platform_net_amount",
  "platform_subsidy_net",
  "platform_settled_at",
] as const;
const SETTLEMENT_PROPS = [
  "platformNetAmount",
  "platformSubsidyNet",
  "platformSettledAt",
] as const;

/**
 * 一張真實形狀嘅 mfood 平台單 DB row（已對帳）。
 *
 * ⚠️ 刻意用 `number | string` 兩種：PostgREST 回 `numeric` 有時係字串
 *    （`"31.91"`），mapper 一定要頂得住 —— 唔係就會靜默變 NaN。
 */
function mfoodDbRow(over: Partial<PosOrderDbRow> = {}): PosOrderDbRow {
  return {
    id: "mfood-CRD001",
    store_id: "store-1",
    local_order_no: "mfood#1",
    table_id: "counter",
    table_name: "外賣",
    status: "paid",
    fulfillment_status: null,
    sent_to_kitchen_at: null,
    served_at: null,
    items: [
      { menuItemId: "ext-表嫂手打肉餅", name: "表嫂手打肉餅", quantity: 2, price: 31, printerGroup: "kitchen" },
    ],
    order_note: null,
    subtotal: 62,
    tax_amount: 0,
    service_charge_amount: 0,
    discount_amount: 0,
    total: 62,
    prepaid_amount: 62,
    online_order_id: null,
    source: "mfood",
    external_order_id: "CRD202609161003178839221",
    party_size: null,
    comp_note: null,
    comped_at: null,
    discount_note: null,
    payment_method: null,
    created_at: "2026-09-26T02:03:00.000Z",
    updated_at: "2026-09-26T02:03:00.000Z",
    client_updated_at: "2026-09-26T02:03:00.000Z",
    reopen_count: null,
    reopened_at: null,
    reopen_reason: null,
    platform_fees: null,
    // ── 0060 三個結算欄位（已對帳）──
    // 刻意一個 number、一個 string（模擬 PostgREST 兩種回傳）
    platform_net_amount: 35.11,
    platform_subsidy_net: "31.91",
    platform_settled_at: "2026-09-26T10:00:00.000Z",
    ...over,
  } as PosOrderDbRow;
}

/**
 * 平台財務頁 payload 嘅一筆 transaction（mfood 原始欄位名）。
 *
 * ⚠️ `groupSettlementByOrder()` **唔收**呢個形狀 —— 改名係
 *    `settlement/route.ts` 嘅 `readTxns()` 負責。所以測試要用 `readTxnsLike()`
 *    先轉一次，先至反映真正嘅資料流。
 */
function mfoodTxn(over: Partial<PlatformSettlementTxn> = {}): PlatformSettlementTxn {
  return {
    externalOrderId: "CRD202609161003178839221",
    netAmount: 35.11,
    subsidyNet: 31.91,
    businessAmount: 62,
    serviceFee: 26.89,
    ...over,
  };
}

/**
 * 平台原始 payload → `PlatformSettlementTxn`。
 *
 * 🔴 呢個係 `settlement/route.ts` `readTxns()` 嘅**鏡像**。
 *    點解要喺測試重寫一次而唔 import：route 檔有 `next/server` 依賴，
 *    `node --test` 載唔到（同兩個 mapper 一樣嘅處境）。
 *    ⇒ 呢段係刻意嘅複製；如果 route 改咗欄位名而呢度冇跟，測試就會紅
 *      （因為下面有斷言鎖住 route source 真係咁寫）。
 */
function readTxnsLike(raw: Array<Record<string, unknown>>): PlatformSettlementTxn[] {
  return raw.map((r) => ({
    externalOrderId: (r.tradeNo ?? r.externalOrderId ?? null) as string | null,
    netAmount: (r.storeReceiveAmtn ?? r.netAmount ?? null) as number | null,
    subsidyNet: (r.subsidyStoreReceiveAmtn ?? r.subsidyNet ?? null) as number | null,
    businessAmount: (r.storeBusinessAmtn ?? r.businessAmount ?? null) as number | null,
    serviceFee: (r.platformServiceFee ?? r.serviceFee ?? null) as number | null,
  }));
}

// ================================================================ 測試

describe("平台實收：入庫（平台 payload → DB row）", () => {
  it("平台 payload 按 tradeNo 分組，金額原樣保留（元，唔除 100）", () => {
    const g = groupSettlementByOrder([
      mfoodTxn(),
      mfoodTxn({ externalOrderId: "CRD002", netAmount: 30.09, subsidyNet: undefined, businessAmount: 40 }),
    ]);
    assert.equal(g.byOrder.size, 2);
    assert.equal(g.unmatchedCount, 0);

    const first = settlementForOrder(g.byOrder, "CRD202609161003178839221");
    assert.ok(first, "應該配對到第一張單");
    assert.equal(first.netAmount, 35.11);
    assert.equal(first.subsidyNet, 31.91);
    assert.equal(first.txnCount, 1);
  });

  it("同一張單有多筆 transaction → 要加總（唔可以只取最後一筆）", () => {
    const g = groupSettlementByOrder([
      mfoodTxn({ netAmount: 10, subsidyNet: 8 }),
      mfoodTxn({ netAmount: 5.11, subsidyNet: 3.91 }),
    ]);
    const s = settlementForOrder(g.byOrder, "CRD202609161003178839221");
    assert.ok(s);
    assert.equal(s.netAmount, 15.11);
    assert.equal(s.subsidyNet, 11.91);
    assert.equal(s.txnCount, 2);
  });

  it("實收口徑：有補貼用補貼後，冇補貼退回 netAmount", () => {
    assert.equal(actualPayout({ netAmount: 35.11, subsidyNet: 31.91 }), 31.91);
    assert.equal(actualPayout({ netAmount: 35.11, subsidyNet: null }), 35.11);
    assert.equal(actualPayout({ netAmount: 35.11 }), 35.11);
    // 補貼 0 係合法值（＝冇補貼），唔可以當「冇資料」而退回 netAmount
    assert.equal(actualPayout({ netAmount: 35.11, subsidyNet: 0 }), 0);
  });

  it("配對唔到嘅 transaction 要計數（唔可以靜默丟棄）", () => {
    const g = groupSettlementByOrder([
      mfoodTxn(),
      mfoodTxn({ externalOrderId: null, netAmount: 9 }),
      mfoodTxn({ externalOrderId: "   ", netAmount: 9 }),
    ]);
    assert.equal(g.byOrder.size, 1);
    assert.equal(g.unmatchedCount, 2);
  });

  it("金額解析：null / 空字串 → null（唔可以變 0）", () => {
    const g = groupSettlementByOrder([mfoodTxn({ netAmount: null, subsidyNet: undefined })]);
    const s = settlementForOrder(g.byOrder, "CRD202609161003178839221");
    assert.ok(s);
    // 🔴🔴 2026-09-29 修正：呢個斷言原本寫 `assert.equal(s.netAmount, 0)`，
    //    同測試名（「唔可以變 0」）自相矛盾 —— 等於**把假零 bug 鎖死**。
    //    正解係 `null`：DB 欄位本身就係 nullable（0060 特意冇 NOT NULL / DEFAULT 0），
    //    「未對帳」＝ NULL，POS 端先可以顯示「待對帳」而唔係「實收 0」。
    assert.equal(
      s.netAmount,
      null,
      "完全冇任何金額 → null（＝未對帳）；填 0 會被 POS 當成「實收 0」假零",
    );
    assert.equal(s.subsidyNet, null, "同上：冇值就係 null，唔可以造假零");
  });

  it("🔴🔴 澳覓形態（有 netAmount、但完全冇補貼口徑）→ subsidyNet 一定要係 null", () => {
    // 澳覓 bridge 嘅 `normalizeTxn()` 每筆都送 `subsidyNet: null`（澳覓冇補貼兩段口徑）。
    const g = groupSettlementByOrder([
      { externalOrderId: "TK001165260929133047856", netAmount: 43.21, subsidyNet: null },
    ]);
    const s = settlementForOrder(g.byOrder, "TK001165260929133047856");
    assert.ok(s);
    assert.equal(s.netAmount, 43.21);
    assert.equal(
      s.subsidyNet,
      null,
      "冇補貼口徑 ⇒ 必須 null；若變 0，route 會寫 platform_subsidy_net=0 ⇒ POS 顯示實收 0",
    );
    // POS 端口徑：subsidy 係 null ⇒ 正確落返 netAmount（唔會變 0）
    assert.equal(actualPayout({ netAmount: s.netAmount, subsidyNet: s.subsidyNet }), 43.21);
  });
});

describe("平台實收：出庫（DB row → mapper）—— 🔴 兩個 mapper 都要通", () => {
  it("POS_ORDER_DB_COLUMNS 有列三個結算欄位", () => {
    for (const col of SETTLEMENT_COLUMNS) {
      assert.ok(
        (POS_ORDER_DB_COLUMNS as readonly string[]).includes(col),
        `POS_ORDER_DB_COLUMNS 漏咗 ${col} —— 出庫會靜默冇資料`,
      );
    }
  });

  it("mapOrderRow（主 POS）讀得到三個欄位", () => {
    const o = mapOrderRow(mfoodDbRow());
    assert.equal(o.platformNetAmount, 35.11);
    assert.equal(o.platformSubsidyNet, 31.91, "字串 numeric 要轉成 number");
    assert.equal(o.platformSettledAt, "2026-09-26T10:00:00.000Z");
  });

  it("🔴 第二個 mapper（KDS / Realtime）都有齊三欄 —— 唔可以只改一個", () => {
    const src = readMapperSource();
    for (const col of SETTLEMENT_COLUMNS) {
      assert.ok(
        src.includes(col),
        `pos/pos-order-mapper.ts 漏咗 ${col}（DB row 型別 / 出庫鍵）—— Realtime 會靜默冇實收`,
      );
    }
    for (const prop of SETTLEMENT_PROPS) {
      assert.ok(
        src.includes(prop),
        `pos/pos-order-mapper.ts 漏咗 ${prop}（出庫鍵）—— 實收出唔到收銀台`,
      );
    }
  });

  it("🔴 兩個 mapper 嘅出庫鍵名要一致（唔可以一個 camelCase 一個 snake）", () => {
    const main = readFileSync(new URL("./pos-order-row.ts", import.meta.url), "utf8");
    const kds = readMapperSource();
    for (const prop of SETTLEMENT_PROPS) {
      assert.ok(main.includes(prop), `pos-order-row.ts 漏咗 ${prop}`);
      assert.ok(kds.includes(prop), `pos-order-mapper.ts 漏咗 ${prop}`);
    }
  });

  it("🔴 未對帳：NULL → undefined（唔可以變 0）", () => {
    const row = mfoodDbRow({
      platform_net_amount: null,
      platform_subsidy_net: null,
      platform_settled_at: null,
    });
    const o = mapOrderRow(row);
    assert.equal(o.platformNetAmount, undefined, "NULL 應該係 undefined");
    assert.equal(o.platformSubsidyNet, undefined, "NULL 應該係 undefined");
    assert.equal(o.platformSettledAt, undefined, "NULL 應該係 undefined");
    assert.notEqual(o.platformNetAmount, 0, "未對帳唔可以變 0（假零會令店員追數）");

    // 第二個 mapper 都要有同樣嘅 NULL 語意（唔可以用 `?? 0` 兜底）
    const kds = readMapperSource();
    assert.ok(
      /platformNetAmount\s*:\s*numOrUndef\(/.test(kds),
      "pos-order-mapper.ts 嘅 platformNetAmount 一定要經 numOrUndef（唔可以 ?? 0）",
    );
    assert.ok(
      !/platformNetAmount\s*:\s*[^,]*\?\?\s*0/.test(kds),
      "pos-order-mapper.ts 唔可以用 `?? 0` 兜底實收金額",
    );
  });

  it("🔴 欄位完全缺失（舊 DB、未跑 migration）→ undefined，唔會拋錯", () => {
    const row = mfoodDbRow();
    delete (row as Record<string, unknown>).platform_net_amount;
    delete (row as Record<string, unknown>).platform_subsidy_net;
    delete (row as Record<string, unknown>).platform_settled_at;
    assert.equal(mapOrderRow(row).platformNetAmount, undefined);
  });

  it("實收係 0 係合法值（唔可以同「未對帳」混淆）", () => {
    const o = mapOrderRow(mfoodDbRow({ platform_net_amount: 0, platform_subsidy_net: 0 }));
    assert.equal(o.platformNetAmount, 0);
    assert.equal(o.platformSubsidyNet, 0);
  });
});

describe("平台單號（external_order_id）—— 結算配對嘅鑰匙，唔可以漏抄", () => {
  /**
   * 🔴 為咩要單獨鎖佢：
   *
   * `external_order_id` 由 0055 migration 起就存在，**入庫一直正確**
   * （grabber 寫入 + 唯一索引 `(store_id, source, external_order_id)`）。
   * 但佢一直**唔喺 `POS_ORDER_DB_COLUMNS`** ⇒ 走 `/api/pos/state` 嘅路徑
   * （即係整個收銀台）根本冇呢一欄，`mapOrderRow` 亦冇 map 出 `externalOrderId`。
   *
   * 對 POS 本身無影響（冇人讀），但一旦要用佢配對平台結算／顯示平台單號，
   * 就會變成「雲端明明有值、POS 側一片空白」—— 同 0056 `platform_fees`
   * 一模一樣嘅出庫漏抄型 bug（2026-09-24 實案）。
   *
   * 而 0060 嘅結算 route 恰恰就係靠呢個號配對（`.select("id,external_order_id")`），
   * 所以兩邊必須同時見到。
   */
  it("POS_ORDER_DB_COLUMNS 一定要有 external_order_id", () => {
    assert.ok(
      (POS_ORDER_DB_COLUMNS as readonly string[]).includes("external_order_id"),
      "POS_ORDER_DB_COLUMNS 缺 external_order_id —— 收銀台永遠讀唔到平台單號",
    );
  });

  it("mapOrderRow（主 POS）map 出 externalOrderId（camelCase）", () => {
    const o = mapOrderRow(mfoodDbRow());
    assert.equal(o.externalOrderId, "CRD202609161003178839221");
  });

  it("🔴 第二個 mapper（KDS / Realtime）都要有 —— 唔可以只改一個", () => {
    const src = readMapperSource();
    assert.ok(
      src.includes("external_order_id"),
      "pos/pos-order-mapper.ts 冇 external_order_id（DB row 型別）—— Realtime 行會冇平台單號",
    );
    assert.ok(
      src.includes("externalOrderId"),
      "pos/pos-order-mapper.ts 冇 externalOrderId（出庫鍵）—— 收銀台閃返空白",
    );
  });

  it("NULL / 未跑 migration → undefined（店內單零影響）", () => {
    assert.equal(mapOrderRow(mfoodDbRow({ external_order_id: null })).externalOrderId, undefined);
    const row = mfoodDbRow();
    delete (row as Record<string, unknown>).external_order_id;
    assert.equal(mapOrderRow(row).externalOrderId, undefined);
  });

  it("🔴 結算 route 真係用 external_order_id 配對（防兩邊各自漂移）", () => {
    const route = readFileSync(
      new URL("../app/api/integration/grabber/settlement/route.ts", import.meta.url),
      "utf8",
    );
    assert.ok(
      /\.select\([^)]*external_order_id/.test(route),
      "settlement route 冇 select external_order_id —— 配對會靜默全數 notFound",
    );
    assert.ok(
      /\.in\(\s*["']external_order_id["']/.test(route),
      "settlement route 冇按 external_order_id 過濾 —— 配對邏輯改咗就要同步呢個測試",
    );
  });
});

describe("平台實收：報表三格（mapper → computeMfoodTotals）", () => {
  /** 由 mapper 出嘅 PosOrder 形狀（只需要 total / externalOrderId / 結算三欄）。 */
  const ord = (id: string, total: number, net?: number, sub?: number) => {
    const o = mapOrderRow(
      mfoodDbRow({
        id: "m-" + id,
        external_order_id: id,
        total,
        platform_net_amount: net === undefined ? null : net,
        platform_subsidy_net: sub === undefined ? null : sub,
        platform_settled_at: net === undefined && sub === undefined ? null : "2026-09-26T10:00:00.000Z",
      }),
    );
    return o;
  };

  /**
   * 由 mapper 出嘅 `PosOrder` 餵落 `computeMfoodTotals`。
   *
   * 🔴 回 `null`（＝未對帳）而**唔係** `{netAmount: 0}` ——
   *    呢個正係最容易寫錯嘅位：填 0 會令「未對帳」被當成「實收 0」，
   *    報表就會顯示 100% 抽成（假數）。
   *    判斷依據只有一個：`platformSettledAt` 有冇值。
   */
  const settlementOf = (o: { platformNetAmount?: number; platformSubsidyNet?: number; platformSettledAt?: string }) =>
    o.platformSettledAt === undefined
      ? null
      : { netAmount: o.platformNetAmount ?? null, subsidyNet: o.platformSubsidyNet ?? null };

  const totals = (orders: ReturnType<typeof ord>[]) => computeMfoodTotals(orders, settlementOf);

  it("完全未對帳：應收有數、實收 null、差額率 null（唔可以顯示 0%）", () => {
    const t = totals([ord("A", 62), ord("B", 40)]);
    assert.equal(t.receivable, 102);
    assert.equal(t.received, null, "冇任何對帳 → received 應該係 null（唔係 0）");
    assert.equal(t.settledCount, 0);
    assert.equal(t.pendingCount, 2);
    assert.equal(t.feeRate, null, "除數為 0 → 差額率 null");
  });

  it("全部已對帳：使用者原例「營業額 100 / 實收 50 → 50%」", () => {
    const t = totals([ord("A", 100, 50, 50)]);
    assert.equal(t.receivable, 100);
    assert.equal(t.received, 50);
    assert.equal(t.feeRate, 0.5);
    assert.equal(t.settledCount, 1);
    assert.equal(t.pendingCount, 0);
  });

  it("🔴 部分對帳：分子分母都只計已對帳嗰批（唔可以被未對帳拉低）", () => {
    // 已對帳：應收 62，實收 31.91 → 差額率 ~48.5%
    // 未對帳：應收 100（唔應該計入分母）
    const t = totals([ord("A", 62, 35.11, 31.91), ord("B", 100)]);
    assert.equal(t.receivable, 162, "應收係全部平台單（含未對帳）");
    assert.equal(t.received, 31.91);
    assert.equal(t.settledCount, 1);
    assert.equal(t.pendingCount, 1);
    // 1 - 31.91/62 = 0.48532...
    assert.ok(
      Math.abs((t.feeRate ?? 0) - (1 - 31.91 / 62)) < 1e-9,
      `差額率應該用 62 做分母，實際 ${t.feeRate}`,
    );
  });

  it("補貼後口徑：實際到帳（subsidyNet）低過 netAmount 時要用低嗰個", () => {
    const t = totals([ord("A", 100, 35.11, 31.91)]);
    assert.equal(t.received, 31.91, "應該用補貼後實收做「實際到帳」");
    assert.ok((t.feeRate ?? 0) > 1 - 35.11 / 100, "差額率要反映補貼後更低嘅到帳");
  });

  it("浮點安全：0.1 + 0.2 唔可以變 0.30000000000000004", () => {
    const t = totals([ord("A", 0.1, 0.1, 0.1), ord("B", 0.2, 0.2, 0.2)]);
    assert.equal(t.receivable, 0.3);
    assert.equal(t.received, 0.3);
    assert.equal(t.feeRate, 0);
  });

  it("差額率夾在 0..1（平台倒貼都唔可以出負數或 >100%）", () => {
    const over = totals([ord("A", 100, 120, 120)]);
    assert.equal(over.feeRate, 0, "實收多過應收 → clamp 到 0");
    const zero = totals([ord("A", 100, 0, 0)]);
    assert.equal(zero.feeRate, 1, "實收 0 → 100%");
  });

  it("冇平台單 → 全 0 / null（報表區塊唔會 render）", () => {
    const t = totals([]);
    assert.equal(t.receivable, 0);
    assert.equal(t.received, null);
    assert.equal(t.feeRate, null);
    assert.equal(t.settledCount, 0);
    assert.equal(t.pendingCount, 0);
  });
});

describe("平台實收：真 pipeline（payload → DB → mapper → 報表三格）", () => {
  it("🔴 由平台 payload 一路行到報表三格，數字要對得上", () => {
    // ① 平台財務頁回兩筆 transaction（真實欄位名，元為單位）
    const rawPayload = [
      { tradeNo: "CRD001", storeReceiveAmtn: 35.11, subsidyStoreReceiveAmtn: 31.91, storeBusinessAmtn: 62 },
      { tradeNo: "CRD002", storeReceiveAmtn: 30.09, subsidyStoreReceiveAmtn: 30.09, storeBusinessAmtn: 40 },
    ];

    // ② 改名（＝ settlement route 嘅 readTxns）→ 分組
    const g = groupSettlementByOrder(readTxnsLike(rawPayload));
    assert.equal(g.byOrder.size, 2);
    assert.equal(g.unmatchedCount, 0);

    // ③ 落 DB 之後撈出嚟嘅 row（模擬 route 寫完再 SELECT）
    const s1 = settlementForOrder(g.byOrder, "CRD001");
    const s2 = settlementForOrder(g.byOrder, "CRD002");
    assert.ok(s1 && s2);

    const rows = [
      mfoodDbRow({
        id: "r1",
        external_order_id: "CRD001",
        total: 62,
        platform_net_amount: s1.netAmount,
        platform_subsidy_net: s1.subsidyNet,
        platform_settled_at: "2026-09-26T10:00:00.000Z",
      }),
      mfoodDbRow({
        id: "r2",
        external_order_id: "CRD002",
        total: 40,
        platform_net_amount: s2.netAmount,
        platform_subsidy_net: s2.subsidyNet,
        platform_settled_at: "2026-09-26T10:00:00.000Z",
      }),
    ];

    // ④ 出庫（主 mapper 實跑；第二個 mapper 由 source 鎖保證一致）
    const a = rows.map(mapOrderRow);
    assert.equal(a[0].platformNetAmount, 35.11);
    assert.equal(a[0].platformSubsidyNet, 31.91);
    assert.equal(a[1].platformNetAmount, 30.09);

    const kds = readMapperSource();
    for (const prop of SETTLEMENT_PROPS) {
      assert.ok(kds.includes(prop), `KDS mapper 漏咗 ${prop}`);
    }

    // ⑤ 報表三格
    const t = computeMfoodTotals(a, (o) =>
      o.platformSettledAt === undefined
        ? null
        : { netAmount: o.platformNetAmount ?? null, subsidyNet: o.platformSubsidyNet ?? null },
    );
    assert.equal(t.receivable, 102, "應收 = 62 + 40");
    assert.equal(t.received, 62, "實收 = 31.91 + 30.09（補貼後，剛好 62.00）");
    assert.equal(t.settledCount, 2);
    assert.equal(t.pendingCount, 0);
    // 差額率 = 1 - 62/102
    assert.ok(Math.abs((t.feeRate ?? 0) - (1 - 62 / 102)) < 1e-9);
  });

  it("🔴 已對帳 + 未對帳混合：報表唔可以被未對帳嗰批污染", () => {
    const g = groupSettlementByOrder(
      readTxnsLike([
        { tradeNo: "CRD001", storeReceiveAmtn: 35.11, subsidyStoreReceiveAmtn: 31.91 },
      ]),
    );
    const s1 = settlementForOrder(g.byOrder, "CRD001");
    assert.ok(s1);

    const rows = [
      mfoodDbRow({
        id: "settled",
        external_order_id: "CRD001",
        total: 62,
        platform_net_amount: s1.netAmount,
        platform_subsidy_net: s1.subsidyNet,
        platform_settled_at: "2026-09-26T10:00:00.000Z",
      }),
      // 未對帳（今日新單，平台仲未結算）
      mfoodDbRow({
        id: "pending",
        external_order_id: "CRD999",
        total: 100,
        platform_net_amount: null,
        platform_subsidy_net: null,
        platform_settled_at: null,
      }),
    ];

    const orders = rows.map(mapOrderRow);
    assert.equal(orders[1].platformNetAmount, undefined, "未對帳單要係 undefined");

    const t = computeMfoodTotals(orders, (o) =>
      o.platformSettledAt === undefined
        ? null
        : { netAmount: o.platformNetAmount ?? null, subsidyNet: o.platformSubsidyNet ?? null },
    );

    assert.equal(t.receivable, 162, "應收含未對帳（100 + 62）");
    assert.equal(t.received, 31.91, "實收只計已對帳嗰批");
    assert.equal(t.settledCount, 1);
    assert.equal(t.pendingCount, 1, "要報出仲有 1 筆待對帳（唔可以靜默）");
    assert.ok(
      Math.abs((t.feeRate ?? 0) - (1 - 31.91 / 62)) < 1e-9,
      "差額率分母只可以用已對帳嘅 62，唔可以被未對帳嘅 100 溝淡",
    );
  });

  it("🔴🔴 澳覓真 pipeline（事故回歸）：只有 netAmount ⇒ 報表實收要係 43.21 而唔係 0", () => {
    // ① 澳覓 bridge `normalizeTxn()` 嘅真實輸出（`costAmount` ÷ 100 → netAmount；
    //    澳覓冇補貼口徑 ⇒ `subsidyNet: null`）。
    const rawPayload = [
      { tradeNo: "TK001165260929133047856", netAmount: 43.21, grossAmount: 67, subsidyNet: null },
    ];

    // ② 改名（＝ route `readTxns`）→ 分組（＝ route 寫 DB 前嘅最後一步）
    const g = groupSettlementByOrder(readTxnsLike(rawPayload));
    const s = settlementForOrder(g.byOrder, "TK001165260929133047856");
    assert.ok(s);
    assert.equal(s.netAmount, 43.21);
    assert.equal(
      s.subsidyNet,
      null,
      "🔴 route 會寫 platform_subsidy_net = null（唔可以係 0，否則下面報表變實收 0）",
    );

    // ③ 落 DB 之後撈出嚟嘅 row（snake_case；2026-09-29 生產 DB 實測值）
    const row = mfoodDbRow({
      id: "aomi-1",
      source: "aomi",
      local_order_no: "澳覓#1",
      table_name: "外賣",
      external_order_id: "TK001165260929133047856",
      total: 67,
      subtotal: 67,
      prepaid_amount: 67,
      platform_net_amount: s.netAmount,
      platform_subsidy_net: s.subsidyNet,
      platform_settled_at: "2026-09-29T11:20:24.000Z",
    });

    // ④ 出庫（真 mapper 實跑）
    const o = mapOrderRow(row);
    assert.equal(o.platformNetAmount, 43.21);
    assert.equal(o.platformSubsidyNet, undefined, "NULL → undefined（唔可以變 0）");

    // ⑤ 報表三格（同 restaurant-daily-report 嘅 settlementOf 同款）
    const t = computeMfoodTotals([o], (x) => {
      const net = x.platformNetAmount;
      const sub = x.platformSubsidyNet;
      if (net === undefined && sub === undefined) return null;
      return { netAmount: net ?? null, subsidyNet: sub ?? null };
    });
    assert.equal(t.receivable, 67);
    assert.equal(t.received, 43.21, "🔴 回歸：唔可以係 0（2026-09-29 生產事故）");
    assert.equal(t.settledCount, 1, "1 張已配對（徽章顯示「已對帳」）");
    assert.equal(t.pendingCount, 0);
    assert.ok(
      Math.abs((t.feeRate ?? 0) - (1 - 43.21 / 67)) < 1e-9,
      "差額率 ~35.5%，唔可以係 100%",
    );
  });

  it("🔴 鎖住 route 嘅改名規則（上面 readTxnsLike 係佢嘅鏡像，唔可以漂移）", () => {
    const route = readFileSync(
      new URL("../app/api/integration/grabber/settlement/route.ts", import.meta.url),
      "utf8",
    );
    // 平台原始欄位名 → 內部欄位名，逐對檢查
    const pairs: Array<[string, string]> = [
      ["tradeNo", "externalOrderId"],
      ["storeReceiveAmtn", "netAmount"],
      ["subsidyStoreReceiveAmtn", "subsidyNet"],
      ["storeBusinessAmtn", "businessAmount"],
      ["platformServiceFee", "serviceFee"],
    ];
    for (const [plate, internal] of pairs) {
      assert.ok(
        route.includes(plate) && route.includes(internal),
        `settlement route 冇再做 ${plate} → ${internal} 嘅改名 —— 測試鏡像已過時`,
      );
    }
    // 一定要有 fallback（插件可能已改名先送）
    assert.ok(
      /r\.tradeNo[\s\S]{0,80}r\.externalOrderId/.test(route),
      "route 應該同時接受平台原始名同已改名（兼容兩種插件版本）",
    );
  });
});

/**
 * UI 接線 —— 平台實收到底喺邊幾處睇得到。
 *
 * 🔴 為咩要鎖（2026-09-28 真瀏覽器驗證捉到嘅真缺口）：
 *
 * `local-orders-panel` 嘅列表「查看」掣有一個**既有**分流：
 * 已結帳（`settled`）嘅單開嘅係**收據預覽**，唔係詳情彈窗。
 * 而平台單多數一入嚟就係 `settled` ⇒ 商家喺列表永遠入唔到詳情彈窗，
 * 即係話「平台實收」只放喺詳情彈窗**等於冇放**。
 *
 * 呢個係典型「寫得入、讀得出、但**睇唔到**」—— 同 0056 `platform_fees` 一樣。
 * 所以兩處都要有，缺一即紅。
 */
describe("平台實收：UI 接線（詳情彈窗 ＋ 收據預覽都要有）", () => {
  const readPanel = () =>
    readFileSync(new URL("../components/local-orders-panel.tsx", import.meta.url), "utf8");

  it("🔴 收據預覽一定要掛 PlatformSettlementBreakdown（平台單一入嚟就係 settled）", () => {
    const panel = readPanel();
    // 收據預覽區塊：由 `ReceiptTicketPreview` 到 `hasReceivableReceipt` 之間
    const seg = panel.match(/<ReceiptTicketPreview[\s\S]*?hasReceivableReceipt/);
    assert.ok(seg, "搵唔到收據預覽區塊（local-orders-panel 結構改咗？）");
    assert.ok(
      seg[0].includes("PlatformSettlementBreakdown"),
      "收據預覽冇掛平台實收 —— 已結帳平台單（最常見）完全睇唔到實收金額",
    );
    assert.ok(
      seg[0].includes("isPlatformOrder"),
      "收據預覽嘅平台實收要用 isPlatformOrder 擋住，否則店內單會出「待對帳」",
    );
  });

  it("詳情彈窗（viewingOrder）亦要有", () => {
    const panel = readPanel();
    assert.ok(
      /<PlatformSettlementBreakdown\s+order=\{viewingOrder\}/.test(panel),
      "詳情彈窗冇掛平台實收",
    );
  });

  it("🔴 「查看」掣嘅分流仲喺（settled → 收據預覽）—— 改咗就要重新檢視上面兩條斷言", () => {
    const panel = readPanel();
    assert.ok(
      /order\.status === "settled"[\s\S]{0,120}setReceiptPreviewOrderId/.test(panel),
      "「查看」掣嘅 settled 分流改咗 —— 平台實收嘅顯示位置要重新檢視",
    );
  });

  it("收銀台（pos-app）詳情彈窗亦有", () => {
    const app = readFileSync(new URL("../components/pos-app.tsx", import.meta.url), "utf8");
    assert.ok(
      app.includes("PlatformSettlementBreakdown"),
      "pos-app 詳情彈窗冇掛平台實收",
    );
  });

  it("元件本身要讀 externalOrderId（平台單號）先顯示得出", () => {
    const comp = readFileSync(
      new URL("../components/platform-settlement-breakdown.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(comp.includes("externalOrderId"), "元件冇讀 externalOrderId —— 平台單號顯示唔到");
  });
});

/**
 * 帳期級閉環（2026-09-28）—— 插件抓到嘅**帳期金額**要一路落到 DB 同報表。
 *
 * 🔴 為咩要鎖（真機實證）：
 *   逐單配對（上面嗰批測試）靠 `tradeNo` ↔ `external_order_id`，
 *   但實測**配對唔上** ⇒ 報表三格永遠「待對帳」。
 *   帳期金額係平台一定有嘅數字（`_list` 回應自帶），係報表嘅保底。
 *   而保底最容易死喺兩個位：
 *     ① route 見到 `transactions: []` 就 early return（靜默丟棄帳期金額）
 *     ② route 冇 upsert 落 `pos_platform_settlements`
 *   ⇒ 兩者都要鎖死（讀 source 斷言，因為 route 有 `next/server` 依賴載唔入）。
 */
describe("帳期級結算：route 要收 periodAmounts（唔可以見 transactions 空就丟）", () => {
  const readRoute = () =>
    readFileSync(
      new URL("../app/api/integration/grabber/settlement/route.ts", import.meta.url),
      "utf8",
    );

  it("🔴 route 讀 payload.periodAmounts 並經 normalizePeriodAmounts 正規化", () => {
    const route = readRoute();
    assert.ok(
      route.includes("payload.periodAmounts"),
      "route 冇讀 payload.periodAmounts —— 帳期金額會被靜默丟棄",
    );
    assert.ok(
      /normalizePeriodAmounts\(/.test(route),
      "route 冇經 normalizePeriodAmounts —— 唔可以自己另寫一套正規化",
    );
  });

  it("🔴🔴 唔可以「transactions 空 → early return」（帳期金額要寫得入）", () => {
    const route = readRoute();
    // 反例：`if (txns.length === 0) { return ... }` 之前冇處理 periodAmounts
    // 正確：條件必須係 `txns.length === 0 && !periodAmounts`
    assert.ok(
      /if\s*\(\s*txns\.length\s*===\s*0\s*&&\s*!periodAmounts\s*\)/.test(route),
      "route 嘅 early return 條件唔係 `txns.length === 0 && !periodAmounts` —— 只有帳期金額嗰次會被丟棄",
    );
  });

  it("🔴 route 要 upsert 落 pos_platform_settlements（唯一鍵 store_id,source,period）", () => {
    const route = readRoute();
    assert.ok(
      route.includes("pos_platform_settlements"),
      "route 冇寫 pos_platform_settlements —— 帳期金額落唔到 DB",
    );
    assert.ok(
      /upsert[(]/.test(route),
      "route 冇用 upsert —— 重抓同一帳期會撞唯一鍵而失敗",
    );
    assert.ok(
      /onConflict:\s*["']store_id,source,period["']/.test(route),
      "upsert 冇指定 onConflict store_id,source,period —— 同 migration 0061 唯一鍵唔一致",
    );
  });

  it("🔴 帳期寫入失敗唔可以靜默（要寫 log，唔可以只回成功）", () => {
    const route = readRoute();
    assert.ok(
      /帳期金額寫入失敗/.test(route),
      "帳期寫入失敗冇 log —— 商家只會見到「成功但冇數」",
    );
  });

  it("🔴 讀取 route 存在且回應 latest（報表要嘅帳期金額）", () => {
    const read = readFileSync(
      new URL("../app/api/pos/platform-settlements/route.ts", import.meta.url),
      "utf8",
    );
    assert.ok(
      read.includes("pos_platform_settlements"),
      "讀取 route 冇查 pos_platform_settlements",
    );
    assert.ok(
      read.includes("posRouteAuthGuard"),
      "🔴 財務數字係敏感資料 —— 讀取 route 一定要過 posRouteAuthGuard",
    );
    assert.ok(
      /latest/.test(read),
      "讀取 route 冇回 latest —— 報表要靠佢拎最新帳期",
    );
  });

  it("🔴 migration 0061 存在且與 route 嘅欄位名一致", () => {
    const sql = readFileSync(
      new URL("../../supabase/migrations/0061_pos_platform_settlements.sql", import.meta.url),
      "utf8",
    );
    for (const col of [
      "should_amount",
      "receive_amount",
      "subsidy_amount",
      "service_fee",
    ]) {
      assert.ok(sql.includes(col), `migration 0061 冇 ${col}`);
    }
    assert.ok(
      /unique\s*\(\s*store_id\s*,\s*source\s*,\s*period\s*\)/.test(sql),
      "migration 0061 嘅唯一鍵唔係 (store_id, source, period) —— 同 route 嘅 onConflict 對唔上",
    );
    assert.ok(
      /enable row level security/.test(sql),
      "migration 0061 未開 RLS —— 平台抽成數字會經 anon key 外洩",
    );
  });

  it("🔴 帳期金額正規化：route 用嘅係同一個純函式（唔會兩邊漂移）", () => {
    const n = normalizePeriodAmounts({ period: "P1", should: 100, receive: 50, subsidy: 40 });
    assert.ok(n);
    assert.equal(n.should, 100);
    assert.equal(n.receive, 50);
    assert.equal(n.subsidy, 40);
  });
});

/**
 * 報表三格口徑接線鎖（2026-09-29：一律逐單）。
 */
describe("報表三格：一律逐單接線鎖", () => {
  const readReport = () =>
    readFileSync(new URL("../components/restaurant-daily-report.tsx", import.meta.url), "utf8");

  it("🔴 報表要用 computeSettlementTotals（唔可以自己另寫一套合併邏輯）", () => {
    const src = readReport();
    assert.ok(
      src.includes("computeSettlementTotals("),
      "報表冇用 computeSettlementTotals —— 口徑合併邏輯會漂移",
    );
  });

  it("🔴 報表唔可以再 fetch /api/pos/platform-settlements（一律逐單，唔要帳期保底）", () => {
    const src = readReport();
    assert.ok(
      !/fetch\(\s*["'`][^"'`]*\/api\/pos\/platform-settlements/.test(src),
      "一律逐單後報表仲喺度 fetch 平台帳期 → 會靜默蓋過逐單數字",
    );
  });

  it("🔴 報表唔可以再引用 periodSettlement（帳期狀態已移除）", () => {
    const src = readReport();
    assert.ok(
      !src.includes("periodSettlement"),
      "報表仲喺度讀 / 存平台帳期 → 一律逐單口徑會被悄悄推翻",
    );
  });
});
