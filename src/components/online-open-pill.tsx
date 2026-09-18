"use client";

import { useEffect, useState } from "react";

import { MerchantOpenPill } from "@/components/merchant-open-pill";
import { ONLINE_RESIDUAL_HINT, onlineResidualState } from "@/lib/pos/residual-channel";
import { useMerchantOrderConfig } from "@/lib/pos/use-merchant-order-config";
import { useStoreStatus } from "@/lib/pos/use-store-status";
import { loadAuthSession } from "@/lib/storage";

/**
 * **「線上接單」pill** ＝ Ledger `merchant_enabled`（會員通線上落單總掣）。
 *
 * ── 命名統一（2026-09-15 J 拍板）────────────────────────────────────────
 * 同 `StoreOpenPill`（線下接單＝店內營業）成對：
 * - 線上接單 → 掣面寫「**接單中**」／「已暫停」（白底琥珀）
 * - 線下接單 → 掣面寫「**營業中**」／「已暫停」（紅底）
 *
 * 兩粒掣會並排出現（桌台總覽標題列、快餐訂單列），所以**措辭同配色一定要分得開** ——
 * 兩個都寫「營業中」＋ 同一個綠，收銀撳錯就係停業（2026-09-14 已提出過同一個問題）。
 *
 * ⚠️ 呢個係 `MerchantOpenPill` 嘅薄 wrapper，唔重複行為：
 * 關店二次確認、`null` ＝ 未接通（停用）、Ledger `unavailable` ＝ 收埋開關
 * 全部喺 `useMerchantOrderConfig()`。
 */

type OnlineOpenPillProps = {
  /** `xs`（預設）＝ 精簡版（約 104 × 40px）；`sm` / `md` 畀闊版面或既有 call site 用。 */
  size?: "xs" | "sm" | "md";
  variant?: "plain" | "contained";
  /** 預設「線上接單」。 */
  label?: string;
};

export function OnlineOpenPill({
  size = "xs",
  variant = "contained",
  label = "線上接單",
}: OnlineOpenPillProps) {
  const [storeId, setStoreId] = useState<string | null>(null);
  useEffect(() => {
    setStoreId(loadAuthSession()?.merchantId ?? null);
  }, []);

  const config = useMerchantOrderConfig(storeId, Boolean(storeId));

  /**
   * 殘留通道偵測（2026-09-18）：線上已暫停，但店內接單仍然開住 → 出警示點。
   *
   * 🔴 呢個方向**比線下嗰邊更易中招**：店主可能只係想「暫停接單」專心做堂食，
   *    但掃碼 / kiosk 照樣落得到單。冇呢粒點，佢會以為已經冇單入。
   *
   * ⚠️ 兩個 hook 都係 module singleton + 共用同一條 Realtime channel → 唔會多開連線。
   */
  const store = useStoreStatus(storeId, Boolean(storeId));
  const residual = onlineResidualState(store.isOpen, config.merchantEnabled) === "residual";

  if (!storeId) return null; // 冇登入記錄 → 唔顯示，避免商家以為設定咗

  const busyHint = config.loading
    ? "（讀取中…）"
    : config.saving === "merchant"
      ? "（切換中…）"
      : config.saving === "auto"
        ? "（儲存中…）"
        : undefined;

  return (
    <MerchantOpenPill
      busy={config.loading || config.saving !== "none"}
      busyHint={busyHint}
      disabled={!config.available}
      enabledLabel="接單中"
      error={config.saving === "none" ? config.error : null}
      label={label}
      merchantEnabled={config.merchantEnabled}
      offLabel="已暫停"
      onChange={(next) => void config.setMerchantEnabled(next)}
      residual={residual}
      residualHint={ONLINE_RESIDUAL_HINT}
      size={size}
      unknownHint="未讀到 Ledger 接單狀態，請去「設置 › 線上接單」重新整理。"
      variant={variant}
    />
  );
}
