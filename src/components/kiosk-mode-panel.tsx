"use client";

import { useEffect, useState } from "react";

import { loadKioskDeviceBinding, loadKioskMode, saveKioskMode } from "@/lib/kiosk-order";
import { loadAuthSession } from "@/lib/storage";

/**
 * 「自助點餐機模式」開關（商家側，喺 /settings「掃碼點餐」tab 頂部）。
 *
 * docs/87 §1：Kiosk 唔係另一個專案，而係**同一個 Vercel 網站嘅一種裝置模式**。
 * 開咗之後呢部機一開 `/` 就自動跳去 `/order`（客人自助點餐介面）。
 *
 * 點解唔使 rebuild APK / EXE：Android APK（`MainActivity.kt` 嘅 `DEFAULT_POS_URL`）
 * 同桌面 EXE 都係裝住 `https://macau-pos-system.vercel.app`，而 WebView / 瀏覽器
 * localStorage 係 persistent，所以一個純前端 flag 就夠（規格 1）。
 *
 * ⚠️ 呢個 flag **只寫本機、唔同步上 server**。絕對唔好改去 `pos_device_configs`——
 * 嗰個 GET 係 `.order(updated_at desc).limit(1)`，冇 store filter，
 * 會讀到全店最新一條（任何 terminal 嘅），同 `onlineOrderSettings.autoAccept`
 * 嗰個 bug 係同一類。
 */
export function KioskModePanel() {
  const [kioskMode, setKioskMode] = useState(false);
  // SSR / hydration 安全：localStorage 只能喺 mount 之後讀
  const [hydrated, setHydrated] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    setKioskMode(loadKioskMode());
    setHydrated(true);
    const bump = () => setTick((n) => n + 1);
    window.addEventListener("pos-kiosk-mode-changed", bump);
    return () => window.removeEventListener("pos-kiosk-mode-changed", bump);
  }, []);

  const binding = loadKioskDeviceBinding();
  const session = loadAuthSession();
  // 自助點餐機要用到 Ledger 會員扣款，必須有 staff session（見 login-screen 嘅改動）
  const hasStaffSession = Boolean(session?.merchantId);

  function toggle() {
    const next = !kioskMode;
    saveKioskMode(next);
    setKioskMode(next);
  }

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-1 text-base font-semibold text-slate-900">自助點餐機模式（Kiosk）</div>
      <p className="mb-4 text-sm text-slate-500">
        開啟後，<b>這部裝置</b>每次開啟都會直接進入客人自助點餐介面，唔會顯示收銀台。
        關閉後回復正常收銀。呢個設定只影響本機，唔會影響其他收銀機。
      </p>

      <div className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">
            {hydrated && kioskMode ? "已開啟：本機為自助點餐機" : "已關閉：本機為收銀台"}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {binding?.storeId
              ? `已綁定店鋪：${binding.storeName ?? binding.storeId}`
              : "尚未綁定店鋪（請先用「自助點餐」帳號登入一次）"}
          </div>
        </div>
        <button
          aria-pressed={kioskMode}
          className={`relative h-7 w-14 shrink-0 rounded-full transition-colors ${
            kioskMode ? "bg-orange-500" : "bg-slate-300"
          }`}
          disabled={!hydrated}
          onClick={toggle}
          type="button"
        >
          <span
            className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${
              kioskMode ? "left-8" : "left-1"
            }`}
          />
        </button>
      </div>

      {hydrated && kioskMode && (
        <div className="mt-3 space-y-2">
          <div className="rounded-xl bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-800">
            要退出自助點餐模式：喺自助點餐介面右上角按「設定」→「退出自助點餐模式（返回收銀台）」。
          </div>
          {!hasStaffSession && (
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
              ⚠️ 本機目前<b>冇職員登入記錄</b>。自助點餐機要做會員扣款，必須保留職員登入狀態；
              請用職員帳號（唔係 kiosk 綁店帳號）重新登入一次再開啟本模式。
            </div>
          )}
        </div>
      )}
    </section>
  );
}
