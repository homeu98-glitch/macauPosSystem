"use client";

import { useEffect, useState } from "react";

import { AutoAcceptPill } from "@/components/auto-accept-pill";
import { OnlineOpenPill } from "@/components/online-open-pill";
import { StoreOpenPill } from "@/components/store-open-pill";
import { QuickLocalOrdersStrip } from "@/components/quick-local-orders-strip";
import { QuickOnlineOrdersPanel } from "@/components/quick-online-orders-panel";
import { useSelfOrderAutoAccept } from "@/components/self-order-auto-accept-toggle";
import { useMerchantOrderConfig } from "@/lib/pos/use-merchant-order-config";
import type { ToastPayload } from "@/lib/pos/accept-outcome";
import { loadAuthSession } from "@/lib/storage";
import { PosOrder } from "@/lib/types";

type QuickModeOrdersBarProps = {
  currency: string;
  autoAcceptOnline: boolean;
  onAutoAcceptOnlineChange: (next: boolean) => void;
  /**
   * 線上單 toast（`warning` 由 2026-09-14 加入：自動接單「未出廚房單」要見到。
   * ⚠️ 外面 `pos-app` 唔可以再把它降級成 info，見該處註釋）。
   */
  onOnlineToast: (payload: ToastPayload) => void;
  preparingOrders: PosOrder[];
  waitingOrders: PosOrder[];
  completionLabel: (order: PosOrder) => string;
  completeLabel: (order: PosOrder) => string;
  onViewOrder: (orderId: string) => void;
  onMarkReady: (orderId: string) => void;
  onMarkCompleted: (orderId: string, label: string) => void;
  /** 自助單獨立結帳入口（kiosk / scan）：開啟付款 modal。 */
  onCheckout?: (orderId: string) => void;
  /** 撳「掃碼新單」提示之後要閃一下嘅訂單（2026-09-11：留在點餐頁面顯示）。 */
  noticeFocus?: { orderId: string; seq: number } | null;
  /** draft 自助單（自動接單關掉）→ 卡片上嘅人手「接受 / 拒絕」。 */
  onConfirmSelfOrder?: (order: PosOrder) => { ok: boolean; error?: string };
  onRejectSelfOrder?: (order: PosOrder) => { ok: boolean; error?: string };
};

/**
 * 快餐點餐介面 · 線下訂單嘅「自動接單」掣。
 *
 * 真源同訂單頁嗰粒一樣：DB `pos_kiosk_settings.selfOrderAutoAccept`（per-store 全店共用），
 * **唔係** localStorage —— 自助點餐機同收銀台係兩部機，必須有共同真源（docs/87 §4.3）。
 *
 * 2026-09-15 改：`variant="contained" size="xs"` —— 同隔籬「線下接單」精簡 pill
 * 同一尺寸（約 80 × 40px），兩粒並排睇落先齊。
 */
function QuickSelfOrderAutoAcceptPill() {
  const { enabled, loading, saving, error, storeId, setEnabled } = useSelfOrderAutoAccept();

  if (!storeId) return null; // 冇登入記錄 → 唔顯示，避免商家以為設定咗

  return (
    <AutoAcceptPill
      busy={loading || saving}
      busyHint={loading ? "（讀取中…）" : saving ? "（儲存中…）" : undefined}
      enabled={enabled}
      error={error}
      label="自動接單"
      onChange={setEnabled}
      size="xs"
      variant="contained"
    />
  );
}

/**
 * 快餐點餐介面 · 線上訂單嘅兩粒掣：「線上接單（開關店）」＋「自動接單」。
 *
 * 兩粒都要同一個 module store（`useMerchantOrderConfig`）嘅值：
 * 店關咗就要把「自動接單」灰掉，所以唔可以拆做兩個元件各自讀。
 * 同訂單頁／設備設定亦係同一個 store → 三邊即時一致，唔會開多幾條 Realtime channel。
 *
 * 2026-09-15 改名：「接單」→「**線上接單**」，掣面由「營業中」改「**接單中**」。
 * 原因：同一行（甚至同一屏）會出現「線下接單」（店內營業），兩粒都寫「營業中」＋同一個綠
 * 就會撳錯（撳錯＝停業）。詳見 `online-open-pill.tsx` 註釋。
 *
 * ⚠️ 關店關嘅係**成間舖嘅線上單**（唔止快餐），所以一定要二次確認（喺 pill 內部做）。
 */
function QuickOnlineOrderControls({
  autoAccept,
  onAutoAcceptChange,
}: {
  autoAccept: boolean;
  onAutoAcceptChange: (next: boolean) => void;
}) {
  const [storeId, setStoreId] = useState<string | null>(null);
  useEffect(() => {
    setStoreId(loadAuthSession()?.merchantId ?? null);
  }, []);

  const config = useMerchantOrderConfig(storeId, Boolean(storeId));

  if (!storeId) return null; // 冇登入記錄 → 唔顯示，避免商家以為設定咗

  const busy = config.loading || config.saving !== "none";
  const busyHint = config.loading
    ? "（讀取中…）"
    : config.saving === "merchant"
      ? "（切換中…）"
      : config.saving === "auto"
        ? "（儲存中…）"
        : undefined;

  return (
    <>
      {/* 線上接單（Ledger `merchant_enabled`）—— 掣面「接單中／已暫停」 */}
      <OnlineOpenPill size="xs" />
      <AutoAcceptPill
        busy={busy}
        busyHint={busyHint}
        disabled={config.merchantEnabled !== true}
        enabled={autoAccept}
        label="自動接單"
        onChange={onAutoAcceptChange}
        size="xs"
        variant="contained"
      />
    </>
  );
}

export function QuickModeOrdersBar({
  currency,
  autoAcceptOnline,
  onAutoAcceptOnlineChange,
  onOnlineToast,
  preparingOrders,
  waitingOrders,
  completionLabel,
  completeLabel,
  onViewOrder,
  onMarkReady,
  onMarkCompleted,
  onCheckout,
  noticeFocus,
  onConfirmSelfOrder,
  onRejectSelfOrder,
}: QuickModeOrdersBarProps) {
  return (
    <div className="shrink-0 border-t border-slate-200 bg-white shadow-[0_-4px_20px_rgba(15,23,42,0.06)]">
      <div className="grid grid-cols-1 divide-y divide-slate-200 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <section className="min-w-0 px-3 py-2.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">線上訂單</div>
            <QuickOnlineOrderControls
              autoAccept={autoAcceptOnline}
              onAutoAcceptChange={onAutoAcceptOnlineChange}
            />
          </div>
          <QuickOnlineOrdersPanel
            autoAccept={autoAcceptOnline}
            currency={currency}
            layout="strip"
            onToast={onOnlineToast}
            quickCounter
            showAutoAcceptControls={false}
            skipTableAssignment
          />
        </section>
        <section className="min-w-0 px-3 py-2.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">線下訂單</div>
            <div className="flex shrink-0 flex-nowrap items-center gap-2">
              {/* 線下接單 = 店內營業總掣（`pos_store_status.is_open`）：
                  擋掃碼點餐 ＋ 自助點餐機。掣面「營業中」／「已暫停（紅）」。
                  同左邊「線上訂單」嗰組完全對稱（接單總掣喺左、自動接單喺右）。 */}
              <StoreOpenPill size="xs" />
              <QuickSelfOrderAutoAcceptPill />
            </div>
          </div>
          <QuickLocalOrdersStrip
            completeLabel={completeLabel}
            completionLabel={completionLabel}
            currency={currency}
            noticeFocus={noticeFocus}
            onCheckout={onCheckout}
            onConfirmSelfOrder={onConfirmSelfOrder}
            onMarkCompleted={onMarkCompleted}
            onMarkReady={onMarkReady}
            onRejectSelfOrder={onRejectSelfOrder}
            onViewOrder={onViewOrder}
            preparingOrders={preparingOrders}
            waitingOrders={waitingOrders}
          />
        </section>
      </div>
    </div>
  );
}
