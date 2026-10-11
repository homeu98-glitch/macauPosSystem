"use client";

import { useEffect } from "react";

type DeferredPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

declare global {
  interface Window {
    __pwaDeferredPrompt?: DeferredPrompt | null;
  }
}

export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // 🔴 2026-10-11：把 build id 帶入 SW URL，令每次 deploy 都產生新 CACHE_NAME
    //    → 舊快取喺 `activate` 一定被清（之前寫死版本號，7-31 之後從冇換過）。
    //    `sw.js` 係 static 資產，用 cache-busting query 係 Next/Vercel 標準做法。
    const buildId = process.env.NEXT_PUBLIC_BUILD_ID || "dev";
    void navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(buildId)}`);

    // 定期問瀏覽器有冇新 SW 並激活 → PWA 唔會長期抱住舊版本。
    // iOS PWA 由 home screen 啟動、可以係同一個 webview 存活好耐，所以要主動檢查。
    let stopped = false;
    const checkTimer = window.setInterval(() => {
      if (stopped) return;
      void navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.update())
        .catch(() => {});
    }, 30 * 60 * 1000);

    // 由背景返嚟就即刻查一次。
    const onVisible = () => {
      if (stopped || document.visibilityState !== "visible") return;
      void navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.update())
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);

    function onBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      window.__pwaDeferredPrompt = event as DeferredPrompt;
      window.dispatchEvent(new CustomEvent("pwa-install-available", { detail: { available: true } }));
    }

    function onInstalled() {
      window.__pwaDeferredPrompt = null;
      window.dispatchEvent(new CustomEvent("pwa-install-available", { detail: { available: false } }));
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      stopped = true;
      window.clearInterval(checkTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return null;
}
