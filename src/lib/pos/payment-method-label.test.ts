import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { knownLedgerPaymentModes, posPaymentMethodLabel } from "./payment-method-label.ts";

/**
 * 守衛測試（2026-10-07）。
 *
 * 設計原則（見 MEMORY §6.1）：**守行為不變量，唔守代碼字串**。
 *
 * 產品契約只有三條：
 *   ① **畫面唔准出現 Ledger enum 原文**（`in_store` / `balance`…）。
 *   ② **store 自訂支付方式名唔可以被改寫**（「Mpay」「中銀」「Alipay」照原樣顯示）。
 *   ③ **冇值 →統一 fallback**（唔可以因為 undefined 就出現空白行 / `null`）。
 *
 * ⚠️ 後段嘅「源碼層」守衛只檢查**寫入點有冇過映射函式**（唔係寫死某句代碼），
 * 所以無關嘅重構唔會誤爆，但真係改壞就會紅。
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function readSrc(relPath: string): string {
  // 呢啲檔係 CRLF；多行 regex 前統一換行，唔好逐個 pattern 記得處理。
  return readFileSync(join(REPO_ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
}

test("Ledger enum 原文唔可以漏上畫面", () => {
  assert.equal(posPaymentMethodLabel("in_store"), "到店付款");
  assert.equal(posPaymentMethodLabel("balance"), "餘額扣點");
});

test("大小寫／空白差異都要譯（Ledger enum 曾經大小寫唔一致）", () => {
  assert.equal(posPaymentMethodLabel("IN_STORE"), "到店付款");
  assert.equal(posPaymentMethodLabel("Balance"), "餘額扣點");
  assert.equal(posPaymentMethodLabel("  in_store  "), "到店付款");
});

test("store 自訂支付方式名**唔可以被改寫**（最重要）", () => {
  // 呢啲係收銀台／外賣平台實際寫入嘅值，必須原樣出。
  for (const name of ["Mpay", "會員餘額", "外賣平台", "線上已支付", "現金", "中銀", "Alipay"]) {
    assert.equal(posPaymentMethodLabel(name), name, `${name} 唔應該被翻譯`);
  }
});

test("已譯過嘅中文值係冇性映射（唔會出現「到店付款」變另一個名）", () => {
  assert.equal(posPaymentMethodLabel("到店付款"), "到店付款");
  assert.equal(posPaymentMethodLabel("餘額扣點"), "餘額扣點");
});

test("冇值 → fallback，而且唔會出現空白字串", () => {
  for (const empty of [undefined, null, "", "   "]) {
    assert.equal(posPaymentMethodLabel(empty), "未記錄");
    assert.ok(posPaymentMethodLabel(empty).trim().length > 0, "fallback 唔可以係空白");
    assert.equal(posPaymentMethodLabel(empty, "線上單"), "線上單");
  }
});

test("每個已知 Ledger 值都一定要譯成中文（防止新加 enum 漏譯）", () => {
  for (const mode of knownLedgerPaymentModes()) {
    const label = posPaymentMethodLabel(mode);
    assert.notEqual(label, mode, `Ledger enum "${mode}" 未翻譯，會喺報表出現英文`);
    // 譯出嚟嘅標籤唔應該仲帶住底層 ascii 關鍵字。
    assert.ok(label.length > 0, `"${mode}" 譯成空標籤`);
  }
});

test("Guard：兩個 breakdown 寫入點都必須過映射函式", () => {
  // 病灶本身：raw值直接做 bucket key ⇒ 英文行出畫面。
  // 守住report（772）同交班頁（202）兩條路都唔准再直接用 `?? "未記錄"`。
  const report = readSrc("src/components/restaurant-daily-report.tsx");
  const shift = readSrc("src/components/shift-page.tsx");

  // ① 唔准再出現「直接攞 paymentMethod 做 key」嘅舊寫法。
  assert.doesNotMatch(
    report,
    /const method = o\.paymentMethod \?\? "未記錄"/,
    "報表 breakdown 又直接用 raw paymentMethod（會出英文行）",
  );
  assert.doesNotMatch(
    shift,
    /const key = order\.paymentMethod \?\? "未記錄"/,
    "交班頁 breakdown 又直接用 raw paymentMethod（會出英文行）",
  );

  // ② 兩個檔案都必須 import 咗統一映射（防止有人本地再寫一份映射表）。
  assert.match(report, /posPaymentMethodLabel/, "報表未用統一映射函式");
  assert.match(shift, /posPaymentMethodLabel/, "交班頁未用統一映射函式");

  // ③ 分項表同明細表嘅 key 必須同一個函式，否則兩表對唔到數。
  //    （`method:` 欄位＝訂單明細；`paymentBreakdown[method]`＝分項表）
  const detailKey = report.match(/method: posPaymentMethodLabel\(o\.paymentMethod\)/);
  assert.ok(detailKey, "訂單明細嘅支付方式 key 未經映射（會同分項表夾唔到）");
});

test("Guard：唔准再出現第二份Ledger enum 映射表（避免兩邊漂移）", () => {
  // `order-mapper.ts` 嘅 `paymentModeLabel()` 舊寫法係 if (value === "balance")…
  // 病灶根源就係「有翻譯嘅一條路」同「冇翻譯嘅一條路」並存。
  const mapper = readSrc("src/lib/ledger/order-mapper.ts");
  assert.doesNotMatch(
    mapper,
    /===\s*"in_store"/,
    "order-mapper 又手寫 enum 比較（應該委託 posPaymentMethodLabel）",
  );
  assert.match(
    mapper,
    /posPaymentMethodLabel/,
    "order-mapper 唔應該自己處理映射",
  );
});

test("Guard：任何顯示／輸出 paymentMethod 嘅地方都要過映射", () => {
  // 🔴 逐個寫入點登記。**每加一個顯示點就要喺呢度加一條**，
  // 否則下次有人加新地方又會漏（呢個就係 2026-10-07 病灶本身）。
  //
  // 逐一登記嘅寫入點（2026-10-07 全量掃描後）：
  //   - 報表分項表 key           restaurant-daily-report.tsx `aggregate()`
  //   - 報表訂單明細 method       restaurant-daily-report.tsx `posOrderToDetailRow()`
  //   - 報表 Ledger 純線上單     restaurant-daily-report.tsx（fallback「線上單」）
  //   - 報表 CSV 匯出「支付」    restaurant-daily-report.tsx
  //   - 交班 breakdown key        shift-page.tsx `summarizeClosedOrders()`
  //   - 交班歷史記錄 payments     shift-page.tsx（映射後要合併撞名）
  //   - 交班訂單明細 method       shift-page.tsx
  //   - 交班線上拆數明细          shift-page.tsx（fallback「—」）
  //   - 線下訂單 CSV「支付方式」   orders-hub.tsx
  //   - 收據「支付方式」          escpos-template.ts（fallback「現金」）
  const guards: { file: string; forbid: RegExp; why: string }[] = [
    {
      file: "src/components/restaurant-daily-report.tsx",
      forbid: /const method = o\.paymentMethod \?\? "未記錄"/,
      why: "報表 breakdown 又直接用 raw paymentMethod",
    },
    {
      file: "src/components/restaurant-daily-report.tsx",
      forbid: /method: o\.paymentMethod \?\? "未記錄"/,
      why: "報表訂單明細 method 又直接用 raw paymentMethod（會同分項表夾唔到）",
    },
    {
      file: "src/components/restaurant-daily-report.tsx",
      forbid: /支付: o\.paymentMethod \?\? ""/,
      why: "報表 CSV 匯出又直接用 raw paymentMethod",
    },
    {
      file: "src/components/shift-page.tsx",
      forbid: /const key = order\.paymentMethod \?\? "未記錄"/,
      why: "交班 breakdown 又直接用 raw paymentMethod",
    },
    {
      file: "src/components/shift-page.tsx",
      forbid: /method: o\.paymentMethod \?\? "未記錄"/,
      why: "交班訂單明細 method 又直接用 raw paymentMethod",
    },
    {
      file: "src/components/orders-hub.tsx",
      forbid: /支付方式: o\.paymentMethod \?\? ""/,
      why: "線下訂單 CSV 又直接用 raw paymentMethod",
    },
    {
      file: "src/lib/escpos-template.ts",
      forbid: /\$\{order\.paymentMethod \?\? "現金"\}/,
      why: "收據又直接用 raw paymentMethod",
    },
  ];

  for (const { file, forbid, why } of guards) {
    assert.doesNotMatch(readSrc(file), forbid, `${file}：${why}`);
  }

  // 每個寫入點嘅檔案都必須用到統一映射（防止有人本地再寫一份對照表）。
  for (const file of [
    "src/components/restaurant-daily-report.tsx",
    "src/components/shift-page.tsx",
    "src/components/orders-hub.tsx",
    "src/lib/escpos-template.ts",
  ]) {
    assert.match(readSrc(file), /posPaymentMethodLabel/, `${file} 未用統一映射函式`);
  }
});

test("Guard：支付方式卡名唔准再聲稱「只計線下」", () => {
  // 🔴 語意矛盾（2026-10-07）：卡片舊名「支付方式分項（店內 POS 線下）」＋ tag 寫
  // 「只計無 onlineOrderId 嘅本店單」，但 `aggregate()` 實際把三類單都入帳
  // （純線下 POS 單＋線上單投影＋ Ledger 純線上單）。
  // 結果就係 `in_store` / `balance` 呢類線上單指標籤出現喺一張「線下」卡裡。
  //
  // ⚠️ 呢條守嘅係**產品契約**：「卡片唔可以講「只計線下」而實際包括線上單」。
  // 如果將來真係要拆開線上／線下兩張卡，呢條測試**應該**同卡片一齊改（唔係繞過佢）。
  const report = readSrc("src/components/restaurant-daily-report.tsx");

  // ⚠️ 2026-10-08：卡片名經 i18n 包成 `title={t("…")}` 之後，原本嘅
  // `title="…"` 字面比對就唔再命中。呢兩條守嘅係**產品契約**（唔可以聲稱「只計線下」），
  // 同「文案有冇經 t() 包」無關 ⇒ 改成兼容兩種寫法，唔好為咗過測試而還原翻譯。
  assert.doesNotMatch(
    report,
    /支付方式分項（店內 POS 線下）/,
    "卡片名仍聲稱「線下」，但實際口徑含線上單（語意矛盾，會令商家對唔到數）",
  );
  assert.doesNotMatch(
    report,
    /只計無 onlineOrderId 嘅本店單/,
    "tag 仍聲稱「只計無 onlineOrderId」，但實際口徑含線上單（語意矛盾）",
  );
  // 改名後嘅卡名一定要存在，並且明確講「店內收款」。
  assert.match(
    report,
    /title=(?:"支付方式分項（店內收款）"|\{t\("支付方式分項（店內收款）"\)\})/,
    "卡片名應該係「支付方式分項（店內收款）」（涵蓋所有本店實際收款）",
  );
});