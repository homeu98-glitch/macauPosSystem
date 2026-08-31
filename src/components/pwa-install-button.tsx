"use client";

import { useEffect, useState } from "react";

type DeferredPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

declare global {
  interface Window {
    __pwaDeferredPrompt?: DeferredPrompt | null;
    // Android 原生 APK WebView 注入（print-bridge/native.ts 同款標記）
    PosNative?: { printJob?: unknown } | undefined;
    // PC 桌面 Electron 殼經 preload 注入（app-update-panel.tsx 同款標記）
    companionShell?: unknown;
  }
}

/**
 * 判斷當前網頁係咪已經跑喺我哋嘅原生殼入面（Android APK WebView / PC Electron）。
 * 呢兩個係原生殼主動注入嘅 bridge 標記，比 userAgent sniff 可靠，亦係 codebase 現有慣例
 * （PosNative → print-bridge/native.ts、companionShell → app-update-panel.tsx）。
 * 喺原生殼入面 PWA 安裝根本冇意義（已經係 installed app），所以整個安裝入口要隱藏。
 */
export function isRunningInNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const hasPosNative = Boolean((window as unknown as { PosNative?: { printJob?: unknown } }).PosNative?.printJob);
  const hasCompanionShell = Boolean((window as unknown as { companionShell?: unknown }).companionShell);
  return hasPosNative || hasCompanionShell;
}

export function PwaInstallButton() {
  const [isStandalone, setIsStandalone] = useState(() => {
    if (typeof window === "undefined") return false;
    return (
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone)
    );
  });
  const [isIosLike] = useState(() => {
    if (typeof window === "undefined") return false;
    return (
      /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
      (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1)
    );
  });
  const [available, setAvailable] = useState(
    () => typeof window !== "undefined" && Boolean(window.__pwaDeferredPrompt),
  );
  const [installing, setInstalling] = useState(false);
  const [showManualHelp, setShowManualHelp] = useState(false);

  useEffect(() => {
    function onAvailable(event: Event) {
      const detail = (event as CustomEvent<{ available?: boolean }>).detail;
      setAvailable(Boolean(detail?.available));
    }

    function onInstalled() {
      setAvailable(false);
      setIsStandalone(true);
      setShowManualHelp(false);
    }

    window.addEventListener("pwa-install-available", onAvailable as EventListener);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("pwa-install-available", onAvailable as EventListener);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (isStandalone) return null;

  // 原生殼（Android APK / PC Electron）入面 PWA 安裝冇意義，整個入口隱藏
  if (isRunningInNativeShell()) return null;

  return (
    <div className="mt-3 rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-left text-sm text-white/85">
      <div className="font-semibold text-white">PWA 安裝</div>
      <button
        className="mt-3 w-full rounded-2xl border border-white/20 bg-white/10 px-4 py-3 text-sm font-semibold text-white hover:bg-white/15 disabled:opacity-60"
        disabled={installing}
        onClick={() => {
          if (available) {
            const prompt = window.__pwaDeferredPrompt;
            if (!prompt) return;
            void (async () => {
              setInstalling(true);
              await prompt.prompt();
              await prompt.userChoice;
              window.__pwaDeferredPrompt = null;
              setAvailable(false);
              setInstalling(false);
            })();
            return;
          }
          setShowManualHelp((current) => !current);
        }}
        type="button"
      >
        {installing ? "安裝中…" : available ? "安裝到主頁" : "下載 / 加入主畫面"}
      </button>
      {isIosLike ? (
        <>
          <div className="mt-1 text-white/70">iPad / iPhone 的 Safari 不會顯示自動安裝按鈕，請用手動加入主畫面。</div>
          {showManualHelp ? (
            <div className="mt-3 rounded-2xl bg-black/20 px-3 py-3 text-xs leading-6 text-white/80">
              1. 用 Safari 開啟本系統
              <br />
              2. 按瀏覽器的分享按鈕
              <br />
              3. 選「加入主畫面」
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="mt-1 text-white/70">如果瀏覽器沒有彈出自動安裝視窗，也可以用瀏覽器選單中的「安裝應用程式」或「加入主畫面」。</div>
          {showManualHelp ? (
            <div className="mt-3 rounded-2xl bg-black/20 px-3 py-3 text-xs leading-6 text-white/80">
              1. 打開瀏覽器右上角選單
              <br />
              2. 找「安裝應用程式」或「加入主畫面」
              <br />
              3. 確認安裝
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
