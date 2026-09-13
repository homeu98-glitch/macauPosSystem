import "server-only";

import { scanDebitTimestamp, signScanDebitBody } from "@/lib/ledger/scan-debit-crypto";

/**
 * v3.5 掃碼自助扣餘額 client（**POS 伺服器 only**）。
 *
 * 權威：[`docs/integration/pos-v3.5-partner-handover-scan-debit.md`](../../../docs/integration/pos-v3.5-partner-handover-scan-debit.md)
 *
 * 流程：`quote`（報價，~180s 有效）→ 客人確認（PIN，登入未滿 3 分鐘可免）→ `commit`（真正扣款）。
 *
 * 🔴 五條唔可以錯嘅：
 *   1. **只可以由 server 打** —— 交接文檔明文「禁瀏覽器直打 Ledger」。呢個檔有 `server-only`。
 *   2. **`amountAvos` 必須由 POS 自己核價** —— Ledger **完全唔核價**（Q3「上限：無」）,
 *      POS 係唯一防線。所以 caller 一定要由自己 DB 讀訂單總額，**唔可以**信 client 傳上嚟嘅數。
 *   3. **簽原始 body 字串** —— 呢度 `JSON.stringify` 一次之後就攞住嗰個字串去簽，
 *      再原樣送出去；**唔可以**改完 object 再 serialize 第二次。
 *   4. **重試必須重用同一 `quoteId` / `quoteSig` / `posOrderId`** —— 同 `posOrderId` 重試
 *      Ledger 會回**同一** `txnId`（唔會雙扣）。**唔可以**改金額重 quote 同一 `posOrderId`。
 *   5. **冇 lookup API**（Q6）→ commit 失敗之後「查唔到」**唔等於**「未扣款」。
 *      只可以靠同一冪等鍵重試去逼出同一 `txnId`；仍然唔確定就紅標交人。
 */

/** 預設 timeout：Ledger 係同步記帳，5 秒已經好鬆。 */
const REQUEST_TIMEOUT_MS = 8000;

export type ScanDebitConfig = { baseUrl: string; secret: string };

/**
 * 讀 scan-debit 設定。
 *
 * ⚠️ `LEDGER_INTEGRATION_BASE_URL` 一定要**明確設定**，唔做 fallback 去 UAT 網域 ——
 *    正式環境靜默連去 UAT 會令客人真錢扣落測試店（同 `AUTH_PIN_PEPPER` 混用係同一類事故）。
 */
export function resolveScanDebitConfig(): ScanDebitConfig | null {
  const baseUrl = process.env.LEDGER_INTEGRATION_BASE_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.POS_SCAN_DEBIT_SECRET?.trim();
  if (!baseUrl || !secret) return null;
  return { baseUrl, secret };
}

export type ScanDebitFailureCode =
  | "not_configured"
  | "store_not_live"
  | "insufficient_balance"
  | "rate_limited"
  | "amount_conflict"
  | "unauthorized"
  | "quote_invalid"
  | "upstream";

/** 帶機器可讀 `code` 嘅錯誤 —— route 層直接映射 HTTP 碼，唔使 parse message。 */
export class ScanDebitError extends Error {
  readonly code: ScanDebitFailureCode;
  readonly httpStatus: number;

  constructor(code: ScanDebitFailureCode, message: string, httpStatus = 502) {
    super(message);
    this.name = "ScanDebitError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Ledger 回嘅 `code` → 我哋嘅分類。未知 code 一律當 upstream（保守）。 */
function classifyLedgerCode(code: string | undefined, httpStatus: number): ScanDebitFailureCode {
  switch (code) {
    case "store_not_live":
      return "store_not_live";
    case "insufficient_balance":
      return "insufficient_balance";
    case "rate_limited":
      return "rate_limited";
    case "amount_conflict":
    case "amount_mismatch":
      return "amount_conflict";
    case "quote_expired":
    case "quote_invalid":
    case "invalid_quote":
      return "quote_invalid";
    default:
      break;
  }
  if (httpStatus === 401 || httpStatus === 403) return "unauthorized";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus === 409) return "amount_conflict";
  return "upstream";
}

type LedgerEnvelope = {
  code?: string;
  message?: string;
  error?: string;
  [key: string]: unknown;
};

/**
 * 打一次 Ledger scan-debit endpoint（quote / commit 共用）。
 *
 * @returns 回應 JSON（已驗過 HTTP 狀態）。
 * @throws ScanDebitError
 */
async function callScanDebit(
  path: "/api/integration/pos/scan-debit/quote" | "/api/integration/pos/scan-debit/commit",
  body: Record<string, unknown>,
  customerAccessToken: string,
): Promise<LedgerEnvelope> {
  const config = resolveScanDebitConfig();
  if (!config) {
    throw new ScanDebitError(
      "not_configured",
      "掃碼扣款服務尚未設定（缺 LEDGER_INTEGRATION_BASE_URL 或 POS_SCAN_DEBIT_SECRET）。",
      503,
    );
  }
  if (!customerAccessToken.trim()) {
    throw new ScanDebitError("unauthorized", "缺少顧客授權，請重新登入。", 401);
  }

  // 🔴 只 serialize 一次，之後嗰個字串就係「原始 body」——簽名同送出用同一個。
  const rawBody = JSON.stringify(body);
  const timestamp = scanDebitTimestamp();
  const signature = signScanDebitBody(timestamp, rawBody, config.secret);

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pos-Timestamp": timestamp,
        "X-Pos-Signature": signature,
        // 顧客 JWT：Ledger 據此知「扣邊個客人嘅錢」。
        Authorization: `Bearer ${customerAccessToken}`,
      },
      body: rawBody,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // 網絡 / timeout：**結果未知**（唔可以當「未扣款」—— Q6 冇 lookup API）。
    throw new ScanDebitError(
      "upstream",
      err instanceof Error && err.name === "TimeoutError"
        ? "連線 Ledger 逾時，結果未知。"
        : "無法連線 Ledger，結果未知。",
      504,
    );
  }

  let payload: LedgerEnvelope = {};
  try {
    payload = (await response.json()) as LedgerEnvelope;
  } catch {
    // 非 JSON（例如 502 HTML）→ 當 upstream；唔好當成功。
  }

  if (!response.ok) {
    const ledgerCode = typeof payload.code === "string" ? payload.code : undefined;
    const classified = classifyLedgerCode(ledgerCode, response.status);
    const message =
      typeof payload.message === "string" && payload.message.trim()
        ? payload.message
        : typeof payload.error === "string" && payload.error.trim()
          ? payload.error
          : `Ledger 回應 ${response.status}`;
    throw new ScanDebitError(classified, message, response.status);
  }

  return payload;
}

export type ScanDebitQuote = {
  quoteId: string;
  /** 過期時間（ISO 字串或毫秒數，原樣帶返前端做倒數）。 */
  expiresAt: string | number | null;
  quoteSig: string;
  idempotencyKey: string | null;
};

/**
 * 報價。**唔會**扣錢，亦唔會佔用冪等鍵（Q4）。
 *
 * @param amountAvos ⚠️ **必須**由 POS 自己由 DB 讀訂單之後算 —— 唔可以信 client。
 */
export async function quoteScanDebit(params: {
  merchantId: string;
  posOrderId: string;
  amountAvos: number;
  customerAccessToken: string;
}): Promise<ScanDebitQuote> {
  const payload = await callScanDebit(
    "/api/integration/pos/scan-debit/quote",
    {
      merchantId: params.merchantId,
      posOrderId: params.posOrderId,
      amountAvos: params.amountAvos,
    },
    params.customerAccessToken,
  );

  const quoteId = typeof payload.quoteId === "string" ? payload.quoteId : "";
  const quoteSig = typeof payload.quoteSig === "string" ? payload.quoteSig : "";
  if (!quoteId || !quoteSig) {
    // 200 但冇 quote → 唔可以當成功（否則之後 commit 必失敗，而客人以為已經扣咗）。
    throw new ScanDebitError("upstream", "Ledger 未回有效報價。", 502);
  }

  return {
    quoteId,
    quoteSig,
    expiresAt:
      typeof payload.expiresAt === "string" || typeof payload.expiresAt === "number"
        ? payload.expiresAt
        : null,
    idempotencyKey: typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : null,
  };
}

export type ScanDebitCommit = {
  txnId: string;
  /** 扣款後餘額（avos）。 */
  balanceAfterAvos: number;
  /** 該筆賺取嘅積分（avos）—— POS **只顯示**，唔自己加減（Q11）。 */
  pointsEarnedAvos: number;
};

/** 真正扣款。同 `posOrderId` 重試會回**同一** `txnId`。 */
export async function commitScanDebit(params: {
  quoteId: string;
  quoteSig: string;
  customerAccessToken: string;
}): Promise<ScanDebitCommit> {
  const payload = await callScanDebit(
    "/api/integration/pos/scan-debit/commit",
    { quoteId: params.quoteId, quoteSig: params.quoteSig },
    params.customerAccessToken,
  );

  const txnId = typeof payload.txnId === "string" ? payload.txnId : "";
  if (!txnId) {
    // ⚠️ 200 但冇 txnId：**唔可以**當成功，亦**唔可以**當失敗 —— 交返 route 做「結果未知」。
    throw new ScanDebitError("upstream", "Ledger 未回交易編號，結果未知。", 502);
  }

  return {
    txnId,
    balanceAfterAvos: Number(payload.balanceAfter ?? 0),
    pointsEarnedAvos: Number(payload.pointsEarned ?? 0),
  };
}
