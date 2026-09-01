"use client";

import { AutoAcceptPill } from "@/components/auto-accept-pill";
import { QuickLocalOrdersStrip } from "@/components/quick-local-orders-strip";
import { QuickOnlineOrdersPanel } from "@/components/quick-online-orders-panel";
import { useSelfOrderAutoAccept } from "@/components/self-order-auto-accept-toggle";
import { PosOrder } from "@/lib/types";

type QuickModeOrdersBarProps = {
  currency: string;
  autoAcceptOnline: boolean;
  onAutoAcceptOnlineChange: (next: boolean) => void;
  onOnlineToast: (payload: { tone: "success" | "info" | "error"; message: string }) => void;
  preparingOrders: PosOrder[];
  waitingOrders: PosOrder[];
  completionLabel: (order: PosOrder) => string;
  completeLabel: (order: PosOrder) => string;
  onViewOrder: (orderId: string) => void;
  onMarkReady: (orderId: string) => void;
  onMarkCompleted: (orderId: string, label: string) => void;
  /** 自助單獨立結帳入口（kiosk / scan）：開啟付款 modal。 */
  onCheckout?: (orderId: string) => void;
};

/**
 * 快餐點餐介面 · 線下訂單嘅「自動接單」掣。
 *
 * 真源同訂單頁嗰粒一樣：DB `pos_kiosk_settings.selfOrderAutoAccept`（per-store 全店共用），
 * **唔係** localStorage —— 自助點餐機同收銀台係兩部機，必須有共同真源（docs/87 §4.3）。
 *
 * 2026-09-01 改：用 `variant="contained" size="md"`（同線上訂單嗰粒完全對稱顯眼），
 * 之後 plain sm 留俾其他 call site（如文件入面線下嘅 contained md = 顯眼）。
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
      size="md"
      variant="contained"
    />
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
}: QuickModeOrdersBarProps) {
  return (
    <div className="shrink-0 border-t border-slate-200 bg-white shadow-[0_-4px_20px_rgba(15,23,42,0.06)]">
      <div className="grid grid-cols-1 divide-y divide-slate-200 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <section className="min-w-0 px-3 py-2.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">線上訂單</div>
            <AutoAcceptPill
              enabled={autoAcceptOnline}
              label="自動接單"
              onChange={onAutoAcceptOnlineChange}
              size="md"
              variant="contained"
            />
          </div>
          <QuickOnlineOrdersPanel
            autoAccept={autoAcceptOnline}
            currency={currency}
            layout="strip"
            onToast={onOnlineToast}
            showAutoAcceptControls={false}
            skipTableAssignment
          />
        </section>
        <section className="min-w-0 px-3 py-2.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">線下訂單</div>
            <QuickSelfOrderAutoAcceptPill />
          </div>
          <QuickLocalOrdersStrip
            completeLabel={completeLabel}
            completionLabel={completionLabel}
            currency={currency}
            onCheckout={onCheckout}
            onMarkCompleted={onMarkCompleted}
            onMarkReady={onMarkReady}
            onViewOrder={onViewOrder}
            preparingOrders={preparingOrders}
            waitingOrders={waitingOrders}
          />
        </section>
      </div>
    </div>
  );
}
