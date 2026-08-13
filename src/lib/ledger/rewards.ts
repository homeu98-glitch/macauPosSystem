"use client";

import { friendlyLedgerMemberError } from "@/lib/ledger/member-errors";
import { LedgerMemberGrantRecord, LedgerRewardGrant } from "@/lib/ledger/member-types";
import { ensureLedgerSession } from "@/lib/ledger/session";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

function parseGrant(row: Record<string, unknown>): LedgerRewardGrant {
  const prizeType = String(row.prize_type ?? "");
  return {
    grantId: String(row.grant_id ?? ""),
    prizeType: prizeType === "text_gift" ? "text_gift" : "money_voucher",
    title: String(row.title ?? "優惠券"),
    rewardAmountAvos: Number(row.reward_amount_avos ?? 0),
    endsAt: row.ends_at ? String(row.ends_at) : undefined,
    expiresAt: row.expires_at ? String(row.expires_at) : undefined,
  };
}

function parseMemberGrantRecord(row: Record<string, unknown>): LedgerMemberGrantRecord {
  const base = parseGrant(row);
  return {
    ...base,
    campaignId: row.campaign_id ? String(row.campaign_id) : undefined,
    issuedAt: row.issued_at ? String(row.issued_at) : undefined,
    redeemedAt: row.redeemed_at ? String(row.redeemed_at) : null,
    status: String(row.status ?? "issued"),
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

export async function listRedeemableGrantsForCustomer(
  merchantId: string,
  customerId: string,
): Promise<LedgerRewardGrant[]> {
  try {
    const client = await requireRpcClient();
    const { data, error } = await client.rpc("list_redeemable_grants_for_customer", {
      p_merchant_id: merchantId,
      p_customer_id: customerId,
    });
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) return [];
    return data
      .map((row) => parseGrant(row as Record<string, unknown>))
      .filter((grant) => grant.grantId);
  } catch (err) {
    throw new Error(friendlyLedgerMemberError(err instanceof Error ? err.message : String(err)));
  }
}

export async function listCustomerRewardGrants(
  merchantId: string,
  customerId: string,
): Promise<LedgerMemberGrantRecord[]> {
  try {
    const client = await requireRpcClient();
    const { data, error } = await client.rpc("list_customer_reward_grants", {
      p_merchant_id: merchantId,
      p_customer_id: customerId,
    });
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) return [];
    return data
      .map((row) => parseMemberGrantRecord(row as Record<string, unknown>))
      .filter((grant) => grant.grantId);
  } catch (err) {
    throw new Error(friendlyLedgerMemberError(err instanceof Error ? err.message : String(err)));
  }
}

export type RedeemGrantsResult = {
  redeemed: number;
  items: Array<{
    grantId: string;
    title: string;
    prizeType: string;
    rewardAmountAvos: number;
  }>;
};

export async function redeemRewardGrants(grantIds: string[]): Promise<RedeemGrantsResult> {
  if (grantIds.length === 0) {
    return { redeemed: 0, items: [] };
  }
  try {
    const client = await requireRpcClient();
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError || !userData.user?.id) {
      throw new Error("Ledger 登入已過期，請重新登入。");
    }
    const { data, error } = await client.rpc("redeem_reward_grants", {
      p_grant_ids: grantIds,
      p_operator_id: userData.user.id,
    });
    if (error) throw new Error(error.message);
    const row = (data ?? {}) as Record<string, unknown>;
    const items = Array.isArray(row.items)
      ? row.items.map((item) => {
          const grant = item as Record<string, unknown>;
          return {
            grantId: String(grant.grant_id ?? ""),
            title: String(grant.title ?? ""),
            prizeType: String(grant.prize_type ?? ""),
            rewardAmountAvos: Number(grant.reward_amount_avos ?? 0),
          };
        })
      : [];
    return {
      redeemed: Number(row.redeemed ?? items.length),
      items,
    };
  } catch (err) {
    throw new Error(friendlyLedgerMemberError(err instanceof Error ? err.message : String(err)));
  }
}
