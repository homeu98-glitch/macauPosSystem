"use client";

import { friendlyLedgerMemberError } from "@/lib/ledger/member-errors";
import { ensureLedgerSession } from "@/lib/ledger/session";

export type EnsureCustomerResult = {
  ok: true;
  customerId: string | null;
  balanceAvos: number | null;
  raw: Record<string, unknown>;
};

/**
 * 未註冊會員建檔／首充 — Ledger 契約 v3.2 §5.9。
 *
 * 重要：
 * - Ledger 嘅 `ensure-customer` HTTP **已上線**，唔使等新 RPC。
 * - browser **唔可以**直接打 Ledger；呢度只打 **POS 自己**嘅薄轉發
 *   `/api/ledger/ensure-customer`，由伺服器帶店員 Bearer token 轉發過去。
 * - 只應喺 `lookup` 回傳 `registered=false` 時先打；`registered=true` 請用
 *   `applyPosTopup`（`merchant_apply_pos_txn(p_type:"topup")`）。
 * - 建檔後 POS **唔幫設 PIN**；顧客自行到會員通 `/wallet/login` 設 4 位 PIN。
 */
export async function ensureCustomer(params: {
  merchantId: string;
  phone: string;
  displayName?: string;
  amountAvos?: number;
  idempotencyKey?: string;
}): Promise<EnsureCustomerResult> {
  // 🔴 2026-10-16（Ledger PR#40）：唔可以再直讀 storage 舊票（`getLedgerAccessToken`）——
  //    library 自動刷新／另一分頁刷新過之後，storage 可能仲係舊票 ⇒ 過期 401。
  //    行 `ensureLedgerSession()`：本地快取命中零成本，必要時先刷新先打。
  const token = await ensureLedgerSession();
  if (!token) {
    throw new Error("Ledger 登入已過期，請重新登入。");
  }

  const body: Record<string, unknown> = {
    merchantId: params.merchantId,
    phone: params.phone,
  };
  if (params.displayName) body.displayName = params.displayName;
  if (params.amountAvos !== undefined) body.amountAvos = params.amountAvos;
  if (params.idempotencyKey) body.idempotencyKey = params.idempotencyKey;

  let response: Response;
  try {
    response = await fetch("/api/ledger/ensure-customer", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("無法連線到 POS 伺服器，請檢查網絡後再試。");
  }

  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  if (!response.ok || parsed.ok === false) {
    const message =
      typeof parsed.error === "string" && parsed.error.trim()
        ? parsed.error
        : `建立會員失敗（HTTP ${response.status}）`;
    throw new Error(friendlyLedgerMemberError(message));
  }

  return {
    ok: true,
    customerId: parsed.customerId ? String(parsed.customerId) : null,
    balanceAvos:
      parsed.balanceAvos === undefined || parsed.balanceAvos === null
        ? null
        : Number(parsed.balanceAvos),
    raw: parsed,
  };
}
