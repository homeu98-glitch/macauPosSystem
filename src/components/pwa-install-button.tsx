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
  const [available, setAvailable] = useState(
    () => typeof window !== "undefined" && Boolean(window.__pwaDeferredPrompt),
  );
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    function onAvailable(event: Event) {
      const detail = (event as CustomEvent<{ available?: boolean }>).detail;
      setAvailable(Boolean(detail?.available));
    }

    window.addEventListener("pwa-install-available", onAvailable as EventListener);
    return () => window.removeEventListener("pwa-install-available", onAvailable as EventListener);
  }, []);

  if (!available) return null;

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
