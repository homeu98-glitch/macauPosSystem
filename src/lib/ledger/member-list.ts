"use client";

import { friendlyLedgerMemberError } from "@/lib/ledger/member-errors";
import { LedgerCustomerSummary } from "@/lib/ledger/member-types";
import { ensureLedgerSession } from "@/lib/ledger/session";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

/**
 * 會員搜尋列表 — RPC `list_merchant_customers`（契約 v3.2 §5.7）。
 *
 * 契約重點（務必遵守）：
 * - **唔好傳 `p_merchant_id`**：店員傳咗會 `not admin`；RPC 由 `is_merchant_staff` 自行判定所屬店。
 * - `p_search` **必須非空**：至少 2 字，或完整 8 位電話。禁止空搜尋當「全店一覽」。
 * - `p_page_size` ≤ 50；一次一頁。
 * - 禁止進頁 dump 全店、禁止 `setInterval` polling、禁止把結果落 localStorage（PII §7.2）。
 * - 回傳 `balance_avos` **已係 paid + gift 合計**，前端唔好再加 gift。
 * - 全店人數要讀 `get_merchant_report_summary.member_count`，**唔好**用呢度嘅 `total` 當全店總數。
 *
 * 要瀏覽全店名單 → 用會員通 Web `/merchant/reports/users`，唔好喺 POS 做全量同步。
 */
export const MEMBER_LIST_PAGE_SIZE = 50;

export type ListMerchantCustomersResult = {
  customers: LedgerCustomerSummary[];
  /** 只係**今次搜尋**嘅筆數，唔係全店總數。 */
  total: number;
  hasMore: boolean;
};

/** 搜尋條件校驗：非空，且（≥2 字 或 完整 8 位電話）。 */
export function isValidMemberSearch(search: string): boolean {
  const value = search.trim();
  if (!value) return false;
  if (/^\d{8}$/.test(value)) return true;
  return value.length >= 2;
}

async function requireRpcClient() {
  const accessToken = await ensureLedgerSession();
  if (!accessToken) {
    throw new Error("Ledger 登入已過期，請重新登入。");
  }
  const client = getLedgerSupabaseClient();
  if (!client) {
    throw new Error("Ledger Supabase 尚未設定。");
  }
  return client;
}

function parseRow(row: Record<string, unknown>): LedgerCustomerSummary {
  return {
    walletId: row.wallet_id ? String(row.wallet_id) : null,
    customerId: row.customer_id ? String(row.customer_id) : null,
    phone: String(row.phone ?? ""),
    displayName: row.display_name ? String(row.display_name) : null,
    nickName: row.nick_name ? String(row.nick_name) : null,
    // ⚠️ balance_avos 已係 paid + gift 合計，唔好再加 gift_balance_avos
    balanceAvos: Number(row.balance_avos ?? 0),
    paidBalanceAvos: Number(row.paid_balance_avos ?? 0),
    giftBalanceAvos: Number(row.gift_balance_avos ?? 0),
  };
}

/** 兼容 array / { items, total } / { customers, total } 等回傳形狀。 */
function normalizeList(data: unknown, page: number): ListMerchantCustomersResult {
  let rawItems: unknown[] = [];
  let total = 0;

  if (Array.isArray(data)) {
    rawItems = data;
    total = data.length;
  } else {
    const payload = (data ?? {}) as Record<string, unknown>;
    const items = payload.items ?? payload.customers ?? payload.data ?? payload.rows;
    rawItems = Array.isArray(items) ? items : [];
    const parsedTotal = Number(payload.total ?? payload.count ?? rawItems.length);
    total = Number.isFinite(parsedTotal) ? parsedTotal : rawItems.length;
  }

  const customers = rawItems.map((row) => parseRow((row ?? {}) as Record<string, unknown>));
  const hasMore =
    total > 0 ? page * MEMBER_LIST_PAGE_SIZE < total : customers.length === MEMBER_LIST_PAGE_SIZE;

  return { customers, total, hasMore };
}

/**
 * 會員搜尋（店員輸入 ≥2 字或完整 8 位電話）。
 * 刻意**唔接** merchantId 參數 —— 契約唔准傳 `p_merchant_id`。
 */
export async function listMerchantCustomers(params: {
  search: string;
  page?: number;
}): Promise<ListMerchantCustomersResult> {
  const search = params.search.trim();

  if (!isValidMemberSearch(search)) {
    throw new Error("請輸入至少 2 個字，或完整 8 位電話號碼。");
  }

  const page = Math.max(1, Math.floor(params.page ?? 1));

  try {
    const client = await requireRpcClient();
    const { data, error } = await client.rpc("list_merchant_customers", {
      p_search: search,
      p_page: page,
      p_page_size: MEMBER_LIST_PAGE_SIZE,
    });
    if (error) throw new Error(error.message);
    return normalizeList(data, page);
  } catch (err) {
    throw new Error(friendlyLedgerMemberError(err instanceof Error ? err.message : String(err)));
  }
}
