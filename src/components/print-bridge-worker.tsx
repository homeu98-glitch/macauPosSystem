"use client";

import { useEffect, useState } from "react";

import { fetchPrintBridgeHealth, isPrintBridgeEnabled, PrintBridgeHealth, syncPrintBridgeConfig } from "@/lib/print-bridge/client";
import { flushPendingPrintJobs } from "@/lib/print-bridge/dispatch";
import { loadDeviceConfig } from "@/lib/storage";

const FLUSH_INTERVAL_MS = 2500;
const HEALTH_INTERVAL_MS = 15000;

export function PrintBridgeWorker() {
  const [health, setHealth] = useState<PrintBridgeHealth | null>(null);

  useEffect(() => {
    if (!isPrintBridgeEnabled()) return;

    let cancelled = false;

    async function syncConfig() {
      const deviceConfig = loadDeviceConfig();
      if (deviceConfig) {
        await syncPrintBridgeConfig(deviceConfig);
      }
    }

    async function pollHealth() {
      const result = await fetchPrintBridgeHealth();
      if (!cancelled) setHealth(result);
    }

    void syncConfig();
    void pollHealth();
    void flushPendingPrintJobs();

    const flushTimer = window.setInterval(() => {
      void flushPendingPrintJobs();
    }, FLUSH_INTERVAL_MS);

    const healthTimer = window.setInterval(() => {
      void pollHealth();
    }, HEALTH_INTERVAL_MS);

    function onDeviceConfigSaved() {
      void syncConfig();
    }

    window.addEventListener("pos-device-config-changed", onDeviceConfigSaved as EventListener);

    return () => {
      cancelled = true;
      window.clearInterval(flushTimer);
      window.clearInterval(healthTimer);
      window.removeEventListener("pos-device-config-changed", onDeviceConfigSaved as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!isPrintBridgeEnabled() || !health) return;
    window.dispatchEvent(new CustomEvent("pos-print-bridge-health", { detail: { health } }));
  }, [health]);

  return null;
}

export function usePrintBridgeHealth() {
  const [health, setHealth] = useState<PrintBridgeHealth | null>(null);

  useEffect(() => {
    if (!isPrintBridgeEnabled()) return;

    function onHealth(event: Event) {
      const detail = (event as CustomEvent<{ health?: PrintBridgeHealth }>).detail;
      if (detail?.health) setHealth(detail.health);
    }

    window.addEventListener("pos-print-bridge-health", onHealth as EventListener);
    void fetchPrintBridgeHealth().then(setHealth);

    return () => window.removeEventListener("pos-print-bridge-health", onHealth as EventListener);
  }, []);

  return health;
}
