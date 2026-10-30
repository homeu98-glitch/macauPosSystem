"use client";

import { useEffect, useRef, useState } from "react";

import {
  checkNativeAppUpdate,
  startNativeAppUpdate,
  type AppUpdateProgress,
} from "@/lib/app-update";

/**
 * 「已略過」記喺 sessionStorage（唔係 localStorage）：見下面 §「為何用 sessionStorage」。
 */
const DISMISS_KEY = "macau-pos/app-update-dismissed";

/**
 * 收銀台「有新版本」橫幅（2026-10-30，App OTA 1.2.3）。
 *
 * ## 出現條件（全部要齊）
 *
 *   1. 跑喺 **Android 原生殼**（`isAndroidNativeShell()`：有 `checkAppUpdate` 嘅橋）
 *      —— 舊 APK 冇呢個方法，唔會出（正確：舊版也冇能力裝新包）；
 *   2. admin「版本控制」設咗比目前**新**嘅 Android active 版本；
 *   3. 呢次 app 開啟仲未撳過「暫時唔使」。
 *
 * ## 為何用 sessionStorage 記「已略過」（J 2026-10-30 定嘅規則）
 *
 * 「**每一次打開都要提示一次，關掉後就等下一次**」——
 * sessionStorage 啱啱好係呢個壽命：reload 唔清（同一個 app session 唔會再煩），
 * 但**殺 app 重開就清**（下次開機一定再提）。
 * localStorage 會令呢部機從此靜音（新版本冇人裝）⇒ 一定要 sessionStorage。
 *
 * ## 檢查時機
 *
 * mount 一次（每個 app session 一次，API 有 60s CDN 快取，egress 幾百 bytes）。
 * 離線／API 失敗一律靜默——橫幅係增強功能，唔可以影響收銀。
 */
export function AppUpdateBanner() {
  const [dismissed, setDismissed] = useState(true); // SSR／未確定前不出，避免 hydration mismatch
  const [info, setInfo] = useState<{
    currentVersion: string;
    latestVersion: string;
    downloadUrl: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const [resultText, setResultText] = useState<string | null>(null);
  /** 防止 unmount 後 setState。 */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    try {
      if (window.sessionStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      // sessionStorage 讀唔到 = 當未略過，照樣檢查
    }
    // 🔴 檢查到呢度 = 「呢次開啟未略過」——一定要亮返出嚟。
    //    （初值 true 係為咗 SSR／未確定前唔出，避免 hydration mismatch。）
    setDismissed(false);
    // 唔係 Android 原生殼（冇 checkAppUpdate 橋）就唔使做。
    const p = (window as unknown as { PosNative?: Record<string, unknown> }).PosNative;
    if (!p || typeof p.checkAppUpdate !== "function") return;

    const check = checkNativeAppUpdate();
    if (!check.ok || !check.updateAvailable || !check.latestVersion || !check.downloadUrl) return;
    setInfo({
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      downloadUrl: check.downloadUrl,
    });
    return () => {
      alive.current = false;
    };
  }, []);

  if (!info || dismissed) return null;

  function dismiss() {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore
    }
    setDismissed(true);
  }

  async function handleUpdate() {
    if (!info || busy) return;
    setBusy(true);
    setProgress(null);
    setResultText(null);
    const r = await startNativeAppUpdate(info.downloadUrl, (p) => {
      if (alive.current) setProgress(p);
    });
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) {
      setResultText("已開啟安裝畫面，請喺彈出嘅安裝器按「安裝」。");
    } else if (r.needsInstallPermission) {
      setResultText("已開啟系統設定：請開啟「允許安裝未知應用」，返回後再按一次「立即更新」。");
    } else {
      setResultText(`更新失敗：${r.error}`);
    }
  }

  return (
    <div className="shrink-0 border-b border-sky-300 bg-sky-50 px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-semibold text-sky-900">
          📱 有新版本 v{info.latestVersion}（而家 v{info.currentVersion}）
        </span>
        <span className="text-xs text-sky-900">更新唔會影響任何資料。</span>
        <span className="flex flex-wrap items-center gap-2">
          <button
            className="min-h-[40px] rounded-full bg-sky-600 px-4 text-sm font-semibold text-white disabled:opacity-60"
            disabled={busy}
            onClick={handleUpdate}
            type="button"
          >
            {busy
              ? progress
                ? `下載中 ${progress.percent}%`
                : "準備中…"
              : "立即更新"}
          </button>
          <button
            className="min-h-[40px] rounded-full bg-white px-4 text-sm font-semibold text-sky-900 ring-1 ring-sky-300"
            onClick={dismiss}
            type="button"
          >
            暫時唔使
          </button>
        </span>
        {resultText ? (
          <span className="w-full text-xs font-semibold text-sky-900">{resultText}</span>
        ) : null}
      </div>
    </div>
  );
}
