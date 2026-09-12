"use client";

import { useMerchantOrderConfig } from "@/lib/pos/use-merchant-order-config";

/**
 * 「自動接單」設定 —— **相容層**（2026-09-12）。
 *
 * 原本呢個檔自己養一份 module store（server = POS DB `pos_online_order_settings`，
 * 再經 HTTP 推去 Ledger，見 docs/92）。而家 Ledger 開放咗店員 JWT 直連 RPC
 * `merchant_set_auto_accept`，而**開關店**（`merchant_enabled`）又係同一個 config、
 * 同一次讀取就會拿到 —— 兩個掣拆兩個 store 會出現「讀兩次 RPC、兩邊 loading 唔同步、
 * 開關店關咗但自動接單掣唔知要灰」。
 *
 * 所以真身搬去 `use-merchant-order-config.ts`（一份 state，兩個掣 + 全部 config 欄位），
 * 呢度只保留舊 API（`autoAccept` / `loading` / `error` / `source` / `setAutoAccept`），
 * 令 `online-orders.tsx`、`pos-app.tsx` 唔使改。
 *
 * ⚠️ 對外語意已經變咗：`autoAccept` 嘅真源**唔再係** POS DB，而係 Ledger
 * `merchants.auto_accept`。POS DB 降級做跨機 Realtime 鏡像。
 * ⚠️ `setAutoAccept` 而家會**等 RPC 回覆**（唔再係 fire-and-forget），
 * 真拒絕會 rollback 並回傳 `false`。
 */

export type AutoAcceptSource = "cache" | "server" | "realtime";

export type OnlineOrderSettingsState = {
  autoAccept: boolean;
  loading: boolean;
  error: string | null;
  source: AutoAcceptSource | null;
};

export function useOnlineOrderSettings(storeId: string | null, enabled = true) {
  const config = useMerchantOrderConfig(storeId, enabled);

  return {
    autoAccept: config.autoAccept,
    loading: config.loading,
    error: config.error,
    source: config.source,
    setAutoAccept: config.setAutoAccept,
  };
}
