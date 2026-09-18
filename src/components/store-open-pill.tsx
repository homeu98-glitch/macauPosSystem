"use client";

import { useEffect, useState } from "react";

import { MerchantOpenPill } from "@/components/merchant-open-pill";
import { STORE_RESIDUAL_HINT, storeResidualState } from "@/lib/pos/residual-channel";
import { CONFIRM_CLOSE_STORE_MESSAGE, useStoreOpenToggle } from "@/lib/pos/use-store-open-toggle";
import { useMerchantOrderConfig } from "@/lib/pos/use-merchant-order-config";
import { loadAuthSession } from "@/lib/storage";

/**
 * **「線下接單」pill** ＝ 店內營業總掣（POS DB `pos_store_status.is_open`，migration 0039）。
 *
 * ── 點解要有呢粒（2026-09-15 J 需求）────────────────────────────────────
 * 商家口徑要把兩個總掣成對命名：
 * - **線上接單**（`OnlineOpenPill`）＝ Ledger `merchant_enabled`，只擋會員通線上落單
 * - **線下接單**（本元件）＝ 店內營業，擋**掃碼點餐 ＋ 自助點餐機**（＋ 手動落單前嘅開工）
 *
 * 舊版「店內營業」只有一個入口：側欄商店名卡（`app-sidebar.tsx`，撳商店名切換）。
 * 收銀要喺桌台總覽／快餐訂單列就地開關，所以抽成 pill；**側欄入口保留**，
 * 兩邊共用 `useStoreOpenToggle()` 同一個 module store → 一邊撳另一邊即時跟住變。
 *
 * ── 行為全部喺 hook（唔喺呢度）──────────────────────────────────────────
 * 關店二次確認、關店**單向連動**暫停「線上接單」、重開唔會自動開返線上、失敗提示
 * —— 一律由 `useStoreOpenToggle()` 負責，呢個元件只負責畫掣。
 *
 * ── 🔴 配色規則（同側欄一致）────────────────────────────────────────────
 * - 營業中：`bg-emerald-600` 白字
 * - 已暫停：**紅底白字**（`offTone="red"`）—— 停業要一眼睇到，唔可以同「線上接單」嘅
 *   白底琥珀「已暫停」撞色（兩粒掣同時出現喺同一行）。
 * - 未讀到：灰底「未接通」＋ 停用（唔准猜）。
 */

type StoreOpenPillProps = {
  /**
   * `xs`（預設）＝ 精簡版（11px label / 12px 掣面，約 104 × 40px），
   * 桌台總覽標題列同快餐訂單列用；`md` 留返畀將來闊版面。
   */
  size?: "xs" | "sm" | "md";
  variant?: "plain" | "contained";
  /** 預設「線下接單」。 */
  label?: string;
};

export function StoreOpenPill({
  size = "xs",
  variant = "contained",
  label = "線下接單",
}: StoreOpenPillProps) {
  // client-only 讀法（同 `QuickOnlineOrderControls`／device-settings 一致，保 SSR/CSR 一致）
  const [storeId, setStoreId] = useState<string | null>(null);
  useEffect(() => {
    setStoreId(loadAuthSession()?.merchantId ?? null);
  }, []);

  const store = useStoreOpenToggle(storeId);

  /**
   * 殘留通道偵測（2026-09-18）：店內已關，但線上接單仍然開住 → 出警示點。
   *
   * ⚠️ 呢度要**額外掛** `useMerchantOrderConfig()` 先讀到線上狀態。
   *    兩個 hook 都係 module singleton + 共用同一條 Realtime channel
   *    （同 `useStoreOpenToggle` 內部已掛嘅係同一個 store），所以**唔會**多開連線。
   *    唔可以為咗「慳一個 hook」而唔顯示 —— 呢個警示正正係要修嘅缺口。
   */
  const merchant = useMerchantOrderConfig(storeId, Boolean(storeId));
  const residual = storeResidualState(store.isOpen, merchant.merchantEnabled) === "residual";

  if (!storeId) return null; // 冇登入記錄 → 唔顯示，避免商家以為設定咗

  const busyHint = store.loading
    ? "（讀取中…）"
    : store.saving
      ? "（切換中…）"
      : undefined;

  return (
    <MerchantOpenPill
      busy={store.loading || store.saving}
      busyHint={busyHint}
      confirmMessage={CONFIRM_CLOSE_STORE_MESSAGE}
      disabled={!store.canToggle}
      enabledLabel="營業中"
      error={store.error}
      label={label}
      merchantEnabled={store.isOpen}
      offLabel="已暫停"
      offTone="red"
      onChange={() => void store.toggle()}
      residual={residual}
      residualHint={STORE_RESIDUAL_HINT}
      size={size}
      unknownHint="未讀到店內營業狀態（可能係讀取失敗），請重新載入頁面"
      variant={variant}
    />
  );
}
