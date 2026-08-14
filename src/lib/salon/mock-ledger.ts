// Mock Ledger 會員資料層（read-only 餘額 / 積分 / 等級）
//
// 美容院會員的餘額、積分、等級由 Ledger 主導（決策 #6 / #11）。
// POS 端只讀取、不寫入這些欄位。此模組是對接縫：
// 真實 Ledger RPC（L1/L2/L3）到位後，只需把 getMockLedgerMember 改為呼叫 RPC，
// 其餘 UI 不用動。
//
// mock 階段：會員資料已種入 SalonCustomerProfile.ledger* 欄位，這裡直接讀回。

import { loadCustomers } from "@/lib/salon/storage";
import type { SalonCustomerProfile } from "@/lib/salon/types";

export interface MockLedgerMember {
  ledgerBalance: number;
  ledgerPoints: number;
  ledgerTier: string;
}

/**
 * 依電話或客戶 id 取 Ledger 會員資料（read-only）。
 * 找不到時回傳 null —— UI 應顯示「尚無 Ledger 會員資料」。
 */
export function getMockLedgerMember(identifier: string): MockLedgerMember | null {
  if (typeof window === "undefined" || !identifier) return null;

  const customers = loadCustomers();
  const c: SalonCustomerProfile | undefined = customers.find(
    (x) => x.phone === identifier || x.id === identifier,
  );
  if (!c) return null;

  return {
    ledgerBalance: c.ledgerBalance ?? 0,
    ledgerPoints: c.ledgerPoints ?? 0,
    ledgerTier: c.ledgerTier ?? "普通會員",
  };
}
