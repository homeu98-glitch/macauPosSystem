"use client";

/**
 * Ledger 商家接單設定 RPC 層 —— **開關店（開啟／關閉接單）** 同自動接單。
 *
 * ── 呢支同其他 RPC 唔同嘅地方 ────────────────────────────────────────────
 * 1. **一定要店員 Ledger session**（收銀台／Kiosk 綁機帳號）。RPC 內部守衛係
 *    `is_merchant_staff`，掃碼客人嘅顧客 JWT 會 `not authorized`。
 * 2. **只改一欄**。`merchant_set_order_enabled` 只寫 `merchant_enabled` + `updated_at`，
 *    唔會碰接單時段／付款方式／盒費。所以**唔可以**為咗切一粒掣去叫
 *    `merchant_update_order_config` / `merchant_update_order_basics` —— 嗰兩支係整包覆寫，
 *    會靜靜剷走時段、盒費、折扣。
 * 3. **回傳即係最新狀態**。三支都回傳完整 order config，撳完直接用回傳更新 UI，
 *    **唔使**再打一次 GET（全專案禁 polling）。
 *
 * 授權同錯誤碼見 `docs/integration/ledger-client-api.md`（v3.4 為止呢兩支仍未入白名單，
 * 但 DB 已 `GRANT EXECUTE` 畀 `authenticated`，店員 JWT 打得到）。
 */

import { mapRpcErrorMessage } from "@/lib/ledger/order-actions";
import {
  isRpcMissingError,
  parseMerchantOrderConfig,
  type MerchantOrderConfig,
} from "@/lib/ledger/order-config-parse";
import { ensureLedgerSession } from "@/lib/ledger/session";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

/** 由 `order-config-parse` 轉出，等 call site 唔使記兩個路徑。 */
export type { MerchantOrderConfig };

export type MerchantOrderConfigResult =
  | { ok: true; config: MerchantOrderConfig }
  | {
      ok: false;
      /**
       * - `unavailable`：Ledger 未提供呢支 RPC（migration 未上／前端接錯 Supabase 專案）
       *   → UI 應該收埋個開關，而唔係顯示一粒撳完零反應嘅掣
       * - `unauthorized`：冇店員 session（或顧客 JWT）→ 提示重新登入
       * - `error`：業務／網絡錯誤（文案已由 `mapRpcErrorMessage` 轉做繁中）
       */
      code: "unavailable" | "unauthorized" | "error";
      message: string;
    };

async function callConfigRpc(
  fn: string,
  args: Record<string, unknown>,
): Promise<MerchantOrderConfigResult> {
  const accessToken = await ensureLedgerSession();
  if (!accessToken) {
    return { ok: false, code: "unauthorized", message: "Ledger 登入已過期，請重新登入。" };
  }

  const client = getLedgerSupabaseClient();
  if (!client) {
    return { ok: false, code: "unavailable", message: "Ledger Supabase 尚未設定。" };
  }

  const { data, error } = await client.rpc(fn, args);

  if (error) {
    // 先分「RPC 根本唔存在」同「RPC 存在但拒絕」——前者唔應該當業務錯誤彈紅色。
    if (isRpcMissingError(error.message)) {
      return {
        ok: false,
        code: "unavailable",
        message: `Ledger 未提供接單設定介面（${fn} 未上線）。`,
      };
    }
    if (error.message.toLowerCase().includes("not authorized")) {
      return { ok: false, code: "unauthorized", message: "此帳號無權限開關接單，請用店員帳號登入。" };
    }
    return { ok: false, code: "error", message: mapRpcErrorMessage(error.message) };
  }

  return { ok: true, config: parseMerchantOrderConfig(data) };
}

/**
 * 讀現況（進設定頁／訂單頁時打**一次**，唔好 polling）。
 *
 * `p_merchant_id` = 店員 session 嘅 `merchantId`（同 POS `store_id` 同一套 id）。
 */
export async function getMerchantOrderConfig(merchantId: string): Promise<MerchantOrderConfigResult> {
  if (!merchantId) {
    return { ok: false, code: "unauthorized", message: "尚未登入 Ledger 或缺少 merchantId。" };
  }
  return callConfigRpc("get_merchant_order_config", { p_merchant_id: merchantId });
}

/**
 * 開店／關店 —— **只**改 `merchant_enabled`。
 *
 * ⚠️ 關落去之後，會員通即刻唔可以落新單（`create_order` 會擋，
 * 就算 `auto_accept` 仍然係 true 都唔會自動接）。
 *
 * 已知失敗：兩種線上付款（餘額扣點／到店付款）都關住 →
 * `at least one payment method required`。
 */
export async function setMerchantOrderEnabled(
  merchantId: string,
  merchantEnabled: boolean,
): Promise<MerchantOrderConfigResult> {
  if (!merchantId) {
    return { ok: false, code: "unauthorized", message: "尚未登入 Ledger 或缺少 merchantId。" };
  }
  return callConfigRpc("merchant_set_order_enabled", {
    p_merchant_id: merchantId,
    p_merchant_enabled: merchantEnabled,
  });
}

/** 自動接單（**唔係**開關店）。同樣只改一欄、回傳整份 config。 */
export async function setMerchantAutoAccept(
  merchantId: string,
  autoAccept: boolean,
): Promise<MerchantOrderConfigResult> {
  if (!merchantId) {
    return { ok: false, code: "unauthorized", message: "尚未登入 Ledger 或缺少 merchantId。" };
  }
  return callConfigRpc("merchant_set_auto_accept", {
    p_merchant_id: merchantId,
    p_auto_accept: autoAccept,
  });
}
