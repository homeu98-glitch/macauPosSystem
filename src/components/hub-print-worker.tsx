"use client";

import { useEffect } from "react";

import { flushPendingPrintJobs } from "@/lib/print-bridge/dispatch";
import { isHubConfigured } from "@/lib/print-bridge/hub";

const FLUSH_INTERVAL_MS = 2500;

/**
 * 背景打印 worker（Hub-only）。
 *
 * 定時把 pending PrintJob 經 Printer Hub（Sunmi APK HTTP :8787）派發到 LAN 打印機。
 * 唔使再同步 config 到 HTTP bridge / native bridge（已按用戶指示移除）。
 * 未配對 Hub 嘅 job 會一直留在 pending，等店主喺設置頁配對。
 */
export function HubPrintWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      if (!isHubConfigured()) return; // 未配對 Hub：唔使 poll
      await flushPendingPrintJobs();
    }

    void tick();

    const timer = window.setInterval(() => {
      void tick();
    }, FLUSH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
