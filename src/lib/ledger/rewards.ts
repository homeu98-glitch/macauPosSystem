"use client";

import { friendlyLedgerMemberError } from "@/lib/ledger/member-errors";
import { LedgerMemberGrantRecord, LedgerRewardGrant } from "@/lib/ledger/member-types";
import { ensureLedgerSession } from "@/lib/ledger/session";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";
import { decodeJwtPayload } from "@/lib/pos/realtime-auth-claims";

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

/**
 * 由 JWT 讀 operator id（`sub` claim）。
 *
 * 🔴 2026-10-16（Ledger PR#40）：取代原先嘅 `client.auth.getUser()` ——
 * 每次核銷券都打一次 `GET /auth/v1/user`，而且 `user.id` 本來就等同 JWT 嘅 `sub`
 * （同一張簽名票，server 端 RLS 照樣執行）。本地解碼，零網路。
 *
 * 讀唔到 ⇒ 當「登入已過期」交返上層拋錯（fail-safe，唔好靜默傳空 id）。
 */
function readOperatorIdFromToken(token: string | null | undefined): string | null {
  const sub = decodeJwtPayload(token)?.["sub"];
  return typeof sub === "string" && sub.trim() ? sub.trim() : null;
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
    const { data: sessionData } = await client.auth.getSession();
    const operatorId = readOperatorIdFromToken(sessionData.session?.access_token);
    if (!operatorId) {
      throw new Error("Ledger 登入已過期，請重新登入。");
    }
    const { data, error } = await client.rpc("redeem_reward_grants", {
      p_grant_ids: grantIds,
      p_operator_id: operatorId,
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
