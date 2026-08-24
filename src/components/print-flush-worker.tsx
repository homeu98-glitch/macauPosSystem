"use client";

import { useEffect } from "react";

import { flushPendingPrintJobs } from "@/lib/print-bridge/dispatch";
import { tryAutoPairCompanion } from "@/lib/print-bridge/companion";

const FLUSH_INTERVAL_MS = 2500;

/**
 * 背景打印 worker（取代舊 HubPrintWorker）。
 *
 * 定時：
 *   1) 嘗試自動配對 / 重連桌面 Companion 代理（loopback http://127.0.0.1:9311）；
 *   2) 刷新 pending PrintJob 派發到打印機：native bridge（Android APK）優先，
 *      否則 fallback 桌面 Companion 代理（LAN :9100 / USB / 藍牙）。
 *
 * 經 root layout 全域掛載，餐飲同 salon 共用，唔使各自再配對。
 */
export function PrintFlushWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      try {
        await tryAutoPairCompanion();
      } catch {
        // 配對失敗唔阻礙 flush
      }
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
