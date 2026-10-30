"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkNativeAppUpdate,
  startNativeAppUpdate,
  type AppUpdateProgress,
  type AppUpdateCheckResult,
} from "@/lib/app-update";
import { useT } from "@/components/lang-provider";

/**
 * 設置 → 「版本」tab（2026-10-30，App OTA 1.2.3）。
 *
 * **只喺 Android 原生殼出現**（device-settings 嗰邊用 `isAndroidNativeShell()` 門口；
 * 呢個元件自己都會再 guard 一次——舊 APK 冇 `checkAppUpdate` 橋，行到嚟都係顯示「不支援」）。
 *
 * 內容：
 *   · 目前版本（APK `versionName` + `versionCode`）
 *   · 最新版本（admin「版本控制」設嘅 Android active 版本）
 *   · 「檢查更新」／「手動更新」——手動更新 = 下載 → 系統安裝器
 *
 * 為何經原生檢查而唔係 web 直接 fetch active API：APK 有 `BuildConfig.VERSION_NAME`
 * 做比對基準，web 呢邊冇（web 嘅版本號係 build metadata，唔係 app 版本）。
 */
export function AppVersionSection() {
  const t = useT();
  const [check, setCheck] = useState<AppUpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const [resultText, setResultText] = useState<string | null>(null);
  const alive = useRef(true);

  const runCheck = useCallback(() => {
    setChecking(true);
    setResultText(null);
    // `checkNativeAppUpdate()` 係同步（原生阻塞 8s 內返）；包 setTimeout 畀 UI 先畫到「檢查中…」。
    setTimeout(() => {
      const r = checkNativeAppUpdate();
      if (alive.current) {
        setCheck(r);
        setChecking(false);
      }
    }, 30);
  }, []);

  useEffect(() => {
    alive.current = true;
    runCheck();
    return () => {
      alive.current = false;
    };
  }, [runCheck]);

  async function handleUpdate() {
    if (!check || !check.ok || !check.downloadUrl || busy) return;
    setBusy(true);
    setProgress(null);
    setResultText(null);
    const r = await startNativeAppUpdate(check.downloadUrl, (p) => {
      if (alive.current) setProgress(p);
    });
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) {
      setResultText(
        t("已開啟安裝畫面，請喺彈出嘅安裝器按「安裝」。裝完 app 會重開，資料全部保留。"),
      );
    } else if (r.needsInstallPermission) {
      setResultText(
        t(
          "需要「允許安裝未知應用」權限：已幫你開咗系統設定，開啟後返回再按一次「手動更新」。",
        ),
      );
    } else {
      setResultText(`${t("更新失敗：")}${r.error}`);
    }
  }

  function fmtSize(bytes: number | null): string | null {
    if (bytes == null || bytes <= 0) return null;
    const mb = bytes / (1024 * 1024);
    return `${mb >= 1 ? mb.toFixed(1) : (bytes / 1024).toFixed(0)}${mb >= 1 ? " MB" : " KB"}`;
  }

  const updateAvailable = check?.ok === true && check.updateAvailable && !!check.downloadUrl;

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-base font-semibold text-slate-900">{t("版本")}</div>
      <div className="mt-1 text-sm text-slate-500">
        {t("檢查同更新呢部機上面安裝嘅 App。更新唔會影響任何資料。")}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
          <div className="text-xs font-semibold text-slate-500">{t("目前版本")}</div>
          <div className="mt-1 text-lg font-bold text-slate-900">
            {check?.ok ? (
              <>
                v{check.currentVersion}
                <span className="ml-2 text-xs font-normal text-slate-400">
                  (code {check.currentVersionCode})
                </span>
              </>
            ) : (
              "—"
            )}
          </div>
        </div>
        <div className="rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
          <div className="text-xs font-semibold text-slate-500">{t("最新版本")}</div>
          <div className="mt-1 text-lg font-bold text-slate-900">
            {check?.ok ? (check.latestVersion ? `v${check.latestVersion}` : t("未設定")) : "—"}
          </div>
          {check?.ok && check.fileSize ? (
            <div className="text-xs text-slate-400">
              {t("更新包大小")}：{fmtSize(check.fileSize)}
            </div>
          ) : null}
        </div>
      </div>

      {/* 狀態行 */}
      <div className="mt-3 text-sm">
        {checking ? (
          <span className="text-slate-500">{t("檢查中…")}</span>
        ) : !check ? (
          <span className="text-slate-500">{t("尚未檢查。")}</span>
        ) : !check.ok ? (
          <span className="text-amber-700">
            {t("檢查更新失敗：")}
            {check.error}
          </span>
        ) : updateAvailable ? (
          <span className="font-semibold text-sky-700">
            {check.latestVersion
              ? t("有新版本 v{latest} 可以更新（目前 v{current}）。", {
                  latest: check.latestVersion,
                  current: check.currentVersion,
                })
              : t("有新版本可以更新。")}
          </span>
        ) : (
          <span className="text-emerald-700">{t("已經係最新版本。")}</span>
        )}
      </div>

      {/* 掣 */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          className="min-h-[44px] rounded-full bg-white px-4 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 disabled:opacity-60"
          disabled={checking || busy}
          onClick={runCheck}
          type="button"
        >
          {t("重新檢查")}
        </button>
        <button
          className="min-h-[44px] rounded-full bg-orange-500 px-4 text-sm font-semibold text-white disabled:opacity-50"
          disabled={!updateAvailable || busy || checking}
          onClick={handleUpdate}
          type="button"
        >
          {busy
            ? progress
              ? t("下載中 {percent}%…", { percent: progress.percent })
              : t("準備中…")
            : t("手動更新")}
        </button>
      </div>
      {resultText ? (
        <div className="mt-3 rounded-xl bg-sky-50 px-4 py-3 text-sm font-semibold text-sky-900 ring-1 ring-sky-200">
          {resultText}
        </div>
      ) : null}
    </section>
  );
}
