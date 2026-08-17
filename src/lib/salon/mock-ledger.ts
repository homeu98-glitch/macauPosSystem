// Mock Ledger 會員資料層（read-only 餘額 / 積分 / 等級 + 本地扣款縫）
//
// 美容院會員的餘額、積分、等級由 Ledger 主導（決策 #6 / #11）。
// POS 端只讀取、不寫入這些欄位。此模組是對接縫：
// 真實 Ledger RPC（L1/L2/L3）到位後，只需把 getMockLedgerMember / applyMockLedgerPayment
// 改為呼叫 RPC，其餘 UI 不用動。
//
// mock 階段：會員資料已種入 SalonCustomerProfile.ledger* 欄位，這裡直接讀回；
// applyMockLedgerPayment 在本地扣減 ledgerBalance（僅模擬，真實環境由 Ledger 扣款）。

import { loadCustomers, saveCustomers } from "@/lib/salon/storage";
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

export interface ApplyLedgerPaymentResult {
  ok: boolean;
  remaining: number;
  error?: string;
}

/**
 * 扣減會員 Ledger 餘額（本地模擬）。
 * 真實環境應改為呼叫 Ledger RPC 扣款；此處只動 localStorage 的客戶檔案。
 * - identifier：電話或客戶 id
 * - amount：扣款金額（MOP），必須 > 0
 * 餘額不足時回傳 ok:false 且不修改資料，UI 應提示「Ledger 餘額不足」。
 */
export function applyMockLedgerPayment(
  identifier: string,
  amount: number,
): ApplyLedgerPaymentResult {
  if (typeof window === "undefined" || !identifier) {
    return { ok: false, remaining: 0, error: "無效參數" };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, remaining: 0, error: "扣款金額必須大於 0" };
  }

  const customers = loadCustomers();
  const idx = customers.findIndex(
    (x) => x.phone === identifier || x.id === identifier,
  );
  if (idx < 0) {
    return { ok: false, remaining: 0, error: "找不到 Ledger 會員" };
  }

  const c = customers[idx];
  const balance = c.ledgerBalance ?? 0;
  if (amount > balance) {
    return { ok: false, remaining: balance, error: "Ledger 餘額不足" };
  }

  const updated: SalonCustomerProfile = {
    ...c,
    ledgerBalance: balance - amount,
  };
  customers[idx] = updated;
  saveCustomers(customers);
  return { ok: true, remaining: balance - amount };
}

export interface ApplyLedgerBonusResult {
  ok: boolean;
  error?: string;
}

/**
 * 購買套票時贈送積分 / 儲值（本地模擬寫入 Ledger）。
 * 真實環境應改為呼叫 Ledger RPC；此處只動 localStorage 客戶檔案的 ledger* 欄位。
 * - identifier：電話或客戶 id
 * - points：贈送積分（加到 ledgerPoints）
 * - balance：贈送儲值（加到 ledgerBalance，MOP）
 * 兩者皆為 0 時視為 no-op 直接回傳 ok:true（不浪費寫入）。
 */
export function applyMockLedgerBonus(
  identifier: string,
  opts: { points?: number; balance?: number },
): ApplyLedgerBonusResult {
  if (typeof window === "undefined" || !identifier) {
    return { ok: false, error: "無效參數" };
  }
  const points = opts.points ?? 0;
  const balance = opts.balance ?? 0;
  if (points <= 0 && balance <= 0) {
    return { ok: true };
  }

  const customers = loadCustomers();
  const idx = customers.findIndex(
    (x) => x.phone === identifier || x.id === identifier,
  );
  if (idx < 0) {
    return { ok: false, error: "找不到 Ledger 會員" };
  }

  const c = customers[idx];
  const updated: SalonCustomerProfile = {
    ...c,
    ledgerPoints: (c.ledgerPoints ?? 0) + points,
    ledgerBalance: (c.ledgerBalance ?? 0) + balance,
  };
  customers[idx] = updated;
  saveCustomers(customers);
  return { ok: true };
}

export interface ApplyLedgerPointsPaymentResult {
  ok: boolean;
  remaining: number;
  error?: string;
}

/**
 * 兌換服務時扣減會員 Ledger 積分（本地模擬）。
 * 真實環境應改為呼叫 Ledger RPC 扣積分；此處只動 localStorage 客戶檔案的 ledgerPoints。
 * - identifier：電話或客戶 id
 * - points：扣減積分數，必須 > 0
 * 積分不足時回傳 ok:false 且不修改資料，UI 應提示「Ledger 積分不足」。
 * 支援「部分積分 + 現金」mix：本函式只負責扣 points，兌換比例换算由結帳頁決定。
 */
export function applyMockLedgerPointsPayment(
  identifier: string,
  points: number,
): ApplyLedgerPointsPaymentResult {
  if (typeof window === "undefined" || !identifier) {
    return { ok: false, remaining: 0, error: "無效參數" };
  }
  if (!Number.isFinite(points) || points <= 0) {
    return { ok: false, remaining: 0, error: "兌換積分必須大於 0" };
  }

  const customers = loadCustomers();
  const idx = customers.findIndex(
    (x) => x.phone === identifier || x.id === identifier,
  );
  if (idx < 0) {
    return { ok: false, remaining: 0, error: "找不到 Ledger 會員" };
  }

  const c = customers[idx];
  const cur = c.ledgerPoints ?? 0;
  if (points > cur) {
    return { ok: false, remaining: cur, error: "Ledger 積分不足" };
  }

  const updated: SalonCustomerProfile = {
    ...c,
    ledgerPoints: cur - points,
  };
  customers[idx] = updated;
  saveCustomers(customers);
  return { ok: true, remaining: cur - points };
}
