"use client";

// App 內「檢查更新」面板（Electron 桌面 App 先有用）。
//
// 運作方式：
//   - 桌面 App 經 preload 暴露 window.companionShell（checkUpdate / downloadUpdate /
//     quitAndInstall / onUpdateStatus / getVersion）。
//   - 呢個面板喺普通瀏覽器（Vercel）會自動隱藏（companionShell 唔存在）；網頁更新照推 Vercel，唔使理。
//   - 喺 Electron 內：顯示版本 → 撳「檢查更新」→ 有更新就顯示「下載」→ 下載中顯示進度條
//     → 落完顯示「安裝並重啟」→ quitAndInstall() 覆蓋安裝 + 重啟。
//
// 重點：更新只重打包「Electron 殼 + 內嵌 companion」；網頁本身永遠由 Vercel 最新版提供（熱更新，唔使重打包）。

import { useEffect, useState } from "react";

type UpdateInfo = {
  version?: string;
  releaseNotes?: string;
  releaseDate?: string;
};

type UpdateState = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "latest" | "error";
  info: string;
  updateInfo?: UpdateInfo | null;
  progress?: number;
};

const LABEL: Record<UpdateState["status"], string> = {
  idle: "就緒",
  checking: "檢查中…",
  available: "有更新可用",
  downloading: "下載中…",
  downloaded: "已下載，可安裝",
  latest: "已是最新版本",
  error: "更新失敗",
};

const DOT_CLASS: Record<UpdateState["status"], string> = {
  idle: "bg-slate-400",
  checking: "bg-amber-400",
  available: "bg-amber-400",
  downloading: "bg-amber-400",
  downloaded: "bg-emerald-500",
  latest: "bg-emerald-500",
  error: "bg-red-500",
};

export function AppUpdatePanel() {
  // 非 Electron（無 companionShell）直接唔顯示
  if (typeof window === "undefined" || !(window as any).companionShell) return null;

  const [version, setVersion] = useState<string>("…");
  const [state, setState] = useState<UpdateState>({ status: "idle", info: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const shell = (window as any).companionShell;
    if (shell?.getVersion) shell.getVersion().then((v: string) => setVersion(v || "…")).catch(() => {});
    if (shell?.onUpdateStatus) shell.onUpdateStatus((s: UpdateState) => setState(s));
  }, []);

  const onCheck = async () => {
    setBusy(true);
    try {
      const shell = (window as any).companionShell;
      const s = await shell.checkUpdate();
      if (s) setState(s);
    } catch {
      /* ignore */
    } finally {
      setTimeout(() => setBusy(false), 1200);
    }
  };

  const onDownload = () => {
    const shell = (window as any).companionShell;
    if (shell?.downloadUpdate) shell.downloadUpdate();
  };

  const onInstall = () => {
    const shell = (window as any).companionShell;
    if (shell?.quitAndInstall) shell.quitAndInstall();
  };

  const newVer = state.updateInfo?.version;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <div className="font-semibold text-slate-900">桌面 App 更新</div>
      <p className="mt-1 text-xs text-slate-500">
        網頁更新會自動由雲端生效，唔使喺度處理；呢度只更新桌面殼（含打印代理）。
      </p>

      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className={`h-2.5 w-2.5 rounded-full ${DOT_CLASS[state.status]}`} />
        <span>版本 {version}</span>
        {newVer && state.status !== "latest" && (
          <>
            <span className="text-slate-400">→</span>
            <span className="font-medium text-indigo-600">v{newVer}</span>
          </>
        )}
        <span className="text-slate-400">·</span>
        <span>{state.info || LABEL[state.status]}</span>
      </div>

      {/* 下載進度條 */}
      {state.status === "downloading" && (
        <div className="mt-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-amber-400 transition-all"
              style={{ width: `${state.progress ?? 0}%` }}
            />
          </div>
          <div className="mt-1 text-right text-xs text-slate-400">{state.progress ?? 0}%</div>
        </div>
      )}

      {/* 更新內容（release notes） */}
      {state.updateInfo?.releaseNotes && (state.status === "available" || state.status === "downloading") && (
        <div className="mt-3 max-h-28 overflow-y-auto rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
          {String(state.updateInfo.releaseNotes)}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onCheck}
          className="rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? "檢查中…" : "檢查更新"}
        </button>

        {state.status === "available" && (
          <button
            type="button"
            onClick={onDownload}
            className="rounded-full bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600"
          >
            下載更新
          </button>
        )}

        {state.status === "downloaded" && (
          <button
            type="button"
            onClick={onInstall}
            className="rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            安裝並重啟
          </button>
        )}

        {state.status === "error" && (
          <button
            type="button"
            onClick={onCheck}
            className="rounded-full bg-slate-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-600"
          >
            重試
          </button>
        )}
      </div>
    </div>
  );
}
