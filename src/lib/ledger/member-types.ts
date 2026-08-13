export type LedgerRewardGrant = {
  grantId: string;
  prizeType: "money_voucher" | "text_gift";
  title: string;
  rewardAmountAvos: number;
  endsAt?: string;
  expiresAt?: string;
};

/** 會員頁 `list_customer_reward_grants` 回傳（含歷史券）。 */
export type LedgerMemberGrantRecord = LedgerRewardGrant & {
  campaignId?: string;
  issuedAt?: string;
  redeemedAt?: string | null;
  status: string;
};

export type LedgerCustomerWallet = {
  registered: boolean;
  customerPhone: string;
  customerId: string | null;
  displayName: string | null;
  balanceAvos: number;
  giftBalanceAvos: number;
};

/** 結帳 modal 記憶體內會員狀態（禁止寫入 localStorage）。 */
export type LedgerCheckoutMember = LedgerCustomerWallet & {
  redeemableGrants: LedgerRewardGrant[];
};

/** 會員頁查詢結果（僅記憶體，禁止持久化）。 */
export type LedgerMemberProfile = LedgerCustomerWallet & {
  allGrants: LedgerMemberGrantRecord[];
};

export function avosToMop(avos: number): number {
  return Math.round(Number(avos)) / 100;
}

export function mopToAvos(mop: number): number {
  return Math.round(Number(mop) * 100);
}

export function grantTypeLabel(prizeType: LedgerRewardGrant["prizeType"]): string {
  return prizeType === "money_voucher" ? "現金券" : "禮品券";
}

export function sumMoneyVoucherAvos(grants: LedgerRewardGrant[], selectedIds: string[]): number {
  return grants
    .filter((grant) => selectedIds.includes(grant.grantId) && grant.prizeType === "money_voucher")
    .reduce((sum, grant) => sum + grant.rewardAmountAvos, 0);
}

export function grantStatusLabel(status: string): string {
  if (status === "issued") return "可用";
  if (status === "redeemed") return "已兌換";
  if (status === "expired") return "已過期";
  return status;
}

export function isGrantActive(grant: LedgerMemberGrantRecord): boolean {
  if (grant.status !== "issued") return false;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) return false;
  return true;
}

export function formatGrantExpiry(expiresAt?: string): string {
  if (!expiresAt) return "無到期日";
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return expiresAt;
  return new Date(parsed).toLocaleDateString("zh-HK", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
