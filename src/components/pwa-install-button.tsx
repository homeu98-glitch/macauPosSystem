"use client";

import { useEffect, useState } from "react";

type DeferredPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

declare global {
  interface Window {
    __pwaDeferredPrompt?: DeferredPrompt | null;
  }
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

  if (available) {
    return (
      <button
        className="mt-3 w-full rounded-2xl border border-white/20 bg-white/10 px-4 py-3 text-sm font-semibold text-white hover:bg-white/15 disabled:opacity-60"
        disabled={installing}
        onClick={() => {
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
        }}
        type="button"
      >
        {installing ? "安裝中…" : "安裝到主頁"}
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-left text-sm text-white/85">
      <div className="font-semibold text-white">PWA 安裝</div>
      {isIosLike ? (
        <>
          <div className="mt-1 text-white/70">iPad / iPhone 的 Safari 不會顯示自動安裝按鈕，請用手動加入主畫面。</div>
          <button
            className="mt-3 rounded-2xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
            onClick={() => setShowManualHelp((current) => !current)}
            type="button"
          >
            {showManualHelp ? "收起說明" : "查看加入主畫面方法"}
          </button>
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
        <div className="mt-1 text-white/70">如果未見自動安裝按鈕，請用瀏覽器選單中的「安裝應用程式」或「加入主畫面」。</div>
      )}
    </div>
  );
}
