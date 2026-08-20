"use client";

import { friendlyLedgerMemberError } from "@/lib/ledger/member-errors";
import { LedgerCustomerWallet } from "@/lib/ledger/member-types";
import { ensureLedgerSession } from "@/lib/ledger/session";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

function parseWallet(data: unknown): LedgerCustomerWallet {
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    registered: Boolean(row.registered),
    customerPhone: String(row.customer_phone ?? ""),
    customerId: row.customer_id ? String(row.customer_id) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    balanceAvos: Number(row.balance_avos ?? 0),
    giftBalanceAvos: Number(row.gift_balance_avos ?? 0),
  };
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

export async function lookupCustomerWallet(merchantId: string, phone: string): Promise<LedgerCustomerWallet> {
  try {
    const client = await requireRpcClient();
    const { data, error } = await client.rpc("merchant_lookup_customer_wallet", {
      p_merchant_id: merchantId,
      p_phone: phone,
    });
    if (error) throw new Error(error.message);
    return parseWallet(data);
  } catch (err) {
    throw new Error(friendlyLedgerMemberError(err instanceof Error ? err.message : String(err)));
  }
}

export type ApplyPosDeductResult = {
  txnId: string;
  amountAvos: number;
  balanceAfterAvos: number;
};

export async function applyPosDeduct(params: {
  merchantId: string;
  phone: string;
  amountAvos: number;
  idempotencyKey: string;
}): Promise<ApplyPosDeductResult> {
  if (!params.idempotencyKey.trim()) {
    throw new Error("idempotency key required");
  }
  if (params.amountAvos <= 0) {
    throw new Error("扣款金額須大於 0");
  }
  try {
    const client = await requireRpcClient();
    const { data, error } = await client.rpc("merchant_apply_pos_txn", {
      p_merchant_id: params.merchantId,
      p_type: "deduct",
      p_phone: params.phone,
      p_amount_avos: params.amountAvos,
      p_idempotency_key: params.idempotencyKey,
    });
    if (error) throw new Error(error.message);
    const row = (data ?? {}) as Record<string, unknown>;
    return {
      txnId: String(row.txn_id ?? ""),
      amountAvos: Number(row.amount_avos ?? params.amountAvos),
      balanceAfterAvos: Number(row.balance_after ?? 0),
    };
  } catch (err) {
    throw new Error(friendlyLedgerMemberError(err instanceof Error ? err.message : String(err)));
  }
}

/**
 * 反向加回（返結 / 退款時把先前扣減的餘額退返客戶）。
 * 走 Ledger `merchant_apply_pos_txn` p_type:"add"。
 *
 * 注意：現階段 Ledger 後端可能尚未佈署 add 分支（見 docs/39 需求書）。
 * 本函數會如實拋錯，由呼叫方（reopenPosOrder）以 best-effort 方式 catch 後
 * 繼續完成返結狀態切換，不阻擋工人操作。
 */
export async function applyPosAdd(params: {
  merchantId: string;
  phone: string;
  amountAvos: number;
  idempotencyKey: string;
}): Promise<ApplyPosDeductResult> {
  if (!params.idempotencyKey.trim()) {
    throw new Error("idempotency key required");
  }
  if (params.amountAvos <= 0) {
    throw new Error("加回金額須大於 0");
  }
  try {
    const client = await requireRpcClient();
    const { data, error } = await client.rpc("merchant_apply_pos_txn", {
      p_merchant_id: params.merchantId,
      p_type: "add",
      p_phone: params.phone,
      p_amount_avos: params.amountAvos,
      p_idempotency_key: params.idempotencyKey,
    });
    if (error) throw new Error(error.message);
    const row = (data ?? {}) as Record<string, unknown>;
    return {
      txnId: String(row.txn_id ?? ""),
      amountAvos: Number(row.amount_avos ?? params.amountAvos),
      balanceAfterAvos: Number(row.balance_after ?? 0),
    };
  } catch (err) {
    throw new Error(friendlyLedgerMemberError(err instanceof Error ? err.message : String(err)));
  }
}
