"use client";

import { useEffect, useMemo, useState } from "react";

import { KioskQrPanel, QrSvg } from "@/components/kiosk-qr-panel";
import { loadAuthSession } from "@/lib/storage";
import { loadKioskDeviceBinding } from "@/lib/kiosk-order";
import {
  DEFAULT_SCAN_MODE,
  fetchKioskSettings,
  normalizeScanMode,
  type ScanMode,
} from "@/lib/pos/kiosk-settings";
import { openQrPrintWindow } from "@/lib/pos/qr-print";

/**
 * 設定頁「掃碼點餐」面板（docs/115）。
 *
 * ## ⚠️ 呢個面板係**唯讀**（2026-09-10 改）
 *
 * 掃碼模式**唔再由呢一頁揀** —— 佢跟**登入模式**走：
 *
 * | 登入模式 | 店級 `scan_mode` | 顯示 |
 * |---|---|---|
 * | 快餐 `quick` | `quick` | 全店一個碼（`QuickScanQrPanel`） |
 * | 堂食 `dinein` | `dine_in` | 每張桌台一個碼（`KioskQrPanel`） |
 * | 自助點餐機 `kiosk` | **不變** | 唔關事 |
 * | 美容 `salon` | **不變** | 唔關事 |
 *
 * 寫入點**只有一個**：`login-screen.tsx` 登入成功之後（`scanModeForLoginMode()`）。
 * 呢度**唔可以**再加選擇器，否則就有兩個真源 → 「登入揀快餐、設定揀堂食」
 * 出嚟嘅碼同商家預期唔同，而且兩邊改完互相覆蓋。
 *
 * 要改模式 → 用對應模式**重新登入**（UI 文案已寫明）。
 *
 * ## 顯示口徑
 *
 * 顯示仍然讀**店級真源** `pos_kiosk_settings.scan_mode`（唔係讀登入模式）：
 * 一間店可以有多部機，QR 貼紙係全店共用嘅實物，唔應該跟住某一部機嘅登入狀態走。
 * 離線 / 讀取失敗 fallback `dine_in`（向後兼容；當 `quick` 會令枱碼靜靜失效）。
 */

/** 由 kiosk 綁店 / auth session 取所屬店（同 `KioskQrPanel` 同一口徑）。 */
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

/** 全店單一快餐 QR（貼櫃檯／快餐區）。 */
function QuickScanQrPanel({ storeId }: { storeId: string }) {
  const [host, setHost] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  const url = useMemo(() => {
    if (!storeId) return "";
    const origin =
      host || (typeof window !== "undefined" ? window.location.origin : "https://macau-pos-system.vercel.app");
    return `${origin}/quick?store=${encodeURIComponent(storeId)}`;
  }, [host, storeId]);

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-1 text-base font-semibold text-slate-900">快餐掃碼 QR（全店一個）</div>
      <p className="mb-4 text-sm text-slate-500">
        快餐模式全店只用一個碼，客人掃碼後直接落單、每張單獨立（同自助點餐機快餐流程一致）。
        印出貼喺櫃檯／快餐區。
      </p>

      <label className="mb-1 block text-xs text-slate-500">網址主機（host）</label>
      <input
        value={host}
        onChange={(e) => setHost(e.target.value)}
        placeholder={typeof window !== "undefined" ? window.location.origin : ""}
        className="mb-6 w-full rounded-lg border border-slate-200 p-2 text-sm"
      />

      {hint ? (
        <div className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800" role="status">
          {hint}
        </div>
      ) : null}

      {!storeId ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-400">
          未取得店鋪編號，請先以商戶帳號登入 / 綁店。
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white p-6">
          <QrSvg text={url} size={220} />
          <div className="break-all text-center text-[11px] text-slate-400">{url}</div>
          <div className="grid w-full max-w-xs grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(url);
                setHint("已複製快餐點餐網址。");
              }}
              className="rounded-lg bg-slate-100 py-2 text-xs font-semibold text-slate-700"
            >
              複製網址
            </button>
            <button
              type="button"
              onClick={() => {
                const ok = openQrPrintWindow({
                  title: "掃碼點餐",
                  subtitle: "快餐",
                  footer: "掃碼點餐 · 點完請到櫃檯付款",
                  url,
                  size: 400,
                });
                if (!ok) setHint("無法開啟列印視窗，請允許彈出視窗或改用「複製網址」。");
              }}
              className="rounded-lg bg-orange-500 py-2 text-xs font-semibold text-white"
            >
              列印
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function ScanModePanel() {
  const storeId = useQrStoreId();
  const [scanMode, setScanMode] = useState<ScanMode>(DEFAULT_SCAN_MODE);
  const [loading, setLoading] = useState(true);

  // mount 讀一次（禁 polling；用對應模式重新登入之後，呢頁重入就會讀到最新）。
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

  return (
    <div className="grid min-w-0 gap-4">
      <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-base font-semibold text-slate-900">掃碼點餐模式</div>
          {loading ? null : (
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                scanMode === "quick" ? "bg-orange-100 text-orange-700" : "bg-sky-100 text-sky-700"
              }`}
            >
              {scanMode === "quick" ? "快餐 · 全店一個碼" : "堂食 · 每枱一個碼"}
            </span>
          )}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          呢個模式<b>跟登入模式自動設定</b>，唔需要喺呢一頁揀：
          <b> 用「快餐」登入 = 全店一個碼</b>；<b>用「堂食」登入 = 每張桌台一個碼</b>。
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          要更改模式，請<b>登出後用另一種模式重新登入</b>（登入畫面已經可以揀）。
          下方只會顯示目前生效嘅 QR；另一邊嘅碼唔會再出現，避免印錯貼紙。
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          如果呢度顯示嘅模式同你登入嗰陣揀嘅唔一致（例如登入時離線、設定未能上傳），
          請重新登入一次對應模式。
        </p>

        {loading ? (
          <div className="mt-3 text-sm text-slate-400">讀取中…</div>
        ) : !storeId ? (
          <div className="mt-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-400">
            未取得店鋪編號，請先以商戶帳號登入 / 綁店。
          </div>
        ) : null}
      </section>

      {/*
        ⚠️ 只顯示當前模式嘅 QR（用戶明確要求）：
        快餐模式唔應該再出現桌台碼（否則客人掃到會落一張「綁枱」單，但鋪頭冇開枱）；
        堂食模式亦唔會顯示快餐碼。
        ⚠️ 冇 storeId 時唔 render QR 面板 —— 兩個面板各自有「未取得店鋪編號」提示，
        一齊出會變重複訊息（上面已經有）。
      */}
      {loading || !storeId ? null : scanMode === "quick" ? (
        <QuickScanQrPanel storeId={storeId} />
      ) : (
        <KioskQrPanel />
      )}
    </div>
  );
}
