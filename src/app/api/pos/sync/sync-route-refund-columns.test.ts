import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * `/api/pos/sync` 嘅「退款審計 3 欄探測」**只可以探一次**（2026-09-21）。
 *
 * ## 背景（實測）
 *
 * Supabase log（營業中，5.5 分鐘）：**11 個 `error 42703`**
 *（`column pos_orders.refund_records does not exist`）＋ **11 個 `warning 400`**
 * —— 每個 `/api/pos/sync` 一次（每 30 秒），因為舊版每次都試 9 欄、
 * 而呢 3 欄喺**全部 migration 都冇定義、亦冇任何地方寫入**。
 *
 * ## 為何要用測試鎖死
 *
 * 呢段碼有**兩個相反方向**嘅陷阱，兩邊都會靜默出事：
 *   · **每次照試**（＝原本嘅 bug）→ 每個 sync 一個 400 ＋ 一條 Error 級 Postgres log
 *     （唔影響資料，但污染告警／燒 DB log 額度，而且係「唔應該發生」嘅 error）。
 *   · **索性剷走成段探測** → 將來真係加咗欄就**永遠唔會啟用**，
 *     令「呢次更新係一次退貨」嘅守門豁免失效（`existingById` 唔可以空）。
 *
 * ⇒ 正解係「**試一次、記住結果**」。呢個檔用 source 掃描守住呢個形態。
 */

const SRC = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

describe("/api/pos/sync — 退款審計欄探測只做一次", () => {
  it("有 per-instance 快取（`refundAuditColumnsAvailable`）", () => {
    assert.ok(
      /let refundAuditColumnsAvailable: boolean \| null = null;/.test(SRC),
      "缺少 per-instance 探測快取 → 會變返每次 sync 都撞 42703",
    );
  });

  it("🔴 探測到唔存在之後，select 一定要退回 6 欄", () => {
    assert.ok(
      /refundAuditColumnsAvailable === false \? "" : ",refund_records,refunded_amount,voided_items"/.test(
        SRC,
      ),
      "refundColumns 冇按快取退回空字串 → 每個 sync 都會再造一個 400",
    );
  });

  it("42703 分支要記住「唔存在」（設 false）", () => {
    const i = SRC.indexOf("if (existingErr && isMissingColumnError(existingErr)) {");
    assert.ok(i > 0, "搵唔到 42703 降級分支");
    const block = SRC.slice(i, i + 500);
    assert.ok(
      /refundAuditColumnsAvailable = false;/.test(block),
      "42703 分支冇設 false ⇒ 下次仍然會試 9 欄",
    );
  });

  it("9 欄查得通要記住（設 true）—— 保留「將來加欄自動啟用」嘅能力", () => {
    assert.ok(
      /else if \(!existingErr && refundColumns\) \{[\s\S]{0,200}refundAuditColumnsAvailable = true;/m.test(SRC),
      "冇設 true ⇒ 將來真係加咗欄都唔會用返 9 欄（守門豁免永遠失效）",
    );
  });

  it("探測段落**唔可以被剷走**（一定要保留降至 6 欄嘅 fallback 同 warning）", () => {
    assert.ok(
      SRC.includes("pos_orders 缺退款審計欄（migration 未跑）→ 降級查詢"),
      "降級 warning 唔見咗 ⇒ 有人剷咗成段探測（會令將來加欄失效）",
    );
    assert.ok(
      SRC.includes(".select(baseColumns)"),
      "6 欄 fallback 查詢唔見咗",
    );
  });
});
