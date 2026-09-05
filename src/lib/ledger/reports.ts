"use client";

import { ledgerReportRangeForKey, ReportRangeKey } from "@/lib/ledger/report-period";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

export type LedgerReportSummary = {
  orderCount: number;
  orderPaidMop: number;
  orderBalancePaidMop: number;
  orderInStorePaidMop: number;
  topupMop: number;
  /** topup 嘅 paid 子集（會員實際用現金/卡充入嘅部分）。Ledger UI 顯示為「實際充值」。 */
  topupPaidMop: number;
  /** topup 嘅 gift 子集（Ledger 送贈／活動獎勵入帳部分）。Ledger UI 顯示為「贈送入帳」。 */
  topupGiftMop: number;
  /** 會員扣點總額（餘額扣減 = 已用 paid + gift 兩邊嘅扣減合併）。Ledger UI 顯示為「扣點」。 */
  deductMop: number;
  /** deduct 嘅 paid 子集（從 paid 餘額扣減嘅部分）。 */
  deductPaidMop: number;
  /** deduct 嘅 gift 子集（從 gift 餘額扣減嘅部分）。 */
  deductGiftMop: number;
  /** 本店會員總數（wallets 列數）；來自 RPC `get_merchant_report_summary` 的 member_count。
   *  契約：店員呼叫省略 p_merchant_id；list_merchant_customers.total 只係搜尋筆數，唔係全店總數。 */
  memberCount: number;
  /** 開發用：RPC 返回嘅原始 avos 字段全集（key → 數值）。用嚟排查 Ledger UI 顯示但未對應到強型別欄位嘅 case
   *  （例如「筆數」可能係 topup_count / deduct_count / txn_count 之一）。Production 可以由 console.log 過濾。
   *  注意：呢個字段唔係穩定契約，RPC 改 schema 唔會視為 breaking change。 */
  rawAvos: Record<string, number>;
  /** 會員充值筆數（Ledger UI「筆數」內 topup 部分）。RPC 字段名多變：topup_count / topup_txn_count / count_topup。
   *  缺字段時 undefined，UI 唔 render。 */
  topupCount?: number;
  /** 會員扣點筆數（Ledger UI「筆數」內 deduct 部分）。RPC 字段名多變：deduct_count / deduct_txn_count / count_deduct。
   *  缺字段時 undefined，UI 唔 render。 */
  deductCount?: number;
  /** 區間內新增會員數。RPC 字段名多變：new_member_count / member_new_count / wallet_new_count。
   *  缺字段時 undefined，UI 唔 render。 */
  newMemberCount?: number;
  /** 會員餘額總額（全店 wallets 餘額合計，÷100 = MOP）。RPC 字段名多變：balance_avos / total_balance_avos /
   *  member_balance_avos / wallet_balance_avos / balance_total_avos。缺字段時 undefined，UI 顯示「—」。 */
  balanceTotalMop?: number;
};

/** 一個 page load 只 dump 一次 RPC payload 嚟搵「筆數」等未對應欄位。避免 hot reload 重覆 dump。 */
let __reportSummaryDebugDumped = false;

function avosToMop(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

/** 把 raw avos payload 規範化為 { fieldName: numericAvos }。RPC 返回嘅非數字字段（例如 merchant_id）會被過濾。 */
function normalizeAvosPayload(payload: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) {
      out[k] = Number(v);
    }
  }
  return out;
}

/** 喺 rawAvos 內 probe 多個可能嘅字段名，第一個命中的就用。全部唔中就返 undefined。 */
function pickAvosField(raw: Record<string, number>, candidates: readonly string[]): number | undefined {
  for (const key of candidates) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

export async function getMerchantReportSummary(range: ReportRangeKey): Promise<LedgerReportSummary> {
  const client = getLedgerSupabaseClient();
  if (!client) {
    throw new Error("Ledger Supabase 尚未設定。");
  }

  const period = ledgerReportRangeForKey(range);
  if (!period) {
    throw new Error("無法計算報表區間。");
  }

  const { data, error } = await client.rpc("get_merchant_report_summary", {
    p_start: period.start,
    p_end: period.end,
  });

  if (error) {
    throw new Error(error.message);
  }

  const payload = (data ?? {}) as Record<string, unknown>;
  const rawAvos = normalizeAvosPayload(payload);

  // 一次性 dump：協助對齊 Ledger UI（例如「筆數」110）對應到 RPC 邊個字段。
  // 顯式 console.log 一行 JSON（avos 原值，÷ 100 = MOP），睇起嚟比 console.table 清晰。
  if (!__reportSummaryDebugDumped && typeof console !== "undefined") {
    // eslint-disable-next-line no-console
    console.log("[report] get_merchant_report_summary 原始 avos payload（÷100 = MOP）：", rawAvos);
    __reportSummaryDebugDumped = true;
  }

  return {
    orderCount: Number(rawAvos.order_count ?? 0),
    orderPaidMop: avosToMop(rawAvos.order_paid_avos),
    orderBalancePaidMop: avosToMop(rawAvos.order_balance_paid_avos),
    orderInStorePaidMop: avosToMop(rawAvos.order_in_store_paid_avos),
    topupMop: avosToMop(rawAvos.topup_avos),
    topupPaidMop: avosToMop(rawAvos.topup_paid_avos),
    topupGiftMop: avosToMop(rawAvos.topup_gift_avos),
    deductMop: avosToMop(rawAvos.deduct_avos),
    deductPaidMop: avosToMop(rawAvos.deduct_paid_avos),
    deductGiftMop: avosToMop(rawAvos.deduct_gift_avos),
    memberCount: Number(rawAvos.member_count ?? 0),
    topupCount: pickAvosField(rawAvos, ["topup_count", "topup_txn_count", "count_topup", "topups_count"]),
    deductCount: pickAvosField(rawAvos, ["deduct_count", "deduct_txn_count", "count_deduct", "deducts_count"]),
    newMemberCount: pickAvosField(rawAvos, [
      "new_member_count",
      "member_new_count",
      "wallet_new_count",
      "new_wallet_count",
      "members_new_count",
    ]),
    balanceTotalMop: (() => {
      const raw = pickAvosField(rawAvos, [
        "balance_avos",
        "total_balance_avos",
        "member_balance_avos",
        "wallet_balance_avos",
        "balance_total_avos",
      ]);
      return raw != null ? avosToMop(raw) : undefined;
    })(),
    rawAvos,
  };
}

/** Phase B（模塊 6）：會員總數。
 * 契約確認 RPC `get_merchant_member_summary` 不存在；本店會員總數統一由
 * `getMerchantReportSummary` 的 `member_count` 取得（wallets 列數）。故呢度唔再獨立 call RPC。 */
export function reportMemberCount(summary: LedgerReportSummary | null): number | null {
  return summary ? summary.memberCount : null;
}
