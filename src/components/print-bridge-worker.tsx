"use client";

import { useEffect, useState } from "react";

import { fetchPrintBridgeHealth, getPrintBridgeUrl, PrintBridgeHealth, syncPrintBridgeConfig } from "@/lib/print-bridge/client";
import { flushPendingPrintJobs } from "@/lib/print-bridge/dispatch";
import { loadDeviceConfig } from "@/lib/storage";

const FLUSH_INTERVAL_MS = 2500;
const HEALTH_INTERVAL_MS = 15000;
const CONFIG_SYNC_INTERVAL_MS = 60000;

export function PrintBridgeWorker() {
  const [health, setHealth] = useState<PrintBridgeHealth | null>(null);
  const [bridgeUrl, setBridgeUrl] = useState<string | null>(() =>
    typeof window === "undefined" ? null : getPrintBridgeUrl(),
  );

  useEffect(() => {
    function refreshBridgeUrl() {
      setBridgeUrl(getPrintBridgeUrl());
    }

    window.addEventListener("pos-device-config-changed", refreshBridgeUrl as EventListener);
    return () => window.removeEventListener("pos-device-config-changed", refreshBridgeUrl as EventListener);
  }, []);

  useEffect(() => {
    if (!bridgeUrl) return;

    let cancelled = false;
    let bridgeOnline = false;
    let lastConfigSyncAt = 0;

    async function syncConfig(force = false) {
      const now = Date.now();
      if (!force && now - lastConfigSyncAt < CONFIG_SYNC_INTERVAL_MS) return;
      const deviceConfig = loadDeviceConfig();
      if (!deviceConfig) return;
      const ok = await syncPrintBridgeConfig(deviceConfig);
      if (ok) lastConfigSyncAt = now;
    }

    async function pollHealth() {
      const result = await fetchPrintBridgeHealth();
      if (!cancelled) {
        setHealth(result);
        bridgeOnline = result.ok;
      }
    }

    async function tick() {
      if (!bridgeOnline) return;
      await syncConfig();
      await flushPendingPrintJobs();
    }

    void syncConfig(true);
    void pollHealth().then(() => {
      if (!cancelled && bridgeOnline) void flushPendingPrintJobs();
    });

    const tickTimer = window.setInterval(() => {
      void tick();
    }, FLUSH_INTERVAL_MS);

    const healthTimer = window.setInterval(() => {
      void pollHealth();
    }, HEALTH_INTERVAL_MS);

    function onDeviceConfigSaved() {
      void syncConfig(true);
    }

    window.addEventListener("pos-device-config-changed", onDeviceConfigSaved as EventListener);

    return () => {
      cancelled = true;
      window.clearInterval(tickTimer);
      window.clearInterval(healthTimer);
      window.removeEventListener("pos-device-config-changed", onDeviceConfigSaved as EventListener);
    };
  }, [bridgeUrl]);

  useEffect(() => {
    if (!bridgeUrl || !health) return;
    window.dispatchEvent(new CustomEvent("pos-print-bridge-health", { detail: { health } }));
  }, [bridgeUrl, health]);

  return null;
}

export function usePrintBridgeHealth() {
  const [health, setHealth] = useState<PrintBridgeHealth | null>(null);
  const [bridgeUrl, setBridgeUrl] = useState<string | null>(() =>
    typeof window === "undefined" ? null : getPrintBridgeUrl(),
  );

  useEffect(() => {
    function refreshBridgeUrl() {
      setBridgeUrl(getPrintBridgeUrl());
    }

    window.addEventListener("pos-device-config-changed", refreshBridgeUrl as EventListener);
    return () => window.removeEventListener("pos-device-config-changed", refreshBridgeUrl as EventListener);
  }, []);

  useEffect(() => {
    if (!bridgeUrl) return;

    function onHealth(event: Event) {
      const detail = (event as CustomEvent<{ health?: PrintBridgeHealth }>).detail;
      if (detail?.health) setHealth(detail.health);
    }

    window.addEventListener("pos-print-bridge-health", onHealth as EventListener);
    void fetchPrintBridgeHealth().then(setHealth);

    return () => window.removeEventListener("pos-print-bridge-health", onHealth as EventListener);
  }, [bridgeUrl]);

  return health;
}
