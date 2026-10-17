"use client";

import { useEffect, useState } from "react";

import { AutoAcceptPill } from "@/components/auto-accept-pill";
import { useT } from "@/components/lang-provider";
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
  /**
   * 返結單（2026-10-17 J 要求）：本地快餐 counter 單返結後要停留喺線下訂單列
   * （以前 strip 完全唔收 `reopened`，張單會消失，冇入口改價／重結）。
   * 純線上單維持排除（錢同狀態喺 Ledger）—— 父層負責過濾。
   */
  reopenedOrders: PosOrder[];
  completionLabel: (order: PosOrder) => string;
  completeLabel: (order: PosOrder) => string;
  onViewOrder: (orderId: string) => void;
  /** 返結卡嘅「編輯」：將張單載入點餐工作台（改價／加餐後重結）。 */
  onEditOrder?: (orderId: string) => void;
  onMarkReady: (orderId: string) => void;
  onMarkCompleted: (orderId: string, label: string) => void;
  /** 自助單獨立結帳入口（kiosk / scan）：開啟付款 modal。 */
  onCheckout?: (orderId: string) => void;
  /** 撳「掃碼新單」提示之後要閃一下嘅訂單（2026-09-11：留在點餐頁面顯示）。 */
  noticeFocus?: { orderId: string; seq: number } | null;
  /** draft 自助單（自動接單關掉）→ 卡片上嘅人手「接受 / 拒絕」。 */
  onConfirmSelfOrder?: (order: PosOrder) => { ok: boolean; error?: string };
  onRejectSelfOrder?: (order: PosOrder) => { ok: boolean; error?: string };
  /** 外賣平台單「作廢（覆寫）」—— 規則見 `@/lib/pos/platform-order`。 */
  onVoidPlatformOrder?: (order: PosOrder) => void;
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

  // ⚠️ AutoAcceptPill 內部會 t(label) / t(busyHint)：以下 prop 一定要傳原文
  //    （＝字典 key），唔可以自己先包一層 t()（會變雙重翻譯）。
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
  reopenedOrders,
  completionLabel,
  completeLabel,
  onViewOrder,
  onEditOrder,
  onMarkReady,
  onMarkCompleted,
  onCheckout,
  noticeFocus,
  onConfirmSelfOrder,
  onRejectSelfOrder,
  onVoidPlatformOrder,
}: QuickModeOrdersBarProps) {
  const t = useT();

  return (
    <div className="shrink-0 border-t border-slate-200 bg-white shadow-[0_-4px_20px_rgba(15,23,42,0.06)]">
      {/*
        * 🔴 2026-10-14 小平板適配：呢條 bar 唔設高度上限，單欄時兩個 section 直叠
        * 實測 400px 高 —— 喺 1000×600 嘅小平板（lg 觸發唔到）會食埋成個屏 2/3，
        * 淨返 200px 畀點餐區。⇒ 分欄門檻由 lg(1024) 提早到 900px：
        * 900–1023 已經夠闊左右並排（每邊 ~450px，同 iPad 504px 相若）；
        * ≥1024 由原本嘅 lg 數值接手（已包含喺 min-[900px]，行為不變）。
        */}
      <div className="grid grid-cols-1 divide-y divide-slate-200 compact:grid-cols-2 compact:divide-x compact:divide-y-0 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <section className="min-w-0 px-3 py-2.5 compact:px-2 compact:py-1.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 compact:mb-1 compact:gap-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 compact:text-[10.5px] compact:tracking-normal">{t("線上訂單")}</div>
            {/* qp = 「quick pill」錨點：globals.css 喺 900–1023px 用 descendant selector
                收窄呢兩粒接單掣 —— 文字**保留**（J 2026-10-14 拍板：唔可以淨係 icon），
                只係縮細同將「label／開關」由兩行改成同一行。詳見 `qp-compact` 段。 */}
            <div className="qp flex shrink-0 flex-nowrap items-center gap-1">
              <QuickOnlineOrderControls
                autoAccept={autoAcceptOnline}
                onAutoAcceptChange={onAutoAcceptOnlineChange}
              />
            </div>
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
        <section className="min-w-0 px-3 py-2.5 compact:px-2 compact:py-1.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 compact:mb-1 compact:gap-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 compact:text-[10.5px] compact:tracking-normal">{t("線下訂單")}</div>
            <div className="qp flex shrink-0 flex-nowrap items-center gap-2 compact:gap-1">
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
            onEditOrder={onEditOrder}
            onMarkCompleted={onMarkCompleted}
            onMarkReady={onMarkReady}
            onRejectSelfOrder={onRejectSelfOrder}
            onViewOrder={onViewOrder}
            onVoidPlatformOrder={onVoidPlatformOrder}
            preparingOrders={preparingOrders}
            reopenedOrders={reopenedOrders}
            waitingOrders={waitingOrders}
          />
        </section>
      </div>
    </div>
  );
}
