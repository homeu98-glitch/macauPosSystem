"use client";

import { useEffect, useState } from "react";

export const NETWORK_STATUS_EVENT = "pos-network-status-changed";

export function readNetworkOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

function broadcastNetworkStatus(online: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NETWORK_STATUS_EVENT, { detail: { online } }));
}

/** 訂閱瀏覽器 online/offline，自動反映網絡狀態（不可手動切換）。 */
export function useNetworkOnline(): boolean {
  const [online, setOnline] = useState(() => readNetworkOnline());

  useEffect(() => {
    function sync() {
      const next = readNetworkOnline();
      setOnline((prev) => {
        if (prev !== next) broadcastNetworkStatus(next);
        return next;
      });
    }

    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    sync();

    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  return online;
}

export function useNetworkOnlineListener(onChange: (online: boolean) => void) {
  useEffect(() => {
    function handle(event: Event) {
      const detail = (event as CustomEvent<{ online?: boolean }>).detail;
      if (typeof detail?.online === "boolean") {
        onChange(detail.online);
        return;
      }
      onChange(readNetworkOnline());
    }

    window.addEventListener(NETWORK_STATUS_EVENT, handle as EventListener);
    window.addEventListener("online", handle);
    window.addEventListener("offline", handle);

    return () => {
      window.removeEventListener(NETWORK_STATUS_EVENT, handle as EventListener);
      window.removeEventListener("online", handle);
      window.removeEventListener("offline", handle);
    };
  }, [onChange]);
}
