import { PosBootstrap } from "@/lib/types";
import { AuthSession } from "@/lib/storage";

/** 點餐／收據應優先顯示 Ledger 商戶名，而非 POS bootstrap 內的示範店名。 */
export function resolveStoreDisplayTitle(
  authSession: AuthSession | null | undefined,
  bootstrap: PosBootstrap | null | undefined,
): string {
  const ledgerName = authSession?.name?.trim();
  if (ledgerName) return ledgerName;
  const bootstrapName = bootstrap?.storeName?.trim();
  if (bootstrapName) return bootstrapName;
  const account = authSession?.account?.trim();
  if (account) return account;
  return "門店";
}

export function resolveStoreDisplaySubtitle(
  authSession: AuthSession | null | undefined,
  terminalName?: string | null,
): string {
  const account = authSession?.account?.trim();
  if (account) return account;
  const terminal = terminalName?.trim();
  if (terminal) return terminal;
  return "";
}

export function applyLedgerMerchantToBootstrap(
  bootstrap: PosBootstrap,
  authSession: AuthSession | null | undefined,
): PosBootstrap {
  const ledgerName = authSession?.name?.trim();
  if (!ledgerName) return bootstrap;
  return {
    ...bootstrap,
    storeName: ledgerName,
    storeId: authSession?.merchantId ?? bootstrap.storeId,
  };
}
