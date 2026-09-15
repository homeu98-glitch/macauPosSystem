"use client";

import { useEffect, useState } from "react";

import { MerchantOpenPill } from "@/components/merchant-open-pill";
import { useMerchantOrderConfig } from "@/lib/pos/use-merchant-order-config";
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
      size={size}
      unknownHint="未讀到 Ledger 接單狀態，請去「設置 › 線上接單」重新整理。"
      variant={variant}
    />
  );
}
