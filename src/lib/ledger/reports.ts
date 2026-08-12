"use client";

import { ledgerReportRangeForKey, ReportRangeKey } from "@/lib/ledger/report-period";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

export type LedgerReportSummary = {
  orderCount: number;
  orderPaidMop: number;
  orderBalancePaidMop: number;
  orderInStorePaidMop: number;
  topupMop: number;
  deductMop: number;
};

function avosToMop(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
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

  return {
    orderCount: Number(payload.order_count ?? 0),
    orderPaidMop: avosToMop(payload.order_paid_avos),
    orderBalancePaidMop: avosToMop(payload.order_balance_paid_avos),
    orderInStorePaidMop: avosToMop(payload.order_in_store_paid_avos),
    topupMop: avosToMop(payload.topup_avos),
    deductMop: avosToMop(payload.deduct_avos),
  };
}
