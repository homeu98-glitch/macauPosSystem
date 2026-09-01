import "server-only";

/**
 * POS → Ledger：「線上訂單自動接單」出站同步（docs/92 §4）。
 *
 * 背景：POS 同 Ledger 各有一粒「自動接單」掣，舊 code 完全冇對接（docs/92 §1）。
 * 呢度係 **POS 嗰半邊**：收銀機改完寫入 `pos_online_order_settings` 之後，
 * 由 server 帶店員 Bearer token 推去 Ledger。
 *
 * 設計重點：
 * 1. **server-only**：browser 唔可以直接打 Ledger（同 ensure-customer 嘅約定一致，契約 §5.9），
 *    店員 token 亦唔可以落去 client。
 * 2. **fire-and-forget**：Ledger 失敗**唔好** rollback POS 嘅改動 ——
 *    收銀掣要即刻有反應（樂觀更新），Ledger 遲啲收斂。caller 只係記 log。
 * 3. **防迴圈**：只推 `updated_source === "pos"` 嘅改動；
 *    Ledger 推過嚟嘅（`source="ledger"`）**唔好**再推返去（docs/92 §5）。
 */

const DEFAULT_LEDGER_BASE = "https://membership-uat.macau-tech.com";

function ledgerBaseUrl(): string {
  const raw = process.env.LEDGER_INTEGRATION_BASE_URL?.trim();
  return (raw || DEFAULT_LEDGER_BASE).replace(/\/+$/, "");
}

export type PushAutoAcceptResult = {
  ok: boolean;
  /** 冇 token / 冇配 base URL → 根本冇 call 出去（唔算失敗，但係要 log）。 */
  skipped?: "no-token" | "loop-guard";
  status?: number;
  error?: string;
};

/**
 * 推「自動接單」狀態去 Ledger。永遠唔 throw（caller 用唔著 try/catch）。
 *
 * @param storeId   商家 UUID（`loadAuthSession()?.merchantId`）
 * @param autoAccept 開關值
 * @param token     店員 Ledger access token（`Authorization: Bearer`）
 * @param source    改動來源；`"ledger"` 會直接 skip（防迴圈）
 */
export async function pushAutoAcceptToLedger(
  storeId: string,
  autoAccept: boolean,
  token: string | null | undefined,
  source: "pos" | "ledger" = "pos",
): Promise<PushAutoAcceptResult> {
  if (source === "ledger") {
    // 呢個改動本身就係 Ledger 推過嚟嘅，唔好再推返去 → 否則兩邊無限 ping-pong
    return { ok: true, skipped: "loop-guard" };
  }

  if (!storeId) return { ok: false, error: "missing storeId" };
  if (!token) return { ok: false, skipped: "no-token", error: "missing ledger access token" };

  const url = `${ledgerBaseUrl()}/api/integration/pos/auto-accept`;
  const updatedAt = new Date().toISOString();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ storeId, autoAccept, updatedAt }),
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: `Ledger auto-accept 失敗（HTTP ${response.status}）${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }

    return { ok: true, status: response.status };
  } catch (err) {
    return {
      ok: false,
      error: `無法連線到 Ledger：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
