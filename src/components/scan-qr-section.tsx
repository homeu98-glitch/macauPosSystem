"use client";

import { useEffect, useState } from "react";

import { KioskQrPanel } from "@/components/kiosk-qr-panel";
import { useT } from "@/components/lang-provider";
import { QuickScanQrPanel } from "@/components/quick-scan-qr-panel";
import { loadKioskDeviceBinding } from "@/lib/kiosk-order";
import {
  DEFAULT_SCAN_MODE,
  fetchKioskSettings,
  normalizeScanMode,
  type ScanMode,
} from "@/lib/pos/kiosk-settings";
import { loadAuthSession } from "@/lib/storage";

/**
 * 設置頁「掃碼點餐」tab 嘅 QR 區（docs/115）。
 *
 * ## 只負責「揀邊個 QR 面板」，冇模式選擇器
 *
 * 掃碼模式**唔可以由呢一頁改** —— 真源只有一個：**登入工作台**
 * （`login-screen.tsx` 成功後用 `scanModeForLoginMode()` 寫店級 `scan_mode`）。
 *
 * | 登入模式 | 店級 `scan_mode` | 呢度顯示 |
 * |---|---|---|
 * | 堂食 `dinein` | `dine_in` | `KioskQrPanel`（每枱一碼） |
 * | 快餐 `quick` | `quick` | `QuickScanQrPanel`（全店一碼） |
 * | 自助點餐機 `kiosk` / 美容 `salon` | **不變** | 跟當時店級值 |
 *
 * ⚠️ 2026-10-20 嘅教訓：舊 `ScanModePanel` 係「模式卡 ＋ QR 面板」綁在同一個組件，
 *    為咗刪走重複真源嘅模式卡而整個檔刪走，結果連唯一嘅 QR 出口都冇咗（商家印唔返貼紙）。
 *    ⇒ 所以今次刻意**分開兩件事**：模式顯示縮成一行字（唔可以喺度改），QR 輸出係主角。
 *
 * ## 顯示口徑
 *
 * 讀**店級** `pos_kiosk_settings.scan_mode`（唔讀本機登入狀態）：一間店可以有多部機，
 * QR 貼紙係全店共用嘅實物，唔應該跟住某一部機嘅登入狀態走。
 * 離線 / 讀取失敗 fallback `dine_in`（向後兼容；當 `quick` 會令枱碼靜靜失效）。
 */

/** 由 kiosk 綁店 / auth session 取所屬店。 */
function useQrStoreId(): string {
  const [storeId, setStoreId] = useState("");
  useEffect(() => {
    // kiosk 綁店優先：`mode=kiosk` 登入只 save 綁店、唔 save auth session。
    const binding = loadKioskDeviceBinding();
    const session = loadAuthSession();
    setStoreId(binding?.storeId ?? session?.merchantId ?? "");
  }, []);
  return storeId;
}

export function ScanQrSection() {
  const t = useT();
  const storeId = useQrStoreId();
  const [scanMode, setScanMode] = useState<ScanMode>(DEFAULT_SCAN_MODE);
  const [loading, setLoading] = useState(true);

  // mount 讀一次（專案禁 polling；用對應模式重新登入之後，重入呢頁就會讀到最新）。
  useEffect(() => {
    let cancelled = false;
    if (!storeId) {
      setLoading(false);
      return;
    }
    void fetchKioskSettings(storeId).then((settings) => {
      if (cancelled) return;
      setScanMode(normalizeScanMode(settings.scanMode));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  if (loading) {
    return <div className="px-1 text-sm text-slate-400">{t("讀取中…")}</div>;
  }

  if (!storeId) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
        {t("未取得店鋪編號，請先以商戶帳號登入 / 綁店。")}
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-3">
      {/* 模式只做「一眼睇到目前生效邊種」，唔提供選擇器（改模式＝用另一種模式重新登入）。 */}
      <div className="flex flex-wrap items-center gap-2 px-1">
        <span className="text-xs text-slate-500">{t("掃碼點餐模式")}</span>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            scanMode === "quick" ? "bg-orange-100 text-orange-700" : "bg-sky-100 text-sky-700"
          }`}
        >
          {scanMode === "quick" ? t("快餐 · 全店一個碼") : t("堂食 · 每枱一個碼")}
        </span>
        <span className="text-xs text-slate-400">{t("模式跟登入工作台走，要改請用對應模式重新登入。")}</span>
      </div>

      {/* ⚠️ 只 render 目前生效嘅一種 QR：快餐店唔應該見到枱碼，堂食店亦唔會見到快餐碼。 */}
      {scanMode === "quick" ? <QuickScanQrPanel storeId={storeId} /> : <KioskQrPanel storeId={storeId} />}
    </div>
  );
}
