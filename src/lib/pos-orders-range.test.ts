import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyOrdersRangeFailure, decideReopenedLegOutcome, mergeOrderLegs } from "./pos/orders-range-shared.ts";
import { isMissingColumnError, isMissingFunctionError, isUniqueViolationError } from "./supabase-errors.ts";

/**
 * 訂單區間查詢嘅**降級決策**（2026-09-21 egress 優化）。
 *
 * 新邏輯：
 *   ① SQL RPC `pos_orders_page`（migration 0046）＝ 1 次 round trip、每行只回一次（省 2/3）
 *   ② 函數唔存在（PGRST202 / 42883）→ 降級「三條時間腿」（舊行為）
 *   ③ 投影撞未跑 migration 嘅欄（42703 / PGRST204）→ 再降級 `select("*")`
 *
 * 🔴 為咩要用測試鎖死：每一層降級錯方向都係**靜默**失真 ——
 *    該降唔降 = 報表「全頁 error」或整頁空白；
 *    唔該降而降 = 同一個慢查詢跑三次（egress 反升）；
 *    把「欄位唔存在」誤判成「函數唔存在」= 白白走三腿路徑（省唔到流量但唔會錯）；
 *    把「真 DB 錯誤」當成投影問題 = 靜默回空陣列 → **報表顯示少錢**。
 *
 * ⚠️ 呢個 test 只覆蓋純決策；真正 I/O（Supabase client 呼叫）由 tsc + 煙霧測試把關 ——
 *    因為 `pos-orders-range.ts` 有 `import "server-only"`，`node --test` 解唔到。
 */

const pgrst202 = { code: "PGRST202", message: "Could not find the function public.pos_orders_page(p_store_id, p_start, p_end, p_limit, p_offset) in the schema cache" };
const pg42883 = { code: "42883", message: "function public.pos_orders_page(text, timestamptz) does not exist" };
const col42703 = { code: "42703", message: "column pos_orders.reopened_at does not exist" };
const col204 = { code: "PGRST204", message: "Could not find the 'reopened_at' column of 'pos_orders' in the schema cache" };
const timeout = { code: "57014", message: "canceling statement due to statement timeout" };
const permission = { code: "42501", message: "permission denied for table pos_orders" };

describe("classifyOrdersRangeFailure — 降級方向判別", () => {
  it("函數唔存在（PGRST202 / 42883）→ rpc-missing（改用三條時間腿）", () => {
    assert.equal(classifyOrdersRangeFailure(pgrst202), "rpc-missing");
    assert.equal(classifyOrdersRangeFailure(pg42883), "rpc-missing");
  });

  it("欄位唔存在（42703 / PGRST204）→ projection-missing（改 select(*) 重試）", () => {
    assert.equal(classifyOrdersRangeFailure(col42703), "projection-missing");
    assert.equal(classifyOrdersRangeFailure(col204), "projection-missing");
  });

  it("真 DB 錯誤 → fatal（唔可以降級重試，必須向上報）", () => {
    assert.equal(classifyOrdersRangeFailure(timeout), "fatal");
    assert.equal(classifyOrdersRangeFailure(permission), "fatal");
    assert.equal(classifyOrdersRangeFailure({ message: "fetch failed" }), "fatal");
    assert.equal(classifyOrdersRangeFailure(null), "fatal");
    assert.equal(classifyOrdersRangeFailure(undefined), "fatal");
  });

  it("🔴 唔可以撈埋：欄位錯誤 ≠ 函數錯誤（反之亦然）", () => {
    // PostgREST 兩種錯誤嘅 message 都含 "schema cache"，靠 code 分流
    assert.notEqual(classifyOrdersRangeFailure(col204), "rpc-missing");
    assert.notEqual(classifyOrdersRangeFailure(pgrst202), "projection-missing");
  });
});

describe("isMissingFunctionError / isMissingColumnError — 判別器本身", () => {
  it("函數判別器唔會被「欄位唔存在」嘅訊息呃到", () => {
    assert.equal(isMissingFunctionError(col42703), false);
    assert.equal(isMissingFunctionError(col204), false, "PGRST204 係欄位錯誤，唔可以當函數唔存在");
    assert.equal(isMissingFunctionError(pgrst202), true);
    assert.equal(isMissingFunctionError(pg42883), true);
  });

  it("欄位判別器唔會被「函數唔存在」嘅訊息呃到", () => {
    assert.equal(isMissingColumnError(pgrst202), false);
    assert.equal(isMissingColumnError(pg42883), false);
    assert.equal(isMissingColumnError(col42703), true);
    assert.equal(isMissingColumnError(col204), true);
  });

  it("唯一鍵衝突（23505）獨立判別，唔會同上面兩個混淆", () => {
    const dup = { code: "23505", message: "duplicate key value violates unique constraint \"pos_print_jobs_once_key_uidx\"" };
    assert.equal(isUniqueViolationError(dup), true);
    assert.equal(isMissingColumnError(dup), false);
    assert.equal(isMissingFunctionError(dup), false);
    assert.equal(classifyOrdersRangeFailure(dup), "fatal");
  });
});

describe("decideReopenedLegOutcome — reopened 腿例外規則", () => {
  it("冇錯 → skip", () => {
    assert.equal(decideReopenedLegOutcome(null), "skip");
    assert.equal(decideReopenedLegOutcome(undefined), "skip");
  });

  it("🔴 投影類錯誤 → fail（向上報，令外層降級 select(*)）", () => {
    // 唔咁做嘅話 reopened 腿會靜默變「永遠 0 命中」→ 報表少咗「返結重結」嘅單
    assert.equal(decideReopenedLegOutcome(col42703), "fail");
    assert.equal(decideReopenedLegOutcome(col204), "fail");
  });

  it("非投影錯誤 → skip（維持「加碼而非必需」嘅歷史語義）", () => {
    assert.equal(decideReopenedLegOutcome(timeout), "skip");
    assert.equal(decideReopenedLegOutcome(permission), "skip");
  });
});

describe("mergeOrderLegs — 三腿去重 + 排序", () => {
  const row = (id: string, created: string) => ({ id, created_at: created });

  it("同一張單命中多條腿 → 只回一次", () => {
    const created = [row("a", "2026-09-20T10:00:00Z"), row("b", "2026-09-20T09:00:00Z")];
    const updated = [row("a", "2026-09-20T10:00:00Z"), row("c", "2026-09-20T08:00:00Z")];
    const reopened = [row("a", "2026-09-20T10:00:00Z")];
    const out = mergeOrderLegs([created, updated, reopened]);
    assert.deepEqual(
      out.map((r) => r.id),
      ["a", "b", "c"],
      "a 命中三條腿都只可以出現一次",
    );
  });

  it("統一按 created_at DESC（穩定輸出／分頁唔會跳行）", () => {
    const out = mergeOrderLegs([
      [row("old", "2026-09-18T00:00:00Z")],
      [row("new", "2026-09-21T00:00:00Z")],
      [row("mid", "2026-09-19T00:00:00Z")],
    ]);
    assert.deepEqual(
      out.map((r) => r.id),
      ["new", "mid", "old"],
    );
  });

  it("空腿／缺欄／非法 row 都要安全（NULL updated_at 嘅 legacy row）", () => {
    assert.deepEqual(mergeOrderLegs([]), []);
    assert.deepEqual(mergeOrderLegs([[], [], []]), []);
    const withBad = mergeOrderLegs([
      [row("ok", ""), null as never, { created_at: "2026-09-20T00:00:00Z" } as never],
    ]);
    assert.deepEqual(
      withBad.map((r) => r.id),
      ["ok"],
      "冇 id 嘅 row 要跳過，唔可以變成 undefined key",
    );
    // created_at 缺失 → 當 0 → 排最後
    const noDate = mergeOrderLegs([[{ id: "noDate" }, row("hasDate", "2026-09-20T00:00:00Z")]]);
    assert.deepEqual(
      noDate.map((r) => r.id),
      ["hasDate", "noDate"],
    );
  });

  it("保留最先見到嗰條腿嘅 row 物件（唔會用後腿覆蓋前腿）", () => {
    const first = { id: "x", created_at: "2026-09-20T00:00:00Z", marker: "created" };
    const second = { id: "x", created_at: "2026-09-20T00:00:00Z", marker: "updated" };
    const out = mergeOrderLegs([[first], [second]]);
    assert.equal((out[0] as { marker?: string }).marker, "created");
  });
});
