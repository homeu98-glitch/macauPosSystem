"use client";

import { useEffect, useState } from "react";

import { fetchPrintBridgeHealth, getPrintBridgeUrl, PrintBridgeHealth, syncPrintBridgeConfig } from "@/lib/print-bridge/client";
import { isNativeBridgeAvailable } from "@/lib/print-bridge/native";
import { flushPendingPrintJobs } from "@/lib/print-bridge/dispatch";
import { isWebUsbSupported } from "@/lib/print-webusb";
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
    if (!bridgeUrl && !isWebUsbSupported() && !isNativeBridgeAvailable()) return;

    let cancelled = false;
    let bridgeOnline = false;
    let lastConfigSyncAt = 0;

    async function syncConfig(force = false) {
      if (isNativeBridgeAvailable()) return; // native 唔使 sync config 到 HTTP bridge
      const now = Date.now();
      if (!force && now - lastConfigSyncAt < CONFIG_SYNC_INTERVAL_MS) return;
      const deviceConfig = loadDeviceConfig();
      if (!deviceConfig) return;
      const ok = await syncPrintBridgeConfig(deviceConfig);
      if (ok) lastConfigSyncAt = now;
    }

    async function pollHealth() {
      if (!bridgeUrl) return;
      // Native bridge 唔使 HTTP health check（window.PosNative 已注入）
      if (isNativeBridgeAvailable()) return;
      const result = await fetchPrintBridgeHealth();
      if (!cancelled) {
        setHealth(result);
        bridgeOnline = result.ok;
      }
    }

    async function tick() {
      // flush 內部按 transport 分流（bridge / webusb），webusb 唔使等 bridge 上線
      await flushPendingPrintJobs();
      if (bridgeOnline) await syncConfig();
    }

    void syncConfig(true);
    void pollHealth();
    void flushPendingPrintJobs();

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
