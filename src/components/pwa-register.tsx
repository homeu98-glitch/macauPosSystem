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

    void navigator.serviceWorker.register("/sw.js");

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
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return null;
}
