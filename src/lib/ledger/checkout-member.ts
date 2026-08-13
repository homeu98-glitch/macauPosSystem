"use client";

import { applyPosDeduct } from "@/lib/ledger/members";
import { redeemRewardGrants } from "@/lib/ledger/rewards";

export type LedgerMemberCheckoutParams = {
  merchantId: string;
  phone: string;
  deductAvos: number;
  grantIds: string[];
  idempotencyKey: string;
  /** 若先前 redeem 已成功、deduct 失敗，設 true 跳過 redeem（§5.7.3） */
  skipRedeem?: boolean;
};

export type LedgerMemberCheckoutResult = {
  redeemedCount: number;
  deductTxnId?: string;
  balanceAfterAvos?: number;
};

export class LedgerMemberCheckoutError extends Error {
  redeemCompleted: boolean;

  constructor(message: string, redeemCompleted: boolean) {
    super(message);
    this.name = "LedgerMemberCheckoutError";
    this.redeemCompleted = redeemCompleted;
  }
}

/**
 * Ledger Web 對齊：先核銷券，再扣點（非原子；deduct 失敗勿重複 redeem）。
 */
export async function executeLedgerMemberCheckout(
  params: LedgerMemberCheckoutParams,
): Promise<LedgerMemberCheckoutResult> {
  let redeemedCount = 0;
  let redeemCompleted = Boolean(params.skipRedeem);

  try {
    if (!params.skipRedeem && params.grantIds.length > 0) {
      const redeemResult = await redeemRewardGrants(params.grantIds);
      redeemedCount = redeemResult.redeemed;
      redeemCompleted = true;
    }

    if (params.deductAvos <= 0) {
      return { redeemedCount };
    }

    const deductResult = await applyPosDeduct({
      merchantId: params.merchantId,
      phone: params.phone,
      amountAvos: params.deductAvos,
      idempotencyKey: params.idempotencyKey,
    });

    return {
      redeemedCount,
      deductTxnId: deductResult.txnId,
      balanceAfterAvos: deductResult.balanceAfterAvos,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LedgerMemberCheckoutError(message, redeemCompleted);
  }
}
