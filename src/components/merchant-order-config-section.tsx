"use client";

import { useEffect, useState } from "react";

import { AutoAcceptPill } from "@/components/auto-accept-pill";
import { MerchantOpenPill } from "@/components/merchant-open-pill";
import {
  describeOrderConfigBlockers,
  hasAnyOnlinePayment,
  type MerchantOrderConfig,
} from "@/lib/ledger/order-config-parse";
import { useMerchantOrderConfig } from "@/lib/pos/use-merchant-order-config";
import { loadAuthSession } from "@/lib/storage";

/**
 * 設備設定 · 線上接單（會員通）—— 開關店 + 自動接單。
 *
 * 真源：Ledger `merchants.merchant_enabled` / `auto_accept`（店員 JWT 直連 RPC，
 * 見 `src/lib/ledger/order-config.ts`）。POS DB 只做跨機 Realtime 鏡像。
 *
 * ⚠️ 三個唔可以踩嘅位：
 * 1. 開關店**只**改 `merchant_enabled`，絕對唔可以叫
 *    `merchant_update_order_config` / `merchant_update_order_basics`
 *    （嗰兩支整包覆寫，會靜靜剷走接單時段、盒費、折扣）。
 * 2. `admin_enabled=false` 或商家 `suspended` → 開到掣都收唔到會員通單，
 *    一定要喺呢度講清楚，唔好等收銀自己去猜（`describeOrderConfigBlockers`）。
 * 3. 關「開啟接單」時**唔會**順手寫 `auto_accept=false` —— 只係把嗰粒掣灰掉，
 *    開返店嗰陣原本嘅自動接單設定仍然在。
 */
export function MerchantOrderConfigSection() {
  // client-only：同 device-settings 其他 storeId 讀法一致（保 SSR/CSR 一致）
  const [storeId, setStoreId] = useState<string | null>(null);
  useEffect(() => {
    setStoreId(loadAuthSession()?.merchantId ?? null);
  }, []);

  const config = useMerchantOrderConfig(storeId, Boolean(storeId));

  // 只傳 composition-relevant 欄位（呢支純函式要嘅係 MerchantOrderConfig）
  const snapshot: MerchantOrderConfig = {
    merchantEnabled: config.merchantEnabled,
    autoAccept: config.autoAccept,
    adminEnabled: config.adminEnabled,
    openNow: config.openNow,
    hoursEnabled: config.hoursEnabled,
    allowBalanceDeduct: config.allowBalanceDeduct,
    allowPayInStore: config.allowPayInStore,
    status: config.status,
  };

  const blockers = describeOrderConfigBlockers(snapshot);
  const anyOnlinePayment = hasAnyOnlinePayment(snapshot);

  const busy = config.loading || config.saving !== "none";
  const busyHint = config.loading
    ? "（讀取中…）"
    : config.saving === "merchant"
      ? "（切換中…）"
      : config.saving === "auto"
        ? "（儲存中…）"
        : undefined;

  const rows: Array<{ label: string; value: string; tone: "warn" | "ok" | "muted" }> = [
    {
      label: "平台核可",
      value:
        config.adminEnabled === null
          ? "未讀到"
          : config.adminEnabled
            ? "已核可"
            : "未核可（要搵平台）",
      tone: config.adminEnabled === false ? "warn" : config.adminEnabled ? "ok" : "muted",
    },
    {
      label: "商家狀態",
      value: config.status ?? "未讀到",
      tone: config.status && config.status !== "active" ? "warn" : config.status ? "ok" : "muted",
    },
    {
      label: "接單時段",
      value:
        config.hoursEnabled === null
          ? "未讀到"
          : config.hoursEnabled === false
            ? "全天接單（未設時段）"
            : config.openNow
              ? "時段內（營業中）"
              : "時段外（休息中）",
      tone: config.hoursEnabled === true && config.openNow === false ? "warn" : "muted",
    },
    {
      label: "線上付款方式",
      value:
        anyOnlinePayment === null
          ? "未讀到"
          : anyOnlinePayment
            ? [
                config.allowBalanceDeduct ? "餘額扣點" : null,
                config.allowPayInStore ? "到店付款" : null,
              ]
                .filter(Boolean)
                .join("、")
            : "兩種都關住（開唔到店）",
      tone: anyOnlinePayment === false ? "warn" : "muted",
    },
  ];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-slate-900">線上訂單（會員通）</div>
          <div className="mt-1 max-w-[52ch] text-sm text-slate-500">
            呢粒「接單」係全店線上單嘅總掣：關咗之後客人喺會員通落唔到新單。
            店內堂食、快餐、自助點餐完全不受影響。改動會即時同步到其他收銀機。
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MerchantOpenPill
            busy={busy}
            busyHint={busyHint}
            disabled={!config.available || !storeId}
            error={config.saving === "none" ? config.error : null}
            merchantEnabled={config.merchantEnabled}
            onChange={(next) => void config.setMerchantEnabled(next)}
            unknownHint={
              storeId ? "未讀到 Ledger 接單狀態，請撳「重新整理」。" : "尚未登入，無法讀取接單狀態。"
            }
            variant="contained"
          />
          <AutoAcceptPill
            busy={busy}
            busyHint={busyHint}
            disabled={!config.available || config.merchantEnabled !== true}
            enabled={config.autoAccept}
            label="自動接單"
            onChange={(next) => void config.setAutoAccept(next)}
            variant="contained"
          />
          <button
            className="rounded-full bg-white px-4 py-2 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-60"
            disabled={!storeId || config.loading}
            onClick={() => void config.refresh()}
            type="button"
          >
            {config.loading ? "讀取中…" : "重新整理"}
          </button>
        </div>
      </div>

      {!config.available ? (
        <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          Ledger 接單介面未接通（RPC 未上線，或目前帳號未登入 Ledger）。
          下面顯示嘅係本機最後同步嘅狀態，暫時無法由 POS 開關。
        </div>
      ) : null}

      {config.crossTerminalSync === "on-enter" ? (
        <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
          跨機即時同步未生效：POS 即時連線指向嘅資料庫冇 POS 表（多數係未設
          NEXT_PUBLIC_POS_SUPABASE_URL / _ANON_KEY，或者設完未重新部署）。
          改完之後，其他收銀機會喺入頁或返前景時才更新 —— 呢個唔影響本機嘅開關。
        </div>
      ) : null}

      {config.merchantEnabled === false ? (
        <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          「自動接單」已一併停用：店都關咗，自動接單寫住開都唔會接到單。
          開返店之後原本嘅自動接單設定仍然保留。
        </div>
      ) : null}

      {blockers.length > 0 ? (
        <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="text-xs font-semibold text-red-700">
            而家會員通接唔到單，原因（{blockers.length}）：
          </div>
          <ul className="mt-1.5 grid gap-1">
            {blockers.map((blocker) => (
              <li className="text-xs text-red-700" key={blocker.label}>
                · {blocker.label}
                {blocker.fixableByStaff ? "" : "（要搵平台／店主處理）"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3" key={row.label}>
            <div className="text-[11px] font-medium text-slate-500">{row.label}</div>
            <div
              className={`mt-0.5 text-sm font-semibold ${
                row.tone === "warn"
                  ? "text-amber-700"
                  : row.tone === "ok"
                    ? "text-emerald-700"
                    : "text-slate-700"
              }`}
            >
              {row.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 text-xs leading-relaxed text-slate-500">
        開關店只改「開啟接單」一欄，唔會碰接單時段、盒費、折扣、付款方式。
        自動接單同理，係獨立一欄。兩者都由 Ledger 做真源，POS 只係鏡像 ＋ 廣播。
      </div>
    </section>
  );
}

/**
 * 設置頁 **header** 嘅「線上訂單」狀態 toggle —— 放喺「返回收銀台」左邊。
 *
 * ── 點解要放 header ────────────────────────────────────────────────────
 * 收銀最常問嘅係「而家客人落唔落到單？」。以前呢個答案要撳入 tab 或者返收銀台
 * 嘅訂單頁先睇得到。放 header 之後，一入設置頁就見到，而且**就地可以開返店**
 * （唔使再撳入去）。
 *
 * 同 `MerchantOrderConfigSection` 共用同一個 module store（`useMerchantOrderConfig`）
 * → 兩邊即時一致、唔會開多一條 Realtime channel、唔會一個顯示營業中另一個顯示已暫停。
 *
 * 撳落去嘅行為同其他 call site 完全一樣（`MerchantOpenPill` 內部）：關店要二次確認。
 */
export function MerchantOrderHeaderToggle() {
  // client-only：同 device-settings 其他 storeId 讀法一致（保 SSR/CSR 一致）
  const [storeId, setStoreId] = useState<string | null>(null);
  useEffect(() => {
    setStoreId(loadAuthSession()?.merchantId ?? null);
  }, []);

  const config = useMerchantOrderConfig(storeId, Boolean(storeId));

  return (
    <MerchantOpenPill
      busy={config.loading || config.saving !== "none"}
      busyHint={
        config.loading
          ? "（讀取中…）"
          : config.saving === "merchant"
            ? "（切換中…）"
            : config.saving === "auto"
              ? "（儲存中…）"
              : undefined
      }
      disabled={!config.available || !storeId}
      error={config.saving === "none" ? config.error : null}
      label="線上訂單"
      merchantEnabled={config.merchantEnabled}
      onChange={(next) => void config.setMerchantEnabled(next)}
      unknownHint={
        storeId ? "未讀到 Ledger 接單狀態，請撳入「線上訂單」分頁重新整理。" : "尚未登入，無法讀取接單狀態。"
      }
      variant="contained"
    />
  );
}
